/** Runtime health reporting: per-component error states and recovery on subsequent success. */
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { startOutbox, teamChannel } from './fixtures/outbox.ts'

// Adapted: upstream ran these on the whole Runtime of its simulated DSH host. The relay and notice effects belong to the
// Sessions, which this port rewrites, so their two tests wait for the Runtime's; this one keeps the Outbox's replies and
// stands in for the Sessions' relay with a handler on the same effect queue, retried as upstream's was (2 s, then doubling).
let h: ReturnType<typeof startOutbox>
let lark: MockInstance<Commands['lark']>
beforeEach(() => { lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({}); h = startOutbox() })
afterEach(async () => { await h.stop(); vi.restoreAllMocks() })

it('keeps a failing relay\'s error while replies recover, and a failing reply\'s error while relays recover', async () => {
  const steer = vi.fn<(text: string) => void>()
  h.effects.handle('relay', async ({ text }) => { steer(text) })
  const reply = (id: string) => { h.outbox.send({ id, channel: teamChannel(), text: '已合并。', kind: 'notice' }) }
  steer.mockImplementation(() => { throw new Error('master gone') })
  h.effects.enqueue('relay', 'r2', { text: JSON.stringify({ kind: 'note' }) })
  lark.mockRejectedValue(new Error('internal error (2200)'))
  reply('stuck')
  // Each fails three times in a row: the relay after 0, 2 and 6 seconds, the reply after 0, 5 and 15.
  await h.effects.idle(); await h.at(5000); await h.at(15_000)
  expect(h.health).toMatchObject({ relay: { state: 'error' }, reply: { state: 'error', detail: expect.stringContaining('2200') } })
  lark.mockResolvedValue({})
  await h.at(35_000)
  expect(h.health).toMatchObject({ relay: { state: 'error' }, reply: { state: 'ready' } })
  lark.mockRejectedValue(new Error('internal error (2200)'))
  reply('stuck-2')
  steer.mockImplementation(() => {})
  await h.effects.idle(); await h.at(50_000); await h.at(70_000)
  expect(h.health).toMatchObject({ relay: { state: 'ready' }, reply: { state: 'error' } })
  expect(steer).toHaveBeenLastCalledWith(JSON.stringify({ kind: 'note' }))
})
