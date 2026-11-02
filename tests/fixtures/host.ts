/**
 * A configured Runtime on the stand-in Claude Code (tests/fixtures/claude.ts), as upstream's tests/fixtures/host.ts runs
 * one on a simulated DSH: GitHub and Feishu Sources without their polling loops, allowed member Alice (`ou_alice`), listened
 * chat `oc_team`, and `auto` mode. Stop it with `stop()`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Runtime } from '../../src/app/runtime.ts'
import { Store } from '../../src/app/store.ts'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import { workerSessionId } from '../../src/executor/common.ts'
import { Commands } from '../../src/infra/commands.ts'
import { credentialHelper, workerGitConfig, type SubprocessRuntime } from '../../src/infra/environment.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuSource, feishuTrigger } from '../../src/sources/feishu.ts'
import { githubSource } from '../../src/sources/github.ts'
import type { SourcePlugin } from '../../src/sources/kind.ts'
import { fakeClaude } from './claude.ts'
import { testMachine } from './deployment.ts'

export const MEMBER = 'ou_alice'
export const CHAT = 'oc_team'

/** Build a Feishu mention trigger from Alice in `oc_team`, using the digits in `id` as the timestamp offset in seconds. */
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}
const quietly = (kind: SourcePlugin['kind']): SourcePlugin => ({ kind, run: async () => {} })

/** @param seed - writes to the database before the Runtime opens it, such as records an earlier run stored. */
export async function startRuntime(seed?: (store: Store) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-host-'))
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const scoped = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
  const answers: Record<string, string> = {
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    [scoped]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
  }
  /** A prepare command (`sh -c`) waits for this while it is set. */
  const hooks: { prepare?: Promise<void> } = {}
  const subprocess = { run: vi.fn(async (command: string[]) => {
    const argv = [...command]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    if (argv[0] === 'sh' && hooks.prepare) await hooks.prepare
    return { exitCode: 0, stdout: answers[argv.join(' ')] ?? '', stderr: '' }
  }) } satisfies SubprocessRuntime
  const claude = fakeClaude()
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }, feishu: { enabled: true, config: { cli: BOT } } }
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources }))
  seed?.(seeded)
  seeded.close()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const restart = vi.fn()
  const runtime = new Runtime(testMachine({ stateDir: directory, claudeConfigDir: join(directory, 'claude') }), { logger, restart, subprocess,
    sdk: claude.sdk, listen: false, plugins: local => [quietly(githubSource.kind), quietly(feishuSource.kind), local] })
  await runtime.start()
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT, admission: {} },
      github: { allowed: [{ id: 'alice' }], admission: {} } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  claude.pushed.mockClear()

  /** Parsed JSON payloads the host pushed to `sessionId`. */
  const relays = (sessionId: string) => claude.to(sessionId).flatMap(message => { try { return [JSON.parse(message.text) as Record<string, unknown>] } catch { return [] } })
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  /** Run a tool of the router (`ticketId` undefined) or of a ticket's worker, as the Session's MCP server does. */
  const runTool = async (ticketId: string | undefined, name: string, args: unknown) => {
    const ticket = ticketId === undefined ? undefined : runtime.store.tickets.get(ticketId)
    const tool = runtime.toolsOf(ticket).find(item => item.name === name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${ticketId ?? 'the router'}`)
    return await tool.execute(tool.schema.parse(args), new AbortController().signal) as Record<string, unknown>
  }
  /** Route one decision with the router's orchestrator_route, answering its result; a refused one throws its reason. */
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { results } = await runTool(undefined, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  /** Accept `trigger` as a ticket, and wait for its worker's first turn, which took the assignment, to run. */
  async function acceptedTicket(trigger: Trigger) {
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' })
    await runtime.idle()
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
  async function stop() { await runtime.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  /** The stored ticket. */
  const ticket = (id: string): Ticket => runtime.store.tickets.get(id)!
  return { runtime, claude, directory, relays, candidates, runTool, route, acceptedTicket, api, subprocess, hooks, logger, restart, ticket, stop }
}
export type Host = Awaited<ReturnType<typeof startRuntime>>
