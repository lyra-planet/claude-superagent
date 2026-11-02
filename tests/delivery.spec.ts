/**
 * Ported from upstream's tests/delivery.spec.ts. Upstream's AgentDelivery (src/app/delivery.ts) delivers to a DSH agent at most
 * once per request id across restarts; here that is a ClaudeSession's `send` and `holds` with its ledger (src/app/session.ts),
 * on the stand-in Claude Code (tests/fixtures/claude.ts). A message's id is its uuid; upstream's `queue` and `steer` are the
 * deliveries 'later' and 'next'; a step that takes a message (upstream's `consume`) is the stand-in's replay of it.
 *
 * Left out, as DSH-only:
 * - 'recognizes legacy plugin identity in %s input without rewriting it', 'does not treat a legacy plugin source %s as this
 *   producer', 'recognizes legacy user RPC identity in %s input': message sources of earlier DSH plugin versions; a message's
 *   identity here is its uuid alone, and no earlier version of this host wrote another.
 * - The source, role and frozen-object assertions of the first case: DSH message objects; the host pushes SDK user messages.
 * - The disposed half of 'does not dispatch when cancelled or disposed during history loading': a ClaudeSession is never a
 *   stale handle, as a send after a close opens the Session again by design (src/app/session.ts:147).
 */
import { describe, expect, it, vi } from 'vitest'
import { ClaudeSession, type Delivery, type QueuedMessage, type SessionLedger } from '../src/app/session.ts'
import { fakeClaude } from './fixtures/claude.ts'
import { startRuntime } from './fixtures/host.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))
const ID = 'delivery-test'
/**
 * A ClaudeSession on the stand-in Claude Code, whose stored history holds `history`; `ledger` is what an earlier query was
 * handed and did not take.
 */
function fixture(history: string[] = [], pending: QueuedMessage[] = []) {
  const claude = fakeClaude()
  const stored = claude.session(ID)
  for (const uuid of history) stored.history.push({ type: 'user', uuid, message: { role: 'user', content: '' } })
  let list = pending
  const ledger = { pending: vi.fn(() => list), save: vi.fn((next: QueuedMessage[]) => { list = next }) } satisfies SessionLedger
  const session = new ClaudeSession(ID, '/work/t1', async () => ({ options: {}, fingerprint: 'f1' }), {}, claude.sdk, ledger)
  const send = (uuid = 'request', delivery: Delivery = 'next', authorize?: () => void) => session.send(uuid, '{"event_id":"event"}', delivery, authorize)
  /** What the host pushed under `uuid`. */
  const pushed = (uuid = 'request') => claude.to(ID).filter(message => message.uuid === uuid)
  /** A turn runs, so a message waits for its step or for the turn's end. */
  const working = async () => { await send('start', 'next'); await flush(); expect(stored.status).toBe('running') }
  return { claude, stored, session, ledger, send, pushed, working, ledgerIds: () => list.map(message => message.uuid) }
}

it.each([['queue', 'later'], ['steer', 'next']] as const)('delivers %s as an orchestrator relay, deduplicating pending and consumed messages', async (_mode, delivery) => {
  const f = fixture()
  await f.working()
  await f.send('request', delivery)
  await flush()
  expect(f.pushed()).toEqual([expect.objectContaining({ delivery })])
  await f.send('request', delivery)
  // The step that takes it: a queued message is taken as the running turn ends and the next starts.
  if (delivery === 'later') f.stored.end(); else f.stored.step()
  await flush()
  expect(f.stored.taken()).toContain('request')
  await f.send('request', delivery)
  await flush()
  expect(f.pushed()).toHaveLength(1)
  // Adapted: the Session's history is read once while its query runs, where DSH opened and closed it once.
  expect(f.claude.sdk.getSessionMessages).toHaveBeenCalledOnce()
  const restored = fixture(['request'])
  await restored.send('request', delivery)
  await flush()
  expect(restored.pushed()).toEqual([])
})

it('retries a failed durability barrier without another delivery and permits concurrent retries', async () => {
  // Adapted: the barrier is the Session's ledger, which records a message before it is pushed, where DSH flushed its
  // persistence after; a failed record pushes nothing, so no step has one to take, and the retries push it once.
  const f = fixture()
  const save = f.ledger.save.getMockImplementation()!
  let failed = false
  f.ledger.save.mockImplementation(next => {
    if (!failed && next.some(message => message.uuid === 'request')) { failed = true; throw new Error('disk busy') }
    save(next)
  })
  await expect(f.send()).rejects.toThrow('disk busy')
  await flush()
  await Promise.all([f.send(), f.send()])
  await flush()
  expect(f.pushed()).toHaveLength(1)
  expect(f.ledgerIds()).toEqual([])
})

it('retries history failures and reads past the first page', async () => {
  const f = fixture([...Array.from({ length: 512 }, (_, index) => `other-${index}`), 'request'])
  vi.mocked(f.claude.sdk.getSessionMessages).mockRejectedValueOnce(new Error('read failed'))
  await expect(f.send()).rejects.toThrow('read failed')
  await f.send()
  await flush()
  expect(f.pushed()).toEqual([])
})

it('keeps consumption that happens during the initial history read', async () => {
  // Adapted: an earlier query was handed the message and did not take it; while a send reads the history, a start runs beside
  // it, which reads the same history once, hands the message over again from the ledger, and the stand-in takes it. The send
  // then finds it held, so the Session gets one copy. (Upstream's read could run while its agent took the message; here a
  // start reads the history first, so a take cannot fall inside a read.)
  const f = fixture([], [{ uuid: 'request', text: '{"event_id":"event"}', delivery: 'next' }])
  const read = vi.mocked(f.claude.sdk.getSessionMessages)
  const stored = read.getMockImplementation()!
  read.mockImplementationOnce(async (...args) => { void f.session.openSession(); return stored(...args) })
  await f.send()
  await flush()
  expect(f.pushed()).toHaveLength(1)
  expect(f.stored.taken()).toEqual(['request'])
})

it('does not dispatch when cancelled or disposed during history loading', async () => {
  // Adapted: a send takes no signal; its caller's cancellation is the authorization that runs last before the message is
  // recorded and pushed. The disposed half is left out (see the module comment).
  const cancelled = fixture()
  const signal = new AbortController()
  const read = vi.mocked(cancelled.claude.sdk.getSessionMessages), stored = read.getMockImplementation()!
  read.mockImplementationOnce(async (...args) => { signal.abort(); return stored(...args) })
  await expect(cancelled.send('request', 'next', () => { signal.signal.throwIfAborted() })).rejects.toThrow()
  await flush()
  expect(cancelled.pushed()).toEqual([])
  expect(cancelled.ledgerIds()).toEqual([])
})

describe('a notice', () => {
  // Adapted: a notice's summary heads its text, which the host's Sessions write (src/app/sessions.ts:123), so the case runs on
  // the Runtime; DSH's `inject` is the delivery 'inject', which starts no turn.
  it('injects a notice once, as dsh-superagent\'s notice with its summary, without waking the agent', async () => {
    const h = await startRuntime()
    try {
      const router = h.claude.session(h.runtime.masterId)
      for (let turns = 0; router.status === 'running' && turns < 10; turns++) { router.end(); await h.runtime.idle() }
      h.claude.pushed.mockClear()
      for (let copy = 0; copy < 2; copy++) {
        h.runtime.sessions.notify('settings', { settings_saved: 'policy' }, 'Settings saved')
        expect(await h.runtime.sessions.delivery('settings')).toBe('injected')
      }
      const sent = h.claude.to(h.runtime.masterId)
      expect(sent).toEqual([expect.objectContaining({ delivery: 'inject', text: 'Notice: Settings saved\n{"settings_saved":"policy"}' })])
      expect(router.status).toBe('idle')
    } finally { await h.stop() }
  })
})

it('tells whether the Session holds a message: one waiting in its inbox, one it took, and one in its stored history', async () => {
  const f = fixture()
  expect(await f.session.holds('request')).toBe(false)
  await f.working()
  await f.send('request')
  await flush()
  expect(await f.session.holds('request')).toBe(true)
  expect(f.session.queuedHas('request')).toBe(true)
  f.stored.step()
  await flush()
  expect([f.session.queuedHas('request'), await f.session.holds('request')]).toEqual([false, true])
  const restored = fixture(['request'])
  expect([await restored.session.holds('request'), await restored.session.holds('other')]).toEqual([true, false])
})
