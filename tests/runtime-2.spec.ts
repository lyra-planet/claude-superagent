/**
 * Upstream's tests/runtime.spec.ts from its first case after line 900 to its end, on the stand-in Claude Code
 * (tests/fixtures/claude.ts). The test plays the model: it ends a worker's turn where upstream emitted DSH's agent/status.
 *
 * Left out, as they test DSH-only mechanics:
 * - 'reads the main Session's preset from a registry with or without presetForSession, and takes standard's caps when it
 *   cannot': DSH's preset registry and session projections; the router here has no shell whose waits a preset caps.
 * - 'creates an Executor Session under the bundle's worker preset, and the main Session under its router preset': DSH agent
 *   presets; a Claude Code Session is made with its options, which the cases below check.
 * - 'selects its own preset again for a main Session or worker a person switched before its first turn, and not after it':
 *   DSH's preset registry and the selection its Web UI announces.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { masterPrompt } from '../src/app/context.ts'
import { Runtime } from '../src/app/runtime.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { overview } from '../src/app/views/overview.ts'
import { executorLoad, ticketList } from '../src/app/views/tickets.ts'
import { key, runningAssignment, waitsForPerson, type Trigger } from '../src/core/index.ts'
import type { Machine } from '../src/deployment.ts'
import { mandateInstructions } from '../src/executor/common.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { IM_WORDS } from '../src/infra/text.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../src/policy.ts'
import { feishuSource } from '../src/sources/feishu.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { githubSource } from '../src/sources/github.ts'
import { observePull } from '../src/sources/github-pull.ts'
import { commentTrigger, githubChannel } from '../src/sources/github-trigger.ts'
import type { SourcePlugin } from '../src/sources/kind.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
/** The Runtime the case runs: the fixture's, or the one the last `restart` started. */
let runtime: Runtime
/** Answers of commands that differ from the fixture's, by argv; an Error makes the command fail with its message. */
let answers: Record<string, string | Error>
const AGENT = () => join(h.directory, 'agent-gh')
const OTHER = () => join(h.directory, 'other-gh')
const BOT = () => join(h.directory, 'lark-bot')
const HELPERS = 'git config -z --show-origin --get-all credential.https://github.com.helper'
const worktreeName = 'fix-regression'
const quietly = (kind: SourcePlugin['kind']): SourcePlugin => ({ kind, run: async () => {} })
/** The fixture's Sources: GitHub and Feishu without their loops, and the terminal. */
const withSources = (local: SourcePlugin): SourcePlugin[] => [quietly(githubSource.kind), quietly(feishuSource.kind), local]
const settle = async (target = runtime) => { await target.idle(); await new Promise(resolve => setImmediate(resolve)) }

/** Source account overrides for a restart; `feishu: null` disables the Feishu source. */
interface Accounts { github?: Record<string, unknown>; feishu?: Record<string, unknown> | null }
function seed(store: Store, accounts: Accounts = {}): void {
  const settings = store.settings()
  const { feishu: _feishu, ...others } = settings.sources
  const feishu = accounts.feishu === null ? undefined : { ...settings.sources.feishu?.config, cli: BOT(), ...accounts.feishu }
  store.saveSettings(SettingsSchema.parse({ ...settings, sources: { ...others, github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT(), ...accounts.github } },
    ...feishu ? { feishu: { enabled: true, config: feishu } } : {} } }))
}
const create = (machine: Partial<Machine> = {}, plugins = withSources) => new Runtime(testMachine({ stateDir: h.directory, claudeConfigDir: join(h.directory, 'claude'), ...machine }),
  { logger: h.logger, restart: h.restart, subprocess: h.subprocess, sdk: h.claude.sdk, listen: false, plugins })
/** Stop the Runtime and start another on the same state directory and stand-in Claude Code, as a process restart does. */
async function restart(machine: Partial<Machine> = {}, accounts: Accounts = {}, plugins = withSources): Promise<Runtime> {
  await runtime.stop()
  const store = new Store(join(h.directory, 'orchestrator.sqlite')); seed(store, accounts); store.close()
  runtime = create(machine, plugins)
  await runtime.start()
  return runtime
}

/** What the host pushed to a Session, parsed; notices that start no turn are left out, as upstream injected them apart. */
const relays = (sessionId: string) => h.claude.to(sessionId).filter(message => message.delivery !== 'inject').map(message => {
  try { return JSON.parse(message.text) as Record<string, unknown> } catch { return { text: message.text } as Record<string, unknown> }
})
const runTool = async (ticketId: string | undefined, name: string, args: unknown) => {
  const ticket = ticketId === undefined ? undefined : runtime.store.tickets.get(ticketId)
  const tool = runtime.toolsOf(ticket).find(item => item.name === name)
  if (!tool) throw new Error(`Tool ${name} is not registered for ${ticketId ?? 'the router'}`)
  const output = await tool.execute(tool.schema.parse(args), new AbortController().signal)
  expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output)
  await settle()
  return output as Record<string, unknown>
}
async function receive(trigger: Trigger, target = runtime) {
  const result = target.receive(trigger)
  await settle(target)
  return result
}
async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { results } = await runTool(undefined, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
  if (results[0]!.refused) throw new Error(String(results[0]!.refused))
  return results[0]!
}
async function acceptedTicket(trigger = feishu('1', '@bot 修一下回归')) {
  await receive(trigger)
  expect(relays(runtime.masterId).some(item => item.trigger_id === trigger.id)).toBe(true)
  const result = await route({ kind: 'accept', trigger_id: trigger.id, title: '修复回归', worktree_name: worktreeName, acknowledgement: '收到，修复回归。' })
  const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
  return { trigger, ticket, sessionId: runtime.sessions.worker(ticket.id)?.id ?? '' }
}
/** A request to the management API, as the panel makes it; a body that is not JSON comes back as its text. */
async function api(method: string, path: string, json?: unknown) {
  let status = 0, text = ''
  const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
  const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
  await runtime.handle(req as never, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data }, headersSent: false } as never)
  let body: Record<string, unknown>
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { text } }
  return { status, body }
}
const viewsOf = (value: Runtime) => ({ store: value.store, sources: value.sources, links: value.links() })
const overviewOf = (value: Runtime) => overview(viewsOf(value), value.health, policyVersion(value.store.settings()),
  executorLoad(value.store, value.executor.activeCount()), value.setupProblem ?? value.feishuProblem)
/** The options the latest query of a Session started with. */
const started = (sessionId: string): Record<string, any> => h.claude.queries.filter(query => query.session.id === sessionId).at(-1)!.options
/** The system prompt a Session's latest query started with: the router's whole, a worker's appended to Claude Code's. */
const promptOf = (sessionId: string): string => { const prompt = started(sessionId).systemPrompt; return typeof prompt === 'string' ? prompt : prompt.append }
/** What the worker's PreToolUse hook answers for a tool call: undefined when it lets it run, else why it is denied. */
async function guard(sessionId: string, call: { name: string; arguments: unknown; agent?: string } = { name: 'Read', arguments: { file_path: 'README.md' } }) {
  const hook = started(sessionId).hooks.PreToolUse[0].hooks[0] as (input: unknown, id: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, any>>
  const output = await hook({ hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: '', cwd: '', tool_name: call.name, tool_input: call.arguments,
    tool_use_id: 'tool-1', ...call.agent ? { agent_id: call.agent, agent_type: 'general-purpose' } : {} }, 'tool-1', { signal: new AbortController().signal })
  return output.hookSpecificOutput?.permissionDecisionReason as string | undefined
}
/** How often the worker's turns were cut short, over all its queries. */
const interrupts = (sessionId: string) => h.claude.queries.filter(query => query.session.id === sessionId).reduce((count, query) => count + query.interrupt.mock.calls.length, 0)
/**
 * The test plays the worker's model to the end of its work: its turn ends, and so does each one a message still queued in its
 * query starts, until its Session is idle.
 */
async function endTurns(sessionId: string): Promise<void> {
  const session = h.claude.session(sessionId)
  for (let turns = 0; session.status === 'running'; turns++) {
    if (turns === 10) throw new Error(`The Session ${sessionId} keeps running`)
    session.end(); await settle()
  }
}
/** The commands run as `sh -c`: prepare commands, with where and with what they ran. */
const shells = () => h.subprocess.run.mock.calls.map(call => call as unknown as [string[], { cwd: string; env?: Record<string, string> }])
  .filter(([argv]) => argv[0] === 'sh').map(([argv, options]) => ({ argv, cwd: options.cwd, env: options.env }))

beforeEach(async () => {
  h = await startRuntime()
  runtime = h.runtime
  writeFileSync(OTHER(), '#!/bin/sh\n', { mode: 0o755 })
  answers = {
    [`${OTHER()} api user`]: '{"login":"agent-bot","id":7}',
    [`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
  }
  const fixture = h.subprocess.run.getMockImplementation()!
  h.subprocess.run.mockImplementation(async (command: string[]) => {
    const argv = [...command]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const answer = answers[argv.join(' ')]
    if (answer === undefined) return fixture(command)
    return answer instanceof Error ? { exitCode: 1, stdout: '', stderr: answer.message } : { exitCode: 0, stdout: answer, stderr: '' }
  })
  // As upstream's beforeEach: a PR is open, by the agent, from the branch of the first ticket.
  vi.mocked(Commands.prototype.gh).mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : args[1]?.includes('/pulls/')
    ? { state: 'open', user: { login: 'agent-bot' }, html_url: 'https://github.com/acme/widgets/pull/' + args[1].split('/').at(-1),
      head: { ref: `agent/${String(runtime.store.tickets.list()[0]?.execution?.name)}`, sha: 'head-1', repo: { full_name: 'acme/widgets' } } }
    : { default_branch: 'master', permissions: { push: true } })
})
afterEach(async () => { await runtime.stop(); await h.stop() })

it('checks a changed account CLI before saving it, restarts after the save, and lets only the panel change it', async () => {
  const save = (config: Record<string, unknown>, origin: SettingsOrigin = 'panel') => runtime.settings.save('source:github',
    { enabled: true, config: { ...runtime.store.settings().sources.github!.config, ...config } }, runtime.store.blockRevision('source:github'), origin)
  await expect(save({ cli: OTHER() }, 'tool')).rejects.toThrow('can only be changed in the management panel')
  answers[`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":false}\n'
  await expect(save({ cli: OTHER() })).rejects.toMatchObject({ code: 'repositoryReadOnly', values: { account: 'agent-bot' } })
  expect(h.restart).not.toHaveBeenCalled()
  answers[`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":true}\n'
  expect(await save({ cli: OTHER() })).toMatchObject({ saved: true, restarting: true })
  await vi.waitFor(() => expect(h.restart).toHaveBeenCalledTimes(1))
  // Other fields of the Source take effect without a restart.
  expect(await save({ pollSeconds: 120 })).toMatchObject({ saved: true, restarting: false })
  expect(h.restart).toHaveBeenCalledTimes(1)
  expect((await runtime.settings.save('executor', { ...runtime.store.settings().executor, prepare: 'true' }, runtime.store.blockRevision('executor'), 'panel')).restarting).toBe(false)
  // A save of another block during the account check is kept: the check runs first, then the save merges.
  const pending = save({ cli: AGENT() })
  await runtime.settings.save('policy', { ...runtime.store.settings().policy, rules: [] }, runtime.store.blockRevision('policy'), 'panel')
  await pending
  expect(runtime.store.settings().policy.rules).toEqual([])
  expect(runtime.store.settings().sources.github!.config).toMatchObject({ cli: AGENT() })
  const feishuSave = (cli: string) => runtime.settings.save('source:feishu', { enabled: true, config: { ...runtime.store.settings().sources.feishu!.config, cli } },
    runtime.store.blockRevision('source:feishu'), 'panel')
  expect(await feishuSave('')).toMatchObject({ restarting: true })
  answers[`${BOT()} config strict-mode`] = 'strict-mode: off (source: profile)'
  await expect(feishuSave(BOT())).rejects.toMatchObject({ code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it('lists Tickets that wait on a person with where to answer them, as the overview does', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: '按钮用哪种颜色？' })
  expect(ticketList(viewsOf(runtime), 'person', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'person', reply: expect.objectContaining({ source: 'feishu' }) })])
})

it('pauses and resumes processing as its own action, a setting outside every block, which keeps an Executor settings draft valid', async () => {
  const revision = runtime.store.blockRevision('executor')
  expect(await runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  expect(runtime.store.settings().paused).toBe(true)
  expect(runtime.store.blockRevision('executor')).toBe(revision)
  // A draft of the Executor settings started before the pause still saves, and keeps the pause; the executor block has no pause.
  const draft = runtime.store.settings().executor
  await expect(runtime.settings.save('executor', { ...draft, paused: false }, revision, 'panel')).rejects.toThrow('paused')
  await runtime.settings.save('executor', { ...draft, maxWorkers: 5 }, revision, 'panel')
  expect(runtime.store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  // The orchestrator pauses and resumes the same way, through the settings tool's pause block.
  await runTool(undefined, 'orchestrator_settings_save', { block: 'pause', value: { paused: false }, revision: 0 })
  expect(runtime.store.settings().paused).toBe(false)
})

it('runs setup again while the Feishu bot check failed, and restores the process environment when git fails its check', async () => {
  answers[`${BOT()} config strict-mode`] = 'strict-mode: off (source: profile)'
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(next.feishuProblem?.code).toBe('feishuUserIdentity')
  // Adapted: the Runtime's setup checks again, which upstream's Runtime offered as checkSetup.
  next.setup.check()
  await vi.waitFor(() => expect(h.restart).toHaveBeenCalledTimes(1))
  answers[HELPERS] = 'file:/home/me/.gitconfig\0!gh auth git-credential\0'
  const broken = await restart()
  await broken.ready
  expect(broken.setupProblem).toMatchObject({ place: 'deployment', code: 'gitTooOld' })
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(':')).not.toContain(join(h.directory, 'worker-bin'))
})

it('writes worker shims and the agent environment from the configuration only, and restores the environment on stop', async () => {
  const bin = join(h.directory, 'worker-bin')
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli'])
  expect(readFileSync(join(bin, 'lark-cli'), 'utf8')).toContain(`exec '${BOT()}'`)
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, blockedCommands: ['personal-gh'] } })
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
  expect(readFileSync(join(bin, 'personal-gh'), 'utf8')).toContain('personal-gh is blocked in this installation; use gh, which acts as agent-bot.')
  expect(readFileSync(join(bin, 'lark-cli'), 'utf8')).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
  expect(readFileSync(join(bin, 'gh'), 'utf8')).toContain(`exec '${AGENT()}'`)
  expect(readFileSync(workerGitConfig(h.directory), 'utf8')).toContain(`[credential "https://github.com"]\n\thelper = "${credentialHelper(AGENT())}"`)
  expect(process.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(h.directory), GIT_CONFIG_NOSYSTEM: '1' })
  expect(process.env.GIT_AUTHOR_NAME).toBeUndefined()
  expect(process.env.PATH?.split(':')[0]).toBe(bin)
  await next.stop()
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(':')).not.toContain(bin)
})

it('waits for setup when the shim directory holds a file dsh-superagent did not write, and leaves the file alone', async () => {
  writeFileSync(join(h.directory, 'worker-bin', 'my-script'), '#!/bin/sh\n')
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(false)
  expect(next.setupProblem).toMatchObject({ place: 'deployment', code: 'foreignFile', values: { file: join(h.directory, 'worker-bin', 'my-script') } })
  expect(readFileSync(join(h.directory, 'worker-bin', 'my-script'), 'utf8')).toBe('#!/bin/sh\n')
  await next.stop()
})

it('rewrites the blocked-command shims when the Executor settings change them, without a restart', async () => {
  const bin = join(h.directory, 'worker-bin')
  const save = (blockedCommands: string[]) => runtime.settings.save('executor', { ...runtime.store.settings().executor, blockedCommands }, runtime.store.blockRevision('executor'), 'panel')
  expect(await save(['personal-gh'])).toMatchObject({ saved: true, restarting: false })
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli', 'personal-gh'])
  await save([])
  expect(readdirSync(bin).sort()).toEqual(['gh', 'lark-cli'])
  // The commands workers need cannot be blocked.
  await expect(save(['gh'])).rejects.toThrow()
  expect(h.restart).not.toHaveBeenCalled()
})

it('tells both roles the execution environment through a generated prompt section, and each worker its own ticket\'s', async () => {
  const preview = runtime.prompts.preview(runtime.prompts.current().config)
  const section = preview.parts.worker.at(-1)!
  expect(section.name).toBe('runtime/environment')
  for (const line of ['- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets"', '- DSH_SUPERAGENT_GITHUB_ACCOUNT = "agent-bot"', '- DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL = "7+agent-bot@users.noreply.github.com"']) expect(section.text).toContain(line)
  expect(section.text).not.toContain('MERGE_ACCOUNT')
  // Outside a ticket there is no ticket directory.
  expect(section.text).not.toContain('DSH_SUPERAGENT_DIR')
  // The main Session's Policy section follows it.
  expect(preview.orchestrator).toContain(`${section.text}\n\n## Policy`)
  const { ticket, sessionId } = await acceptedTicket()
  // Adapted: a Session's prompt is the system prompt its query starts with, where upstream registered a DSH prompt section.
  expect(promptOf(sessionId)).toContain(`- DSH_SUPERAGENT_DIR = ${JSON.stringify(ticket.execution!.directory)}`)
  expect(promptOf(runtime.masterId)).not.toContain('DSH_SUPERAGENT_DIR')
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(Object.keys(next.prompts.preview(next.prompts.current().config).skills)).not.toContain('feishu')
})

it('lets a worker read the prompt version it works under and the ones it worked under before, also after a restart, and no other', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const save = () => { const { config, revision } = runtime.prompts.current(); return runtime.prompts.save({ ...config, delivery: `${config.delivery}.` }, revision, 'panel').revision }
  // Adapted: a Session reads its system prompt as its query starts, which binds it to the version current then; upstream's DSH
  // read it at each model request.
  const request = async () => { const session = runtime.sessions.worker(ticket.id)!; await session.close(); await session.openSession() }
  const read = (resource: string) => runTool(ticket.id, 'orchestrator_read', { resource })
  const first = save(), second = save()
  await request()
  await expect(read(`prompts/${first}`)).rejects.toThrow('inaccessible prompt version')
  const third = save()
  // Until its next request it works under the version it read; after it, it may still read that one.
  expect(await read('prompts/current')).toMatchObject({ resource: `prompts/${second}` })
  await request()
  expect(await read('prompts/current')).toMatchObject({ resource: `prompts/${third}` })
  expect(await read(`prompts/${second}`)).toMatchObject({ resource: `prompts/${second}` })
  expect(runtime.sessions.status().sessions).toContainEqual({ sessionId, revision: third })
  const next = await restart()
  await next.ready
  expect([next.sessions.promptVersion(sessionId).revision, next.sessions.mayRead(sessionId, second), next.sessions.mayRead(sessionId, first)])
    .toEqual([third, true, false])
})

it('passes team text with template braces to every Session literally, without reading them as prompt variables', async () => {
  const delivery = 'Pin the build to ${{ github.sha }}; keep {{x}} as written.'
  const current = runtime.prompts.current()
  runtime.prompts.save({ ...current.config, delivery }, current.revision, 'panel')
  const { sessionId } = await acceptedTicket()
  // Adapted: Claude Code takes the system prompt as text, so each Session's holds the team's text as written; upstream rendered
  // each DSH prompt section as DSH does.
  for (const id of [runtime.masterId, sessionId]) expect(promptOf(id)).toContain(delivery)
})

it('leaves auto-merge to the delivery requirements, with the agent\'s own gh and the line threshold', async () => {
  const { ticket } = await acceptedTicket()
  expect(runtime.ticketEnvironment(ticket).map(variable => variable.key)).not.toContain('DSH_SUPERAGENT_GITHUB_MERGE_ACCOUNT')
  expect(ticket.mandate).not.toHaveProperty('autoMergeLineLimit')
  const delivery = runtime.prompts.current().config.delivery
  expect(delivery).toContain('it changes fewer than 200 lines (additions plus deletions);')
  // Auto-merge is never enabled as the agent account; only a merge CLI the section names enables it.
  expect(delivery).toContain('Never enable auto-merge as the agent account')
  expect(delivery).toContain('<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha>')
  expect(runtime.prompts.preview(runtime.prompts.current().config).worker).not.toContain('gh-merge')
})

it('runs the prepare command once for a new ticket, under the execution root with the ticket\'s environment, and fails the ticket with its output', async () => {
  const prepare = (command: string) => runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, prepare: command } })
  prepare('git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"')
  const { ticket } = await acceptedTicket()
  // Adapted: commands run through the host's SubprocessRuntime.run(argv, { cwd, env }), where upstream's ran through DSH's spawn.
  expect(shells()).toEqual([expect.objectContaining({ argv: ['sh', '-c', 'git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"'], cwd: join(h.directory, 'work'),
    env: expect.objectContaining({ DSH_SUPERAGENT_DIR: ticket.execution!.directory, DSH_SUPERAGENT_NAME: ticket.execution!.name, DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_FEISHU_CHAT: CHAT }) })])
  // A retry reuses the prepared directory.
  await runTool(ticket.id, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  await runtime.engine.retryTicket(ticket.id)
  await settle()
  expect(shells()).toHaveLength(1)
  answers['sh -c exit 3'] = new Error('fatal: no such clone')
  prepare('exit 3')
  const failed = await acceptedTicket(feishu('9', '@bot 修一下标题'))
  await settle()
  expect(runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)).toMatchObject({ report: expect.objectContaining({ state: 'failed', summary: expect.stringContaining('The prepare command failed: fatal: no such clone') }) })
  expect(waitsForPerson(runtime.store.tickets.get(failed.ticket.id)!)).toBe(true)
})

it('counts a ticket whose directory the host prepared before prepare commands existed as prepared', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  // A ticket from before prepare commands has its worktree.
  const stored = runtime.store.tickets.get(ticket.id)!
  runtime.store.tickets.save({ ...stored, execution: { ...stored.execution!, directory: h.directory } })
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, prepare: 'exit 1' } })
  h.subprocess.run.mockClear()
  await runtime.engine.retryTicket(ticket.id)
  await settle()
  expect(shells()).toEqual([])
  expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.state).toBe('running')
})

it('runs a GitHub-only deployment: the GitHub part of the Policy decides alone, and the Feishu part has nothing to sync', async () => {
  // Adapted: a Runtime registers the Source kinds of its plugins; this one starts with the terminal's only, as upstream's
  // restart registered none, and the case registers GitHub's.
  const next = await restart({}, { feishu: null }, local => [local])
  await next.ready
  expect(next.health).not.toHaveProperty('feishu')
  expect(next.health).not.toHaveProperty('sync:feishu')
  const problems = () => overviewOf(next).problems
  const unregister = next.sources.register(githubSource.kind)
  expect(next.health.github).toEqual({ state: 'starting', detail: '' })
  const policy = next.store.settings().policy
  await next.settings.save('policy', { ...policy, sources: {} }, next.store.blockRevision('policy'), 'panel')
  expect(problems()).toContainEqual({ kind: 'no-allowed' })
  await next.settings.save('policy', { ...policy, sources: { github: { allowed: [{ id: 'bob' }] } } }, next.store.blockRevision('policy'), 'panel')
  expect(next.store.settings().policy.sources).toEqual({ github: { allowed: [{ id: 'bob' }], admission: {} } })
  expect(problems()).not.toContainEqual({ kind: 'no-allowed' })
  await expect(next.settings.save('policy', { ...next.store.settings().policy, sources: { github: { allowed: [{ name: 'Nobody' }] } } }, next.store.blockRevision('policy'), 'panel')).rejects.toThrow()
  await expect(next.settings.sync('feishu')).rejects.toThrow('nothing to sync from')
  unregister()
  expect(next.health).not.toHaveProperty('github')
})

it('credits each human reviewer once in the default delivery requirements on every commit of the PR, never with an empty commit', async () => {
  const delivery = runtime.prompts.current().config.delivery
  expect(delivery).toContain('Co-authored-by: <name or login> <id+login@users.noreply.github.com>')
  expect(delivery).toContain('on every commit of the PR branch')
  expect(delivery).toContain('git filter-branch -f --msg-filter')
  expect(delivery).toContain('Never push an empty commit to credit a reviewer.')
  expect(delivery).toContain('Do not credit bots')
})

/** Send the replies that can go out now; upstream's Runtime.sendReplies is the Outbox's `sent`, which the Runtime here leaves unwrapped. */
const sendReplies = () => runtime.outbox.sent()

it('shows a failed reply as a problem with its attempts, an error of the reply effects after three, until it is withdrawn', async () => {
  const { trigger } = await acceptedTicket()
  vi.spyOn(Commands.prototype, 'lark').mockRejectedValue(new Error('internal error (2200)'))
  runtime.outbox.send({ id: 'stuck', channel: trigger.channel!, text: '已合并。', kind: 'notice' })
  const outgoing = () => overviewOf(runtime).problems.filter(problem => problem.kind === 'outgoing')
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { await sendReplies() } finally { vi.useRealTimers() }
  }
  await sendReplies()
  expect(outgoing()).toEqual([{ kind: 'outgoing', outgoing: expect.objectContaining({ id: 'stuck', attempts: 1, error: expect.stringContaining('2200') }) }])
  expect(runtime.health.reply).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 waiting') })
  // Its retries come after 5 and then 10 more seconds.
  await at(5000); await at(15_000)
  expect(runtime.health.reply).toMatchObject({ state: 'error', detail: expect.stringContaining('2200') })
  expect(runtime.health.runtime).toMatchObject({ state: 'ready' })
  // A withdrawn reply takes its effect with it, which clears the error at once.
  runtime.outbox.withdraw('stuck')
  expect([outgoing(), runtime.health.reply, runtime.effects.pending('reply', 'stuck')])
    .toEqual([[], expect.objectContaining({ state: 'ready', detail: 'Nothing waiting' }), false])
})

describe('the order of a Ticket\'s messages to one conversation', () => {
  const sent: string[] = []
  const refused = new Set<string>()
  const message = (id: string, ticketId: string, channel = feishuChannel(CHAT, 'om_1')) => ({ id, channel, text: id, kind: 'reply' as const, ticketId })
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { await sendReplies() } finally { vi.useRealTimers() }
  }
  beforeEach(async () => {
    sent.length = 0; refused.clear()
    await acceptedTicket()
    vi.spyOn(runtime.sources, 'send').mockImplementation(async message => {
      if (refused.has(message.id)) throw new Error('internal error (2200)')
      sent.push(message.id)
      return 'sent'
    })
  })
  it('sends a Ticket\'s later result after its acknowledgement that failed once, and holds no other Ticket\'s message in the chat', async () => {
    refused.add('ack-a')
    runtime.outbox.send(message('ack-a', 'a'))
    await sendReplies()
    refused.delete('ack-a')
    runtime.outbox.send(message('result-a', 'a'))
    // Another Ticket in the same chat, and the same Ticket in an Issue, are other orders.
    runtime.outbox.send(message('ack-b', 'b', feishuChannel(CHAT, 'om_2')))
    runtime.outbox.send(message('issue-a', 'a', githubChannel(7)))
    await sendReplies()
    expect([runtime.outbox.status('result-a'), sent]).toEqual(['pending', ['ack-b', 'issue-a']])
    await at(5000)
    expect(sent).toEqual(['ack-b', 'issue-a', 'ack-a', 'result-a'])
  })
  it('stops holding a Ticket\'s later messages behind one that failed three times, which the overview shows', async () => {
    refused.add('ack-a')
    runtime.outbox.send(message('ack-a', 'a'))
    await sendReplies()
    runtime.outbox.send(message('result-a', 'a'))
    // Its retries come after 5 and then 10 more seconds; the third failure releases the result.
    await at(5000)
    expect(sent).toEqual([])
    await at(15_000)
    expect(sent).toEqual(['result-a'])
    expect(overviewOf(runtime).problems).toContainEqual({ kind: 'outgoing', outgoing: expect.objectContaining({ id: 'ack-a', attempts: 3 }) })
  })
})

it('keeps the receipt of a message withdrawn while it went out, so its id is not queued again', async () => {
  const { trigger } = await acceptedTicket()
  vi.spyOn(runtime.sources, 'send').mockImplementation(async message => { runtime.outbox.withdraw(message.id); return 'sent' })
  runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Done', kind: 'reply' })
  await sendReplies()
  runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Again', kind: 'reply' })
  expect([runtime.store.receipts.get('raced'), runtime.effects.pending('reply')]).toEqual([expect.objectContaining({ text: 'Done', status: 'sent' }), false])
})

it('resumes several ended tickets on one thread from one message without the launch waiting on itself', async () => {
  const first = await acceptedTicket()
  const other = feishu('30', '@bot 顺手把这里也改了', { root_id: undefined })
  await receive(other)
  await route({ kind: 'attach', ticket_id: first.ticket.id, trigger_id: other.id })
  // A request on the first ticket's thread becomes a second ticket there once the first's worker hands it back.
  const another = feishu('31', '@bot 另一件事', { root_id: 'om_1' })
  await receive(another)
  await runTool(first.ticket.id, 'orchestrator_trigger_handback', { trigger_id: another.id, reason: 'Another change.' })
  const second = await acceptedTicket(another)
  for (const ticket of [first, second]) await runTool(ticket.ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  // Adapted: from Alice, a person on the allowed list, as a guest's message reaches a ticket as context only and resumes nothing
  // (docs/design.md); upstream's guest stood for any person.
  await receive(feishu('32', '还有问题', { mentions: [], root_id: 'om_1', sender_id: MEMBER }))
  await vi.waitFor(() => expect([first, second].map(ticket => runtime.store.tickets.get(ticket.ticket.id)!.ended)).toEqual([undefined, undefined]), { timeout: 3000 })
  await vi.waitFor(() => expect([first, second].map(ticket => runtime.store.tickets.get(ticket.ticket.id)!.assignments.at(-1)!.state)).toEqual(['running', 'running']), { timeout: 3000 })
})

it('attaches a message to an ended ticket and so resumes it', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  const other = feishu('40', '@bot 上次那个改动还要改一下', { root_id: undefined })
  await receive(other)
  await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })
  await vi.waitFor(() => expect(runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined())
  expect(runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
})

it('rereads a Source\'s display names on request, reports the new ones and keeps the list when the read fails', async () => {
  runtime.store.set('source-labels:feishu', { oc_team: 'Team' })
  const lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ chats: [{ chat_id: 'oc_team', name: 'Team' }, { chat_id: 'oc_new', name: 'New chat' }] })
  expect(await runtime.settings.refreshLabels('feishu')).toEqual({ added: ['New chat'] })
  expect(lark).toHaveBeenCalledWith(['im', '+chat-list', '--page-all', '--page-size', '100'])
  expect(runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  lark.mockRejectedValue(new Error('token expired'))
  await expect(runtime.settings.refreshLabels('feishu')).rejects.toThrow('token expired')
  expect(runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  await expect(runtime.settings.refreshLabels('github')).rejects.toThrow('no names to refresh')
})

it('drops a message only when its conversation is gone or not listened to, newest drop first, and keeps it while its Source is off', async () => {
  const channel = feishu('7', 'x').channel!
  // Messages of no Ticket keep no order, so none waits behind another.
  const queue = (id: string, address: Record<string, string>) => { runtime.outbox.send({ id, channel: { ...channel, address }, text: '已合并。', kind: 'notice' }) }
  queue('gone-reply', channel.address)
  queue('failing-reply', { ...channel.address, messageId: 'om_8' })
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
    const replying = args.join(' ')
    if (replying.includes('om_7')) throw new CliError('the message was withdrawn', 230011)
    if (replying.includes('om_9')) return {}
    // Text that names a withdrawal is no answer from Feishu that the conversation is gone.
    throw new Error('Request failed: withdrawn tokens are not recalled messages')
  })
  await sendReplies()
  // The Feishu Channel reads the recall code as gone; any other failure keeps the reply for a retry.
  expect(runtime.store.replyStatus('gone-reply')).toBe('dropped')
  expect(runtime.store.replyStatus('failing-reply')).toBe('pending')
  const settings = runtime.store.settings(), feishuSettings = settings.sources.feishu!
  runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...feishuSettings, enabled: false } } })
  queue('off-reply', { ...channel.address, messageId: 'om_9' })
  queue('ignored-reply', { chatId: 'oc_elsewhere', messageId: 'om_10' })
  await sendReplies()
  expect([runtime.store.replyStatus('off-reply'), runtime.store.replyStatus('ignored-reply')]).toEqual(['pending', 'pending'])
  // Once the Source is on again, the messages that waited go out or are dropped when they are tried again, after 5 seconds.
  runtime.store.saveSettings(settings)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5000 })
  try { await sendReplies() } finally { vi.useRealTimers() }
  expect([runtime.store.replyStatus('off-reply'), runtime.store.replyStatus('ignored-reply')]).toEqual(['sent', 'dropped'])
  const dropped = ((await api('GET', 'sources')).body as unknown as { dropped: { id: string }[] }[]).flatMap(source => source.dropped)
  expect(dropped).toMatchObject([{ id: 'ignored-reply', dropped: { reason: 'channelIgnored' } }, { id: 'gone-reply', dropped: { reason: 'channelGone' } }])
})

it('reports a dropped acknowledgement as dropped, with its Ticket on the Source status and in the last day\'s flow', async () => {
  const { ticket } = await acceptedTicket()
  const followup = feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await receive(followup)
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await runTool(ticket.id, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({ acknowledgement: 'dropped' })
  expect(await runTool(undefined, 'orchestrator_read', { resource: `trigger/${followup.id}` })).toMatchObject({ acknowledgement: 'dropped' })
  const dropped = ((await api('GET', 'sources')).body as unknown as { dropped: unknown[] }[]).flatMap(source => source.dropped)
  expect(dropped).toMatchObject([{ id: key('ack', followup.id), ticket: { id: ticket.id, title: ticket.title } }])
  expect(overviewOf(runtime).flow.dropped).toBe(1)
})

it('refuses a settings save with an unknown model or a Source kind that is not installed, an oversized prompt, an unknown revision and a malformed path with 4xx', async () => {
  // Adapted: a model is checked against the models Claude Code lists, where upstream asked DSH's LLM registry to resolve it.
  const evalBlock = { ...runtime.store.settings().eval, model: { provider: 'nowhere', model: 'x' } }
  expect(await api('PUT', 'settings/eval', { value: evalBlock, revision: runtime.store.blockRevision('eval') }))
    .toMatchObject({ status: 400, body: { code: 'modelUnavailable', values: { block: 'eval', error: 'Claude Code lists no model x: claude-opus-5-5' } } })
  const stored = runtime.store.settings()
  runtime.store.saveSettings({ ...stored, sources: { ...stored.sources, slack: { enabled: false, config: {} } } })
  expect(await api('PUT', 'settings/source:slack', { value: { enabled: true, config: {} }, revision: 0 }))
    .toMatchObject({ status: 400, body: { code: 'sourceNotInstalled', values: { source: 'slack' } } })
  const huge = { ...runtime.prompts.current().config, delivery: 'x'.repeat(runtime.machine.promptMaxChars.get()) }
  expect(await api('POST', 'prompts/preview', huge)).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  expect(await api('PUT', 'prompts', { config: huge, baseRevision: runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  // An override of a part this version does not have is refused, not missing.
  expect(await api('PUT', 'prompts', { config: { ...runtime.prompts.current().config, overrides: { 'runtime/nothing': { text: 'x' } } },
    baseRevision: runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'unknownPromptPart' } })
  expect(await api('GET', 'prompts?revision=99')).toMatchObject({ status: 404, body: { code: 'unknownPromptRevision' } })
  expect(await api('GET', 'threads/%E0%A4%A')).toEqual({ status: 400, body: { error: 'A path segment has a malformed escape' } })
})

it('records a report, the PR it binds and its relay together, or none of them', async () => {
  const { ticket } = await acceptedTicket()
  h.claude.pushed.mockClear()
  const before = runtime.store.tickets.get(ticket.id)!
  // A report the Engine refuses binds no PR, though the PR itself could be bound.
  await expect(runTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'done', pr_number: 42, human_action: 'Ship it?' })).rejects.toThrow()
  // A PR the pull request rules refuse records no report.
  vi.mocked(Commands.prototype.gh).mockImplementation(async args => args[1]?.includes('/pulls/')
    ? { state: 'open', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/7', head: { ref: 'feature/other', sha: 'h', repo: { full_name: 'acme/widgets' } } }
    : { default_branch: 'master', permissions: { push: true } })
  await expect(runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 7, human_action: 'Desktop too?' })).rejects.toThrow()
  const after = runtime.store.tickets.get(ticket.id)!
  expect(after).not.toHaveProperty('follows')
  expect(after).not.toHaveProperty('attention')
  expect(after.assignments).toEqual(before.assignments)
  await settle()
  expect(relays(runtime.masterId)).toEqual([])
})

it('tells the main Session of each requeue of the same Trigger', async () => {
  const stranger = commentTrigger({ id: 4, body: 'still wrong', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/8#issuecomment-4', created_at: '2026-09-09T00:00:00Z' },
    { number: 8, isPr: true, url: 'https://github.com/acme/widgets/pull/8' }, 'conversation', 'agent-bot')
  await receive(stranger)
  // Adapted: the router's notices reach it as messages that start no turn ('inject'), where upstream's went through DSH's inject.
  const requeued = () => h.claude.to(runtime.masterId).filter(message => message.delivery === 'inject' && message.text.includes('trigger_requeued')).length
  expect(runtime.engine.reevaluate(stranger.id)).toBe(true)
  await settle()
  expect(runtime.engine.reevaluate(stranger.id)).toBe(true)
  await settle()
  expect(requeued()).toBe(2)
})

it('keeps replies and acknowledgements to an IM conversation within the IM limit', async () => {
  const { ticket, trigger } = await acceptedTicket()
  const long = Array.from({ length: IM_WORDS + 1 }, () => 'word').join(' ')
  await runTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  await expect(runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: long })).rejects.toThrow(`maximum is ${IM_WORDS}`)
  const follow = feishu('3', '还有一个问题', { mentions: [], root_id: trigger.meta.messageId as string, sender_id: MEMBER })
  await receive(follow)
  await expect(runTool(ticket.id, 'orchestrator_ack', { trigger_id: follow.id, text: long })).rejects.toThrow(`at most ${IM_WORDS} words`)
})

it('refuses a second process on the same state directory before it opens the database, so it migrates nothing', () => {
  // A database the running build would read as schema 10 stays as it is.
  const db = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  expect(() => create()).toThrow(/already being held/)
  expect(runtime.store.get(KV.store.schema)).toBe(10)
  runtime.store.set(KV.store.schema, SCHEMA_VERSION)
})

it('applies a changed prompt size limit to the next save and request without a restart', async () => {
  const limit = reference(100000)
  const next = await restart({ promptMaxChars: limit })
  await next.ready
  const put = (config: unknown) => api('PUT', 'prompts', { config, baseRevision: next.prompts.current().revision })
  const config = next.prompts.current().config
  const size = JSON.stringify(config).length
  expect(await put({ ...config, delivery: 'x'.repeat(size) })).toMatchObject({ status: 200 })
  // The loader commits a lower limit in place; the next save reads it.
  limit.set(size + 1000)
  expect(await put({ ...config, delivery: `${config.delivery}${'y'.repeat(2000)}` }))
    .toMatchObject({ status: 400, body: { code: 'promptTooLong', values: { limit: String(size + 1000) } } })
  // So does the request body limit, four bytes a character and a margin.
  const bytes = 4 * (size + 1000) + 4096
  expect(await put({ ...config, delivery: 'z'.repeat(bytes) })).toMatchObject({ status: 400, body: { error: `Request exceeds ${bytes} bytes` } })
  expect(h.restart).not.toHaveBeenCalled()
})

it('releases the database and the state directory lock when it fails to start, so it can start again in this process', async () => {
  await runtime.stop()
  const db = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='99' WHERE key='schema'").run()
  db.close()
  // Adapted: the Store here names the schema it refuses in its own words.
  expect(() => create()).toThrow('Unsupported database schema 99')
  const fixed = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  fixed.prepare('UPDATE kv SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schema')
  fixed.close()
  // A lock kept by the failed start would make this throw that the lock is already held.
  runtime = create()
  await runtime.start()
  expect(runtime.store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
})

it('tells the conversation that the PR merged when work a restart recovered ends with it later', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })
  // The host restarted with the worker mid-work: its Assignment starts again with a recovery note.
  const before = runtime.store.tickets.get(ticket.id)!
  runtime.engine.assignmentInterrupted(ticket.id, runningAssignment(before)!.id)
  await settle()
  expect(runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
  // The PR merged before the restart; the recovered work goes on, and nothing is said yet.
  const merged = { number: 42, state: 'closed', merged: true, merged_at: before.assignments[0]!.createdAt, html_url: 'https://github.com/acme/widgets/pull/42',
    user: { login: 'agent-bot' }, head: { sha: 'abc', ref: 'agent/x', repo: { full_name: 'acme/widgets' } } }
  await observePull(runtime.context(githubSource.kind), merged as never)
  expect(runtime.store.tickets.get(ticket.id)).not.toHaveProperty('ended')
  const id = key('pr-terminal', '42', 'feishu', JSON.stringify({ chatId: CHAT, messageId: 'om_1' }), 'merged')
  expect(runtime.store.replyStatus(id)).toBeUndefined()
  // Its ready report ends the ticket with the PR, and the conversation hears of the merge once.
  await runTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Recovered and verified' })
  expect(runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'merged' })
  expect(runtime.store.replyStatus(id)).toBeDefined()
  // The report that ended the ticket was the worker's own: its turn is not cancelled inside that tool call.
  // Adapted: a turn is cut short by its query's interrupt(), where upstream's DSH cancelled the agent.
  expect(interrupts(sessionId)).toBe(0)
})

it('restarts a worker that was mid-work when the host stopped with the recovery note, and records no end of its turn', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'halfway' })
  // Stopping cuts the worker's turn short: it ends with an error result, which a stopping host takes as no end.
  // Adapted: the stand-in's interrupt() ends the turn so, where upstream mocked DSH's cancel to emit idle and an AbortError.
  const next = await restart()
  await next.ready
  const recovered = next.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', expect.stringMatching(/^(pending|running)$/)])
  expect(recovered.assignments[0]!.report).toMatchObject({ state: 'progress', summary: 'halfway' })
  expect(recovered.assignments.flatMap(item => item.report ? [item.report.state] : [])).toEqual(['progress'])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
})

it('keeps the report of a blocked, failed or ready worker whose turn ends, and relays nothing more', async () => {
  for (const state of ['blocked', 'failed', 'ready'] as const) {
    const { ticket, sessionId } = await acceptedTicket(feishu(String(20 + ['blocked', 'failed', 'ready'].indexOf(state)), `@bot 修 ${state}`, { root_id: undefined }))
    await runTool(ticket.id, 'orchestrator_report', { state, summary: `${state} report` })
    const relayed = relays(runtime.masterId).length
    // Adapted: the worker's turn ends, which the stand-in reports as Claude Code does, where upstream emitted DSH's agent/status.
    h.claude.session(sessionId).end()
    await settle()
    expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state, summary: `${state} report` })
    expect(relays(runtime.masterId)).toHaveLength(relayed)
  }
})

it('relays the status-request hint when a worker\'s turn ends with no text and no report', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // Adapted: the worker's turn ends with an empty result, where upstream emitted DSH's agent/status idle.
  h.claude.session(sessionId).end()
  await vi.waitFor(() => expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'waiting' }))
  await settle()
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: ticket.id }, state: 'waiting',
    summary: expect.stringContaining('orchestrator_ticket_request_status') })
})

it('fails a ticket at once on a worker error that is not passing, and relays it', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // Adapted: the turn ends with Claude Code's error result, where upstream emitted DSH's agent/error.
  h.claude.session(sessionId).end({ subtype: 'error_during_execution', is_error: true, errors: ['Invalid tool schema'] })
  await vi.waitFor(() => expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('Invalid tool schema') }))
  await settle()
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: ticket.id }, state: 'failed' })
})

it('refuses the main Session a bash command that runs sleep and a long job wait, as reports arrive by themselves, and no worker', async () => {
  const { sessionId } = await acceptedTicket()
  // Adapted: the router has no built-in tool but Skill (docs/design.md, Router): no shell and no job tools, so no command runs
  // and no job wait of any length, where upstream's guard refused sleep and long waits in its bash under each DSH preset.
  const router = started(runtime.masterId)
  expect(router.tools).toEqual(['Skill'])
  expect(router.allowedTools).toEqual(['mcp__superagent__*', 'Skill'])
  expect(router.permissionMode).toBe('dontAsk')
  // A worker waits for its own work as it needs.
  expect(await guard(sessionId, { name: 'Bash', arguments: { command: 'sleep 60', description: 'x' } })).toBeUndefined()
  // The main Session's role says so.
  expect(masterPrompt).toContain('Worker reports, follow_up notices, new candidates and a background job\'s end, with its output, arrive by themselves as messages')
})

it('refuses an ended ticket\'s worker its tools, and restricts the main Session to the tools it may use', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // Adapted: the worker's PreToolUse hook refuses a tool call, where upstream registered a DSH tool guard.
  expect(await guard(sessionId)).toBeUndefined()
  runtime.engine.stopTicket(ticket.id)
  expect(await guard(sessionId)).toMatch(/^Ticket ended; new work needs a new authorized ticket\.?$/)
  // Adapted: the query's options restrict a Session's tools, where upstream restricted DSH's preset tools by name. The router runs
  // no built-in tool but Skill, beside the host's own (upstream: skill, bash, read, read_image and the job tools).
  expect([started(runtime.masterId).tools, started(runtime.masterId).allowedTools]).toEqual([['Skill'], ['mcp__superagent__*', 'Skill']])
  // A worker keeps only the work tools: none that ask a person, plan, change worktrees, schedule or start work outside the
  // worker slots, reach other Sessions or edit documents, whenever they were registered.
  const worker = started(sessionId)
  expect(worker.disallowedTools).toEqual(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete',
    'CronList', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage', 'Workflow', 'Artifact', 'NotebookEdit'])
  expect(worker.allowedTools).toEqual(['mcp__superagent__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Agent', 'Skill'])
})

it('gives an explicit ticket\'s worker a prompt without the limits of an inferred Mandate', async () => {
  const { sessionId } = await acceptedTicket()
  await settle()
  expect(promptOf(sessionId)).not.toContain(mandateInstructions({ strength: 'inferred' }))
})

it('runs a launch that fails for a passing reason again on the launch backoff three times, then fails its ticket; a failed prepare fails at once', async () => {
  const query = h.claude.sdk.query as unknown as Mock<(args: { options: Record<string, any> }) => unknown>
  const original = query.getMockImplementation()!
  const later = async (now: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now })
    try { await runtime.pump(); await settle() } finally { vi.useRealTimers() }
  }
  for (const [index, error] of [Object.assign(new Error('Service Unavailable'), { status: 503 }), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })].entries()) {
    let tries = 0
    // Adapted: a worker's launch fails where Claude Code's query does not start, where upstream's DSH could not resolve its agent.
    query.mockImplementation(args => {
      const id = args.options.resume ?? args.options.sessionId
      if (id && id !== runtime.masterId) { tries++; throw error }
      return original(args)
    })
    const { ticket } = await acceptedTicket(feishu(String(30 + index), `@bot 修 ${index}`, { root_id: undefined }))
    await settle()
    let now = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toBeUndefined()
      now += 5000 * 2 ** attempt + 1000
      await later(now)
    }
    expect(tries).toBe(4)
    expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
    query.mockImplementation(original)
  }
  // A prepare command whose output names a passing failure is not run again on its own.
  const runs = () => shells().length
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, prepare: 'exit 3' } })
  answers['sh -c exit 3'] = new Error('fatal: unable to access: The requested URL returned error: 503')
  const before = runs()
  const prepared = await acceptedTicket(feishu('40', '@bot 修 prepare', { root_id: undefined }))
  await settle()
  expect(runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('503') })
  expect(runs()).toBe(before + 1)
  // A retry runs the prepare command again, for the directory it left empty was removed; resuming relaunches no failed launch.
  delete answers['sh -c exit 3']
  runtime.executor.resume()
  await settle()
  expect(runs()).toBe(before + 1)
  runtime.engine.retryTicket(prepared.ticket.id)
  await settle()
  expect(runs()).toBe(before + 2)
  expect(runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
})

it('launches a queued Assignment once when the host resumes, and gives a failed launch\'s slot back', async () => {
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, maxWorkers: 1, prepare: 'exit 3' } })
  answers['sh -c exit 3'] = new Error('fatal: no such clone')
  const failed = await acceptedTicket(feishu('50', '@bot 修 一', { root_id: undefined }))
  await settle()
  expect(runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
  // The failed launch holds no slot: the next ticket launches in the only one.
  delete answers['sh -c exit 3']
  const next = await acceptedTicket(feishu('51', '@bot 修 二', { root_id: undefined }))
  await settle()
  expect(runtime.store.tickets.get(next.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
  // A third waits for the slot; resuming queues its launch again, which runs once the slot frees.
  const queued = await acceptedTicket(feishu('52', '@bot 修 三', { root_id: undefined }))
  await settle()
  expect(runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'pending' })
  runtime.executor.resume(); runtime.executor.resume()
  const launches = () => h.claude.to(runtime.sessions.worker(queued.ticket.id)?.id ?? '').length
  // Adapted: the worker's turns end until its Session is idle, which frees its slot, where upstream set its DSH agent idle.
  await endTurns(next.sessionId)
  await runtime.pump(); await settle()
  await vi.waitFor(() => expect(runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' }))
  expect(launches()).toBe(1)
})

it('shows the settings history when one revision holds values its Source kind no longer accepts, without that revision\'s changes', async () => {
  const settings = runtime.store.settings()
  await runtime.settings.save('executor', { ...settings.executor, maxWorkers: 4 }, runtime.store.blockRevision('executor'), 'panel')
  await runtime.settings.save('executor', { ...runtime.store.settings().executor, maxWorkers: 5 }, runtime.store.blockRevision('executor'), 'panel')
  // A revision the migration left as an earlier version wrote it, which the Feishu kind's schema rejects.
  const revision = runtime.store.get(KV.settings.revision)!
  const stored = runtime.store.get(KV.settings.version(revision - 1))!
  runtime.store.set(KV.settings.version(revision - 1), { ...stored, settings: { ...stored.settings,
    sources: { ...stored.settings.sources, feishu: { enabled: true, config: { readPageSize: 'many' } } } } })
  const history = policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings()))
  expect(history.items.slice(0, 2)).toEqual([expect.objectContaining({ revision, changes: null }), expect.objectContaining({ revision: revision - 1, changes: null })])
  expect(history.items[2]).toMatchObject({ revision: revision - 2 })
})

it('restarts a worker whose shell job the host stop ended with the recovery note, as a worker mid-work', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'running the tests' })
  // Its turn ended with a test run in the background, so it is busy, not waiting.
  // Adapted: the turn starts a Claude Code background shell task and ends, where upstream ran a job in DSH's registry.
  const session = h.claude.session(sessionId)
  session.task('local_bash', 'npm test')
  session.end()
  await settle()
  expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'progress' })
  // The host stops, and its jobs end with it.
  const next = await restart()
  await next.ready
  const recovered = next.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', expect.stringMatching(/^(pending|running)$/)])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
})

it('gives a subagent of a worker only the worker\'s work tools, and none once the ticket ended', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // Adapted: a Claude Code subagent runs in its worker's query, under its options and its PreToolUse hook, which Claude Code calls
  // with the subagent's agent_id; upstream restricted and guarded each DSH subagent as it was created. No other Session's
  // subagent runs in a worker's query, so none is left to check.
  const call = { name: 'Bash', arguments: { command: 'npm test', description: 'x' }, agent: 'child-1' }
  expect(started(sessionId).disallowedTools).toContain('AskUserQuestion')
  expect(await guard(sessionId, call)).toBeUndefined()
  runtime.engine.stopTicket(ticket.id)
  expect(await guard(sessionId, call)).toMatch(/^Ticket ended; new work needs a new authorized ticket\.?$/)
})

it('gives a subagent of a worker\'s subagent the same work tools and guard', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // Adapted: as above; a nested subagent's calls reach the same hook with its own agent_id.
  const call = { name: 'Read', arguments: { file_path: 'README.md' }, agent: 'grandchild-1' }
  expect(await guard(sessionId, call)).toBeUndefined()
  runtime.engine.stopTicket(ticket.id)
  expect(await guard(sessionId, call)).toMatch(/^Ticket ended; new work needs a new authorized ticket\.?$/)
})

it('gives the Assignment a restart starts the messages the replaced one had delivered but no step took, once', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // A follow-up reaches the worker mid-turn, and the process stops before a step took it.
  await receive(feishu('2', '另外改一下按钮', { root_id: 'om_1' }))
  const sent = () => h.claude.to(sessionId).filter(message => message.text.includes('另外改一下按钮')).length
  expect(sent()).toBe(1)
  // Adapted: Claude Code's process ends as the host stops, before any step takes what waits, where upstream's DSH disposed the
  // worker's agent with its inbox.
  const query = h.claude.session(sessionId).running
  query.interrupt.mockImplementation(async () => { query.close(); return { still_queued: [] } })
  const next = await restart()
  await next.ready; await settle()
  expect(next.store.tickets.get(ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'running'])
  expect(sent()).toBe(2)
})

it('ends the main Session\'s prompt with its Policy section, each rule on one line, and says orchestrator_eval holds no rules', async () => {
  const settings = runtime.store.settings()
  const rules = settings.policy.rules.map(rule => rule.id === 'copy'
    ? { ...rule, name: 'Copy\nfixes', instruction: 'Fix typos.\n- Keep the tone.\n\n## Not a heading' } : rule)
  await runtime.settings.save('policy', { ...settings.policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  await settle()
  // Adapted: the router's prompt is the system prompt its query starts with; an idle router starts again on the save's notice.
  const prompt = promptOf(runtime.masterId)
  const policy = prompt.slice(prompt.indexOf('## Policy'))
  // Nothing follows the section, whose lines after its head are exactly the enabled rules.
  expect(policy.trimEnd().split('\n').slice(2)).toEqual(runtime.store.settings().policy.rules.filter(rule => rule.enabled)
    .map(rule => rule.id === 'copy' ? '- Copy fixes (copy): Fix typos. - Keep the tone. ## Not a heading' : `- ${rule.name} (${rule.id}): ${rule.instruction}`))
  expect(prompt.indexOf('## Policy')).toBeGreaterThan(prompt.indexOf('Execution environment'))
  expect(runtime.toolsOf().find(tool => tool.name === 'orchestrator_eval')!.description).not.toMatch(/rules/)
})

it('keeps the Policy the main Session judges by in its prompt, after admission and the rest, as the latest save left it', async () => {
  // Adapted: the router's prompt is the system prompt of its latest query, which starts here as it does at its first message;
  // an idle router starts again on a save's notice, where upstream's DSH read the section at each model request.
  await runtime.sessions.router.openSession()
  const prompt = () => promptOf(runtime.masterId)
  // Adapted: the section runs to the end of the prompt, where upstream's section text ended with a newline after it.
  const policy = () => { const text = prompt(), at = text.indexOf('## Policy'), close = text.indexOf('\n\n', at); return text.slice(at, close < 0 ? undefined : close) }
  const settings = runtime.store.settings()
  const line = (rule: { id: string; name: string; instruction: string }) => `- ${rule.name} (${rule.id}): ${rule.instruction}`
  expect(prompt().indexOf('## Policy')).toBeGreaterThan(prompt().indexOf('Assess proactive candidates yourself'))
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(settings.policy.rules.filter(rule => rule.enabled).map(line))
  expect(policy()).toContain(`Policy version ${policyVersion(settings)}; accept mode ${settings.eval.mode}.`)
  // The rules govern proactive candidates only; read beside an explicit request, they must not be taken to refuse it.
  expect(policy()).toContain('The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.')
  // A save changes it from the next request: one rule disabled, the other's instruction changed.
  const rules = settings.policy.rules.map(rule => rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep it short.` } : { ...rule, enabled: false })
  await runtime.settings.save('policy', { ...settings.policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  await settle()
  const saved = runtime.store.settings()
  expect(policy()).toContain(`Policy version ${policyVersion(saved)}`)
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(rules.filter(rule => rule.enabled).map(line))
  // With no rule enabled, a proactive candidate can only be ignored.
  await runtime.settings.save('policy', { ...saved.policy, rules: rules.map(rule => ({ ...rule, enabled: false })) }, runtime.store.blockRevision('policy'), 'panel')
  await settle()
  expect(policy()).toContain('No rule is enabled: a proactive candidate can only be ignored.')
  expect(policy()).toContain('The accept mode and the rules decide proactive candidates only')
})
