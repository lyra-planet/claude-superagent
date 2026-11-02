/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Engine, UserError, type Assessor, type Executor } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsConflict, Settings, type SettingsHost } from '../src/app/settings.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema, settingsPolicy, type RoleModel } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { deferred } from './fixtures/async.ts'
import { testDeployment } from './fixtures/deployment.ts'

/**
 * `Settings` on its own host: a Store with the GitHub and Feishu Sources on, Alice (`ou_alice`) allowed and `oc_team` as the
 * Feishu sync chat, an Engine on that Store, and stand-ins for the model check, setup and the Sessions. Adapted: upstream ran
 * these on the whole Runtime of its simulated DSH host (tests/fixtures/host.ts), which checked models through DSH's LLM
 * service; here the model check is the host's `checkModel`, and setup and the main Session's notices are stand-ins.
 */
function start() {
  const directory = mkdtempSync(join(tmpdir(), 'settings-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const sourceSettings = { github: { enabled: true, config: { repository: 'acme/widgets', cli: '/opt/bin/gh-agent' } },
    feishu: { enabled: true, config: { cli: '/opt/bin/lark-bot', chats: [{ chatId: 'oc_team', listen: 'all' as const }], directMessages: true } } }
  const parsed = SettingsSchema.parse({ sources: sourceSettings })
  store.saveSettings({ ...parsed, eval: { ...parsed.eval, mode: 'auto' },
    policy: { ...parsed.policy, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team', admission: {} },
      github: { allowed: [{ id: 'alice' }], admission: {} } } } })
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(feishuKind); sources.register(githubKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const lifetime = new AbortController()
  const deployment = testDeployment({ stateDir: directory })
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(),
    configured: () => true, receive: trigger => engine.receive(trigger) }
  const checkModel = vi.fn<(model: RoleModel) => Promise<void>>(async () => {})
  const setup = { configured: vi.fn(() => true), checkAccounts: vi.fn(async () => {}), blockCommands: vi.fn(async () => {}), restart: vi.fn() }
  const sessions = { notify: vi.fn(), delivery: vi.fn(async () => 'injected' as const) }
  const host: SettingsHost = { store, sources, engine, health: board, checkModel, lifetime: lifetime.signal, sessions,
    sourceHost: { sources, context: kind => sourceContextOf(deps, kind) }, setup: setup as unknown as SettingsHost['setup'], requestPass: vi.fn() }
  const settings = new Settings(host)
  const stop = () => { lifetime.abort(); store.close(); rmSync(directory, { recursive: true, force: true }) }
  return { settings, store, health: board.all, checkModel, setup, sessions, stop }
}
type Host = ReturnType<typeof start>

let h: Host | undefined
afterEach(() => { h?.stop(); h = undefined; vi.restoreAllMocks() })
const model = { provider: 'worker-provider', model: 'worker-model' }
const members = (...users: [string, string][]) => ({ users: users.map(([member_id, name]) => ({ member_id, name })), has_more: false })

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = start()
  const { settings, store } = h
  const check = deferred<void>()
  h.checkModel.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve()
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  h.setup.checkAccounts.mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

// Added with the port: the role model check that replaced DSH's model resolution.
it('checks a role model only when a save changes it, and refuses one the host cannot run with the reason', async () => {
  h = start()
  const { settings, store } = h
  const executor = store.settings().executor
  await settings.save('executor', { ...executor, maxWorkers: 3 }, store.blockRevision('executor'), 'panel')
  expect(h.checkModel).not.toHaveBeenCalled()
  h.checkModel.mockRejectedValueOnce(new Error('model not found'))
  await expect(settings.save('executor', { ...executor, model }, store.blockRevision('executor'), 'panel'))
    .rejects.toThrow(new UserError('modelUnavailable', { block: 'executor', error: 'model not found' }))
  expect(store.settings().executor.model).toBe(executor.model)
  await settings.save('eval', { ...store.settings().eval, model }, store.blockRevision('eval'), 'panel')
  expect(h.checkModel.mock.calls).toEqual([[model], [model]])
  expect(store.settings().eval.model).toEqual(model)
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = start()
  const { settings, store } = h
  const listed = deferred<unknown>()
  vi.spyOn(Commands.prototype, 'lark').mockImplementationOnce(() => listed.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  listed.resolve(members(['ou_alice', 'Alice'], ['ou_new', 'New']))
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = start()
  const { settings } = h
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.spyOn(Commands.prototype, 'lark')
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce(members(['ou_alice', 'Alice']))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = start()
  const { settings, store } = h
  const revision = store.blockRevision('pause')
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  // Adapted: upstream also saw no notice effect queued for the main Session; the notice goes through `sessions.notify`.
  expect([store.blockRevision('pause'), h.sessions.notify.mock.calls.length]).toEqual([revision, 0])
  h.setup.configured.mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  h.setup.configured.mockReturnValue(true)
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})

it('lets only the panel change the workers\' sandbox and its domains, as the rest of the execution environment', async () => {
  h = start()
  const executor = h.store.settings().executor, revision = () => h!.store.blockRevision('executor')
  for (const change of [{ sandbox: 'off' as const }, { networkDomains: ['evil.example'] }]) {
    await expect(h.settings.save('executor', { ...executor, ...change }, revision(), 'tool')).rejects.toMatchObject({ code: 'panelOnlyEnvironment' })
  }
  expect(h.store.settings().executor).toMatchObject({ sandbox: 'on', networkDomains: [] })
  await h.settings.save('executor', { ...executor, sandbox: 'weak', networkDomains: ['registry.npmjs.org'] }, revision(), 'panel')
  expect(h.store.settings().executor).toMatchObject({ sandbox: 'weak', networkDomains: ['registry.npmjs.org'] })
})
