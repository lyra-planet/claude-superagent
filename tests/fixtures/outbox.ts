/**
 * The Outbox with its Store, effect queue and Sources, as the Runtime builds them, with the Feishu Source on and listening to
 * `oc_team`. Upstream ran the Outbox's tests on the whole Runtime of its simulated DSH host (tests/fixtures/host.ts); the
 * Outbox and what it uses are copied unchanged, so they run here without a Runtime. Stop it with `stop()`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Effects } from '../../src/app/effects.ts'
import { Outbox } from '../../src/app/outbox.ts'
import { Store } from '../../src/app/store.ts'
import { Commands } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { testDeployment } from './deployment.ts'

export function startOutbox() {
  const directory = mkdtempSync(join(tmpdir(), 'outbox-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { cli: '/opt/bin/lark-bot',
    chats: [{ chatId: 'oc_team', listen: 'all' }], directMessages: true } } } }))
  const board = new HealthBoard()
  const effects = new Effects(store, board)
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(feishuKind)
  const deployment = testDeployment({ stateDir: directory })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const outbox = new Outbox({ store, effects, sources, commands, paused: () => store.settings().paused })
  effects.start()
  /** Save the pause setting, as `Settings.pause` does. */
  const pause = (paused: boolean) => { store.saveSettings({ ...store.settings(), paused }) }
  /** Advance fake `Date.now()` by `ms`, start the effects now due and wait for them, as the Runtime's pass does. */
  async function at(ms: number) {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { effects.kick(); await effects.idle() } finally { vi.useRealTimers() }
  }
  const stop = async () => { await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) }
  return { store, effects, sources, outbox, health: board.all, pause, at, stop }
}
/** The Channel of a message in `oc_team`. */
export const teamChannel = () => feishuTrigger({ message_id: 'om_1', chat_id: 'oc_team', chat_type: 'group', sender_id: 'ou_alice',
  sender_type: 'user', content: 'x', create_time: String(Date.now()), mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!.channel!
