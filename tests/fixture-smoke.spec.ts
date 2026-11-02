import { afterEach, beforeEach, expect, it } from 'vitest'
import { waitUntil } from './fixtures/async.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('accepts a request, launches its worker with the assignment, and reads a follow-up a step takes', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await waitUntil(() => h.claude.to(one.sessionId).length > 0)
  const session = h.claude.session(one.sessionId)
  expect(h.claude.to(one.sessionId)[0]).toMatchObject({ delivery: 'later' })
  expect(session.status).toBe('running')
  expect(h.ticket(one.ticket.id).assignments.at(-1)).toMatchObject({ state: 'running' })
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1' }))
  await h.runtime.idle()
  await waitUntil(() => h.claude.to(one.sessionId).length === 2)
  expect(h.claude.to(one.sessionId)[1]).toMatchObject({ delivery: 'next' })
  const input = h.ticket(one.ticket.id).inputs.at(-1)!
  expect(input).toMatchObject({ readAt: null })
  session.step()
  await waitUntil(() => !!(h.ticket(one.ticket.id).inputs.at(-1) as { readAt?: string | null }).readAt)
  session.end({ result: 'Fixed it.' })
  await waitUntil(() => h.ticket(one.ticket.id).assignments.at(-1)!.report?.state === 'waiting')
})
