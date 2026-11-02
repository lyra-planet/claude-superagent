/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { startOutbox, teamChannel } from './fixtures/outbox.ts'

// Adapted: upstream ran these on the whole Runtime of its simulated DSH host; tests/fixtures/outbox.ts builds the Outbox alone.
let h: ReturnType<typeof startOutbox>
let lark: MockInstance<Commands['lark']>
beforeEach(() => { lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({}); h = startOutbox() })
afterEach(async () => { await h.stop(); vi.restoreAllMocks() })

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  h.pause(true)
  h.outbox.send({ id: 'held', channel: teamChannel(), text: '已合并。', kind: 'notice' })
  await h.outbox.sent()
  expect([h.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  h.pause(false)
  h.effects.kick(); await h.outbox.sent()
  expect(h.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.outbox.sent()
  expect([h.outbox.status('waiting'), h.health.reply?.state]).toEqual(['pending', 'ready'])
  h.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await h.at(5000)
  expect([h.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})
