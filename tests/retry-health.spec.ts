/**
 * Ported from upstream's tests/retry-health.spec.ts. Upstream's RetryHealth follows DSH's retry events for a model budget; here
 * Sessions follows the SDK's `api_retry` messages of each Session's query (src/app/sessions.ts): one for billing
 * (`billing_error`) is a wait on the model's budget; a 429 (`rate_limit`) is a passing throttle, as upstream counts it. An
 * assistant message, a turn's end, the Session's idle or its query's
 * end clears. The cases run on the Runtime and the stand-in Claude Code, whose query emits what the case says; a Session's wait
 * shows as its `modelRetry` and on the `models` health entry. Upstream's `list()` is the health entry; its `get` is `modelRetry`.
 *
 * Left out, as DSH-only:
 * - Three failures of 'does not classify another failure as a budget wait' that differ from others only by their message text
 *   ('Context budget has been exceeded!', 'maximum context length exceeded', 'a budget was mentioned…'): the SDK reports a
 *   failure's category and HTTP status, no text.
 * - 'does not let duplicate, out-of-order or previous-step events replace or clear the active wait': a query's messages come
 *   in order and carry no sequence number, turn or step.
 * - 'does not treat interrupted assistant output as success': the SDK's assistant messages carry no flag for output a cancel
 *   cut off.
 * - The `turn/start` and `step/start` boundaries, and the late events of a step that ended, of 'clears active status at %s
 *   without reviving on late events': Claude Code reports no start of a turn or step within a running query, and no step a
 *   retry belongs to.
 * - 'reconstructs only the active wait from a restored snapshot and permits idle cleanup': Claude Code retries in its own
 *   process, which a restart of the host ends, and no Session history records a retry.
 * - Provider and retry-chain identities (`provider`, `retryId`) and DSH's `llm/retry-started` event, which the SDK does not
 *   report: a fresh status starts once a wait cleared.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FakeQuery } from './fixtures/claude.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { vi.useRealTimers(); await h.stop() })
const flush = () => new Promise(resolve => setImmediate(resolve))
const epoch = Date.parse('2026-09-21T08:00:00Z')
const at = (seq: number) => new Date(epoch + seq * 1000).toISOString()
/** The clock reads `seq` seconds after the epoch, as upstream's events carried their time. */
const clock = (seq: number) => { vi.useFakeTimers({ toFake: ['Date'], now: epoch + seq * 1000 }) }
/** The router's query, opened. */
async function router(): Promise<FakeQuery> {
  await h.runtime.sessions.router.openSession()
  return h.claude.session(h.runtime.masterId).running
}
/** A Session's query emits a scheduled retry at `seq` seconds after the epoch, by default of a billing failure. */
async function retry(query: FakeQuery, seq: number, data: Record<string, unknown> = {}) {
  clock(seq)
  query.emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 10000, error_status: 400, error: 'billing_error',
    uuid: `retry-${seq}`, session_id: query.session.id, ...data })
  await flush()
}
/** The model answers: an assistant message. */
async function success(query: FakeQuery) { query.emit({ type: 'assistant', uuid: 'a', parent_tool_use_id: null, message: { role: 'assistant', content: [] } }); await flush() }
const status = (sessionId: string) => h.runtime.sessions.modelRetry(sessionId)
const waiting = () => h.runtime.health.models?.state === 'error'

it('projects native retry schedules without exposing failure text or policy data', async () => {
  const query = await router(), id = h.runtime.masterId
  // Adapted: what a provider might add beside the SDK's fields stands for upstream's failure text.
  const secret = { message: 'Budget has been exceeded! Current cost: 100, Max budget: 99', secret: 'never disclose', policyKey: 'opaque' }
  await retry(query, 1, secret)
  expect(status(id)).toEqual({ model_retry: { attempts: 1, since: at(1), status: 400, error: 'billing_error' } })
  await retry(query, 3, { ...secret, attempt: 345 })
  expect(status(id)).toEqual({ model_retry: { attempts: 345, since: at(1), status: 400, error: 'billing_error' } })
  expect(h.runtime.health.models).toMatchObject({ state: 'error', detail: expect.stringContaining(`retried 345 times since ${at(1)}`) })
  expect(JSON.stringify([status(id), h.runtime.health.models])).not.toMatch(/secret|Current cost|Max budget|policyKey|opaque|retry-\d|10000/)
})

// Adapted: the SDK names a billing failure's category, where DSH's provider metadata or message said it. A rate limit (429) is
// no budget wait, as upstream's; Claude Code reports a passing throttle under it too.
it.each([
  { error: 'billing_error', error_status: 400 },
])('recognizes budget failure metadata or a known provider message: %j', async failure => {
  await retry(await router(), 1, failure)
  expect(status(h.runtime.masterId)).toMatchObject({ model_retry: { attempts: 1 } })
})

// Adapted: each failure is the SDK's category and status of upstream's (an authentication error has no status here).
it.each([
  { error: 'invalid_request', error_status: 429 },
  { error: 'authentication_failed', error_status: null },
  { error: 'invalid_request', error_status: 401 },
  { error: 'invalid_request', error_status: 400 },
  { error: undefined, error_status: null },
])('does not classify another failure as a budget wait: %j', async failure => {
  await retry(await router(), 1, failure)
  expect([status(h.runtime.masterId), waiting()]).toEqual([{}, false])
})
it.each([
  { error: 'rate_limit', error_status: 429 },
])('does not classify another failure as a budget wait: %j', async failure => {
  await retry(await router(), 1, failure)
  expect([status(h.runtime.masterId), waiting()]).toEqual([{}, false])
})

it('ignores quoted assistant/user text and failed attempts without a scheduled retry', async () => {
  const query = await router()
  query.emit({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Budget has been exceeded!' }] } })
  query.emit({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: '{"error":"billing_error"}' }] } })
  // Adapted: a failed attempt Claude Code does not retry comes as an assistant message carrying its error.
  query.emit({ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, error: 'billing_error', message: { role: 'assistant', content: [] } })
  await flush()
  expect([status(h.runtime.masterId), waiting()]).toEqual([{}, false])
})

it('keeps independent sessions and starts a fresh status for a new provider or chain', async () => {
  // Adapted: the router and a worker are the two Sessions; a chain ends when the model answers, and a retry after starts afresh.
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const a = await router(), b = h.claude.session(sessionId).running
  await retry(a, 1, { attempt: 12 }); await retry(b, 1)
  expect(status(h.runtime.masterId)).toMatchObject({ model_retry: { attempts: 12, since: at(1) } })
  await success(a)
  expect(status(h.runtime.masterId)).toEqual({})
  await retry(a, 4, { attempt: 1 })
  expect(status(h.runtime.masterId)).toMatchObject({ model_retry: { attempts: 1, since: at(4) } })
  await success(a)
  expect(status(h.runtime.masterId)).toEqual({})
  expect(status(sessionId)).toMatchObject({ model_retry: { attempts: 1, since: at(1) } })
})

it('clears when the active request now retries a different failure, not when the retry starts', async () => {
  // Adapted: the different failure is an overloaded server, a passing one; the SDK reports no start of a retry.
  const query = await router(), id = h.runtime.masterId
  await retry(query, 1)
  expect(status(id)).toMatchObject({ model_retry: { attempts: 1 } })
  await retry(query, 3, { attempt: 2, error: 'overloaded', error_status: 529 })
  expect(status(id)).toEqual({})
  await retry(query, 4, { attempt: 3 })
  expect(status(id)).toMatchObject({ model_retry: { since: at(4) } })
})

/**
 * The router, in a turn, waits on the model, then passes a boundary: `turn/end` its turn ends with the next one waiting, so
 * the Session does not go idle; `idle` its turn ends and it goes idle; `disposed` its query ends. A retry of a later turn starts
 * a status of its own. Adapted: the router, as its query stays open when it idles, where a worker's closes.
 */
async function boundary(name: string) {
  const query = await router(), id = h.runtime.masterId, session = h.runtime.sessions.router
  await h.runtime.sessions.prompt(session, 'go', 'Go.', 'next'); await flush()
  expect(query.status).toBe('running')
  await retry(query, 1, { attempt: 7 })
  expect(status(id)).toMatchObject({ model_retry: { attempts: 7 } })
  if (name === 'turn/end') {
    await h.runtime.sessions.prompt(session, 'next-turn', 'Then this.', 'later')
    query.end({ subtype: 'error_during_execution', is_error: true, errors: ['API Error: 400 billing'] })
    await flush()
    expect(query.status).toBe('running')
  } else if (name === 'idle') {
    query.end(); await flush()
    expect(query.status).toBe('idle')
  } else { query.close(); await flush() }
  expect(status(id)).toEqual({})
  const later = name === 'disposed' ? await router() : query
  if (name !== 'turn/end') { await h.runtime.sessions.prompt(session, 'again', 'Again.', 'next'); await flush() }
  await retry(later, 4, { attempt: 1 })
  expect(status(id)).toMatchObject({ model_retry: { attempts: 1, since: at(4) } })
}
it.each(['idle', 'disposed'])('clears active status at %s without reviving on late events', boundary)
it.each(['turn/end'])('clears active status at %s without reviving on late events', boundary)

it('bounds counters and provider labels and exposes detached status values only', async () => {
  // Adapted: the host keeps no provider label; the category it shows is one of the two it recognizes.
  const query = await router(), id = h.runtime.masterId
  await retry(query, 1, { attempt: Number.MAX_VALUE })
  expect(status(id)).toMatchObject({ model_retry: { attempts: Number.MAX_SAFE_INTEGER, error: 'billing_error' } })
  const shown = status(id) as { model_retry: { attempts: number; error: string } }
  shown.model_retry.attempts = 0; shown.model_retry.error = 'mutated'
  expect(status(id)).toMatchObject({ model_retry: { attempts: Number.MAX_SAFE_INTEGER, error: 'billing_error' } })
})

it.each([NaN, Infinity, -1, 1.5])('ignores malformed retry count %s', async attempts => {
  await retry(await router(), 1, { attempt: attempts })
  expect([status(h.runtime.masterId), waiting()]).toEqual([{}, false])
})
