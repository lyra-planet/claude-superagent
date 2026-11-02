/**
 * Concurrent runtime behavior across overlapping triggers, deliveries, and worker launches.
 *
 * Ported from upstream's tests/runtime-concurrency.spec.ts, from its start through the case that gives each idle its own
 * 30 minutes. Every case of that part is here. Parts of cases that test DSH-only mechanics are left out, each marked where it
 * was:
 * - DSH's job tools collect a job's end with a wait (`jobs.service.wait`, `jobs.released`) and the host injects a note of it
 *   at the worker's next turn: on Claude Code a job that ends starts a turn by itself, in which the worker reads of it.
 * - DSH drains a Session's descendants, after which it admits no new subagents: Claude Code has no such state.
 * - A turn that a stop of subagents wakes, which DSH cancels: a task that Claude Code stops starts no turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { latestAssignment, type Ticket } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/common.ts'
import { Commands } from '../src/infra/commands.ts'
import { deferred, sleep, waitUntil } from './fixtures/async.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const lark = { users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false }
const linkLookedUp = (messageId: string) =>
  vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('+messages-mget') && args.includes(messageId))
const worker = (sessionId: string) => h.claude.session(sessionId)
const report = (ticketId: string) => latestAssignment(h.ticket(ticketId))?.report
/**
 * Hold the first opening of a Session's query until `gate` resolves; `held()` says whether it began. Upstream holds DSH's
 * resolution of the Session; here a delivery waits for the Session when its query opens, which reads whether it exists.
 */
function holdSession(sessionId: string, gate: Promise<void>) {
  let held = false
  const info = vi.mocked(h.claude.sdk.getSessionInfo)
  const original = info.getMockImplementation()!
  info.mockImplementation(async (id, options) => { if (id === sessionId && !held) { held = true; await gate } return original(id, options) })
  return () => held
}
/**
 * The worker's turn ends with no report, so it reports waiting and its query closes: idle, as upstream sets a DSH agent's
 * status. A message to it then opens its query again.
 */
async function idleWorker(one: { ticket: Ticket; sessionId: string }) {
  worker(one.sessionId).end()
  await waitUntil(() => report(one.ticket.id)?.state === 'waiting')
  await waitUntil(() => !worker(one.sessionId).query)
}
/** How many prepare commands (`sh -c`) ran. */
const prepares = () => h.subprocess.run.mock.calls.filter(([command]) => {
  const argv = [...command]
  while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
  return argv[0] === 'sh'
}).length
/** A turn that ends with a passing provider failure, as Claude Code reports one: DSH's `agent/error` with a 503. */
const busy = { subtype: 'error_during_execution', is_error: true, errors: ['API Error: 503 Service Unavailable'] }
const told = (sessionId: string) => h.claude.to(sessionId).filter(message => message.text.includes('Your last turn failed for a passing reason'))

it('evaluates a message that arrives on a thread while an earlier candidate\'s card waits for its link, in the thread\'s next Eval', async () => {
  const gate = deferred()
  // The first candidate's source link lookup is slow; Feishu allows it up to linkTimeoutMs.
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => { if (args.includes('+messages-mget') && args.includes('om_1')) await gate.promise; return lark })
  await h.runtime.settings.pause(true, 'panel')
  const a1 = feishu('1', '@bot 修 A'), b1 = feishu('2', '@bot 修 B'), b2 = feishu('3', '@bot B 还有这个', { root_id: 'om_2' })
  h.runtime.receive(a1); h.runtime.receive(b1)
  await h.runtime.settings.pause(false, 'panel')
  await waitUntil(() => linkLookedUp('om_1'))
  h.runtime.receive(b2)
  gate.resolve(); await h.runtime.idle()
  const threadB = `feishu:${CHAT}:om_2`
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b1.id] }, pending: [b2.id] })
  await h.route({ kind: 'ignore', trigger_id: b1.id, reason: 'duplicate' })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b2.id] }, pending: [] })
  // A slow link lookup holds only its own candidate's card.
  expect(h.candidates()).toEqual([b1.id, a1.id, b2.id])
})

// Adapted: both workers go idle first, so a delivery waits for its Session's query to open (a running query takes a
// message at once); the follow-ups come from Alice, as one from 'ou_guest' reaches the ticket only as context (Policy.owns).
it('delivers nothing to a ticket a person stopped while an earlier ticket\'s delivery waited', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  await idleWorker(one); await idleWorker(two)
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1' }))
  h.runtime.receive(feishu('6', '二的补充', { mentions: [], root_id: 'om_5' }))
  // Tickets are processed newest-first, so holding ticket two pauses the pass before ticket one is delivered.
  const gate = deferred()
  const held = holdSession(two.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.claude.pushed.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.claude.pushed.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ ended: { by: 'human' }, undelivered: [] })
})

// Adapted: the worker goes idle first, so the delivery waits for its Session's query to open; the follow-up comes from
// Alice, as one from 'ou_guest' reaches the ticket only as context (Policy.owns).
it('drops a delivery whose ticket a person stopped while it waited for the worker Session', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await idleWorker(one)
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1' }))
  const gate = deferred()
  const held = holdSession(one.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.claude.pushed.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.claude.pushed.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).not.toHaveProperty('delivery')
})

it('runs prepare commands in the background, side by side, while accepts, intake and passes go on', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR"' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  const first = [feishu('1', '@bot 修一'), feishu('2', '@bot 修二')]
  for (const trigger of first) h.runtime.receive(trigger)
  await h.runtime.idle()
  for (const [index, trigger] of first.entries()) {
    const accepted = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: `fix-${index}`, acknowledgement: '收到。' })
    expect(accepted).toMatchObject({ decision: 'accept', ticket: { state: 'working/queued' } })
  }
  await waitUntil(() => prepares() === 2)
  // A Source loop's next message is stored at once, and a pass relays it while both prepare commands still run.
  const later = feishu('3', '@bot 修三')
  expect(h.runtime.receive(later)).toBe('stored')
  await h.runtime.pump()
  expect(h.candidates()).toEqual([...first, later].map(trigger => trigger.id))
  prepare.resolve()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list().map(ticket => ticket.assignments.at(-1)!.state)).toEqual(['running', 'running'])
})

it('keeps a launch that a pause cut short queued, and finishes it once processing resumes', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'make worktree' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  const trigger = feishu('1', '@bot 修一')
  h.runtime.receive(trigger); await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-one', acknowledgement: '收到。' })
  await waitUntil(() => prepares() > 0)
  await h.runtime.settings.pause(true, 'panel')
  prepare.resolve(); await h.runtime.idle()
  const [ticket] = h.runtime.store.tickets.list()
  expect(ticket!.assignments).toEqual([expect.objectContaining({ state: 'pending' })])
  expect(h.runtime.effects.pending('launch')).toBe(true)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(ticket!.id)!.assignments).toEqual([expect.objectContaining({ state: 'running' })])
})

const botMessage = () => feishu('2', 'CI 失败', { mentions: [], root_id: 'om_1', sender_id: 'cli_ci', sender_type: 'bot' })
// Adapted: a worker goes idle by ending its turn (idleWorker), and someone deletes its Session from Claude Code's store.
it('wakes an idle worker for a bot\'s Input only when a worker slot is free, and creates a worker Session someone deleted again', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await idleWorker(one)
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(worker(two.sessionId).status).toBe('running')
  h.runtime.receive(botMessage()); await h.runtime.idle()
  // Ticket two's worker takes the only slot, so ticket one's Input waits.
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  await idleWorker(two)
  h.claude.sessions.delete(one.sessionId)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(worker(one.sessionId).status).toBe('running')
  // Its query created the Session anew rather than resuming one.
  expect(worker(one.sessionId).query!.options).toMatchObject({ sessionId: one.sessionId })
})

// Adapted: the worker goes idle by ending its turn; the follow-up comes from Alice, as one from 'ou_guest' reaches the
// ticket only as context (Policy.owns).
it('wakes an idle worker for a person\'s message at once, in the slot kept beyond the limit', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await idleWorker(one)
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(worker(two.sessionId).status).toBe('running')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(worker(one.sessionId).status).toBe('running')
})

// Adapted: the worker goes idle by ending its turn (idleWorker).
it('counts a launch under way against maxWorkers, so a bot\'s Input for an idle worker waits for the slot', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1, prepare: 'make worktree' } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await idleWorker(one)
  // Ticket two's launch holds the only slot while its prepare command runs, before its worker's Session does.
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  h.runtime.receive(feishu('5', '@bot 修二')); await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: feishu('5', '').id, title: 'two', worktree_name: 'fix-two', acknowledgement: '收到。' })
  await waitUntil(() => prepares() === 2)
  h.runtime.receive(botMessage()); await h.runtime.pump()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  expect(worker(one.sessionId).status).toBe('idle')
  prepare.resolve(); await h.runtime.idle()
  const two = h.runtime.store.tickets.list().find(ticket => ticket.id !== one.ticket.id)!
  expect(worker(workerSessionId(two.id)).status).toBe('running')
  // The slot is ticket two's now, so ticket one's Input still waits.
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
})

// Adapted: Claude Code fails to start the deleted Session's query (DSH failed to resolve it); the follow-up comes from Alice,
// as one from 'ou_guest' reaches the ticket only as context (Policy.owns).
it('records on the ticket that its worker Session could not be created again', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await idleWorker(one)
  h.claude.sessions.delete(one.sessionId)
  const query = h.claude.sdk.query as unknown as Mock<(args: { options: Record<string, unknown> }) => unknown>
  const original = query.getMockImplementation()!
  query.mockImplementation(args => {
    if (args.options.resume === one.sessionId || args.options.sessionId === one.sessionId) throw new Error('The Session store is offline')
    return original(args)
  })
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ delivery: { error: expect.stringContaining('The Session store is offline') } })
})

// Adapted: each passing failure ends a turn; the next one fails the turn its retry started, so the backoff runs out between
// them (DSH's agent/error fired three times without a turn between them).
it('lets a worker go on after a passing provider failure, three times, before its ticket fails', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const session = worker(one.sessionId)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    session.end(busy)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.claude.to(one.sessionId).at(-1)!.text).toContain('Your last turn failed for a passing reason')
    expect(report(one.ticket.id)).toBeUndefined()
    session.end(busy); await vi.advanceTimersByTimeAsync(30_000)
    session.end(busy); await vi.advanceTimersByTimeAsync(60_000)
  } finally { vi.useRealTimers() }
  expect(report(one.ticket.id)).toBeUndefined()
  // The fourth passing failure fails the ticket, as any other failure does at once.
  session.end(busy)
  await vi.waitFor(() => expect(report(one.ticket.id)).toMatchObject({ state: 'failed', summary: expect.stringContaining('Service Unavailable') }))
})
describe('a worker that goes on after a passing failure', () => {
  // Adapted: as above, each failure fails the turn the last retry started; the worker's query closes at its waiting report,
  // so Alice's message starts the turn that fails once more.
  it('starts the count of passing failures again once its turn ends as turns do', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const session = worker(one.sessionId)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { for (const backoff of [15_000, 30_000, 60_000]) { session.end(busy); await vi.advanceTimersByTimeAsync(backoff) } } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(3)
    // Once the resumed turn ends normally, a later passing failure starts a new retry count rather than counting as the fourth in a row.
    session.end()
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
    h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    await waitUntil(() => session.status === 'running')
    session.end(busy)
    await h.runtime.idle(); await sleep(20)
    expect(report(one.ticket.id)?.state).toBe('waiting')
  })
  // Adapted: the turn that fails is what goes idle (upstream's agent was idle before its error).
  it('waits while processing is paused, and goes on once it resumes', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runtime.settings.pause(true, 'panel')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      worker(one.sessionId).end(busy)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(told(one.sessionId)).toEqual([])
      await h.runtime.settings.pause(false, 'panel')
      await vi.advanceTimersByTimeAsync(5000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(1)
  })
  it('drops its timer when the host stops within the backoff', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      worker(one.sessionId).end(busy)
      // Adapted: the failed turn's result reaches the executor through the query's stream, a few microtasks later.
      await vi.advanceTimersByTimeAsync(1)
      await h.runtime.stop()
      // Its timer is cleared with the Executor, so nothing reads the closed database.
      await vi.advanceTimersByTimeAsync(60_000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toEqual([])
  })
})
describe('a worker whose work runs in the background', () => {
  const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000)
  it('stays busy while its shell job runs, holding its slot, and reports waiting once the job ended and its turn ends', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const session = worker(one.sessionId)
    const job = session.task('local_bash')
    session.end(); await h.runtime.idle()
    // No waiting report and nothing relayed while the job runs; the next ticket waits for the slot the job holds.
    expect(report(one.ticket.id)).toBeUndefined()
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    expect(latestAssignment(h.ticket(two.ticket.id))).toMatchObject({ state: 'pending' })
    // The job ends, which wakes the worker with its result; its turn ends, and it reports waiting.
    session.taskEnd(job)
    expect(session.status).toBe('running')
    session.end()
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
  })
  it('stays busy while a subagent of it works, and reports waiting once the turn its end woke it for ends', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const session = worker(one.sessionId)
    const child = session.task('local_agent')
    session.end(); await h.runtime.idle()
    expect(report(one.ticket.id)).toBeUndefined()
    session.taskEnd(child)
    expect(session.status).toBe('running')
    session.end()
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
  })
  // Adapted: the stop cuts the turn short, stops each task (which Claude Code says ended, starting no turn) and closes the
  // query after them; the tasks reach the host through the query's stream before the stop. Left out, DSH-only: the kill's end
  // releasing the stop's own wait (`jobs.released`), the cancel of a turn a released subagent's end woke (with `keepInbox:
  // false`), and a drained Session refusing new subagents ("lets it start new ones").
  it('kills its shell jobs and releases its subagents when its ticket stops, whose ends wake no one, and lets it start new ones', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const query = worker(one.sessionId).running
    const job = query.task('local_bash'), child = query.task('local_agent')
    await waitUntil(() => h.runtime.sessions.worker(one.ticket.id)!.background.length === 2)
    h.runtime.engine.stopTicket(one.ticket.id)
    await vi.waitFor(() => expect(query.stopTask).toHaveBeenCalledWith(job))
    await vi.waitFor(() => expect(query.stopTask).toHaveBeenCalledWith(child))
    await vi.waitFor(() => expect(query.close).toHaveBeenCalled())
    expect(query.interrupt).toHaveBeenCalled()
    expect(query.close.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...query.stopTask.mock.invocationCallOrder))
    expect(worker(one.sessionId).status).toBe('idle')
  })
  it('reports waiting for the Assignment that replaced one whose idle still waited for its subagents', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.ticket(one.ticket.id)
    const session = worker(one.sessionId), first = session.running
    // The first Assignment's turn ends while a subagent of it works.
    const child = first.task('local_agent')
    session.end(); await h.runtime.idle()
    // Delivering a person's message fails, and a person retries: the subagent is released, and a second Assignment starts.
    h.runtime.engine.deliveryFailed(one.ticket.id, latestAssignment(ticket())!.id, 'Session busy')
    h.runtime.engine.retryTicket(one.ticket.id); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(ticket())).toMatchObject({ state: 'running' }))
    expect(first.stopTask).toHaveBeenCalledWith(child)
    expect(first.tasks.has(child)).toBe(false)
    // The second Assignment's turn ends: it is reported waiting.
    await waitUntil(() => session.status === 'running')
    session.end()
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
    expect(ticket().assignments).toHaveLength(2)
  })
  /**
   * A worker that hands off to a person, with `report`, frees its slot and stops its subagents; its job, a server for the
   * person, runs on. Adapted: the job's end starts a turn by itself, as Claude Code does, in which the worker reads of it
   * (DSH collected the end, woke no one, and injected a note at the next turn); that turn ends handed off as well.
   */
  async function handsOff(state: Record<string, unknown>, before?: (ticketId: string) => void) {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    before?.(one.ticket.id)
    const session = worker(one.sessionId), query = session.running
    const job = query.task('local_bash', 'pnpm dev'), child = query.task('local_agent')
    await h.runTool(one.ticket.id, 'orchestrator_report', state); await h.runtime.idle()
    const relayed = h.relays(h.runtime.masterId).length
    session.end(); await h.runtime.idle()
    // The subagent stops; the job runs on.
    await vi.waitFor(() => expect(query.stopTask).toHaveBeenCalledWith(child))
    expect(session.status).toBe('idle')
    expect(query.tasks.has(job)).toBe(true)
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(query.stopTask).not.toHaveBeenCalledWith(job)
    query.taskEnd(job)
    expect(session.status).toBe('running')
    session.end(); await h.runtime.idle(); await sleep(20)
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
    expect(report(one.ticket.id)).toMatchObject({ state: state.state })
    return one
  }
  it('frees the slot of a worker that reports blocked, stopping its subagents and leaving its jobs, whose end wakes no one', async () => {
    await handsOff({ state: 'blocked', summary: 'Which color?' })
  })
  it('keeps a failed worker from being woken by a job it left, and from failing again', async () => {
    await handsOff({ state: 'failed', summary: 'The build broke.' })
  })
  it('frees the slot of a worker that reports ready on a ticket that follows its pull request', async () => {
    await handsOff({ state: 'ready', summary: 'PR ready' }, ticketId => { h.runtime.engine.bindThread(ticketId, { source: 'github', id: '7' }, true) })
  })
  it('frees the slot of a worker that asks a person a question with a progress report', async () => {
    await handsOff({ state: 'progress', summary: 'The server runs.', human_action: 'Does the button look right?' })
  })
  // Adapted: the host hears of a person working in the Session through `personWorked` (`claude-superagent open`), where DSH
  // saw a user's message claimed. Left out, DSH-only: no wait collects the job (`jobs.service.wait`).
  it('leaves the background work of a turn a person started in the worker\'s Session after a hand-off to that turn', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const session = worker(one.sessionId), query = session.running
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' }); await h.runtime.idle()
    // A person answers in the worker's Session, which the ticket does not record; the turn starts a subagent and a job.
    await sleep(5)
    h.runtime.executor.personWorked(one.ticket.id)
    const child = query.task('local_agent'), job = query.task('local_bash')
    session.end(); await h.runtime.idle()
    await sleep(10)
    // They keep the worker busy, as any turn's background work does.
    expect(query.tasks.has(child)).toBe(true)
    expect(query.stopTask).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
    query.taskEnd(child); query.taskEnd(job)
    expect(session.status).toBe('running')
  })
  // Adapted: the steps of handsOff inline, as the second server starts in a turn: the one the first server's end starts
  // (DSH started it with the worker idle). Left out, DSH-only: the wait that collects the second server.
  it('leaves the jobs a worker left to a person out of a later turn\'s background work, and does not kill them at the limit', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    const session = worker(one.sessionId), query = session.running
    const dev = query.task('local_bash', 'pnpm dev')
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    session.end(); await h.runtime.idle(); await sleep(10)
    // A second server, left too; then a note from the orchestrator wakes the worker, whose turn ends without a report.
    query.taskEnd(dev)
    const server = query.task('local_bash', 'pnpm preview')
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Preview up' }); await h.runtime.idle()
    session.end(); await h.runtime.idle()
    await sleep(5)
    expect(h.runtime.executor.activeCount()).toBe(0)
    h.runtime.engine.note(one.ticket.id, 'CI passed on the pull request.'); await h.runtime.idle()
    await vi.waitFor(() => expect(session.status).toBe('running'))
    session.end()
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
    expect(query.stopTask).not.toHaveBeenCalledWith(server)
    expect(h.runtime.executor.activeCount()).toBe(0)
  })
  it('records each end of a worker\'s turn on its Assignment, also after its ready report', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    const ready = report(one.ticket.id)!
    await sleep(5)
    worker(one.sessionId).end(); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(h.ticket(one.ticket.id))!.idleAt! > ready.at).toBe(true))
  })
  it('shows no turn end on a running Assignment whose worker works again, whatever turn ends were recorded', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    worker(one.sessionId).end()
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'progress', summary: 'On it again' })
    const page = await h.api('GET', `tickets/${one.ticket.id}`)
    expect((page.body as { assignments: Record<string, unknown>[] }).assignments[0]).not.toHaveProperty('turnEndedAt')
  })
  it('keeps a ticket open at a merge while its worker does in the background a message it acknowledged', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.ticket(one.ticket.id)
    const session = worker(one.sessionId)
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    session.end(); await h.runtime.idle()
    // A person asks for more; the worker acknowledges it, starts the work in the background and its turn ends.
    await sleep(5)
    const more = feishu('2', '再加个测试', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    await vi.waitFor(() => expect(ticket().undelivered).toEqual([]))
    await h.runTool(one.ticket.id, 'orchestrator_ack', { trigger_id: more.id, text: '收到' })
    await waitUntil(() => session.status === 'running')
    const query = session.running
    query.task('local_bash')
    session.end(); await h.runtime.idle()
    h.runtime.engine.threadClosed({ source: 'github', id: '7' }, 'merged', new Date().toISOString())
    expect(ticket().ended).toBeUndefined()
    await sleep(10)
    expect(query.stopTask).not.toHaveBeenCalled()
  })
  it('keeps a worker busy with what it started after a message reached its ready ticket', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.ticket(one.ticket.id)
    const session = worker(one.sessionId)
    // The ticket follows its pull request, so a ready report leaves it open.
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'PR ready' })
    session.end(); await h.runtime.idle()
    expect(h.runtime.executor.activeCount()).toBe(0)
    // A person asks for more; the worker starts the tests in the background and ends its turn.
    await sleep(5)
    h.runtime.receive(feishu('2', '再加个测试', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(ticket())?.deliveredAt! >= latestAssignment(ticket())!.report!.at).toBe(true))
    await waitUntil(() => session.status === 'running')
    const query = session.running
    const job = query.task('local_bash')
    session.end(); await h.runtime.idle()
    await sleep(10)
    expect(query.stopTask).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
    query.taskEnd(job); session.end()
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
  })
  it('gives each idle of a worker its own 30 minutes, not counting the turns that ends of its background work wake it for', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const session = worker(one.sessionId), query = session.running
    const first = query.task('local_bash')
    let second = ''
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      session.end()
      await minutes(20)
      // The job ends and wakes the worker, which starts another and ends its turn 5 minutes later.
      query.taskEnd(first)
      second = query.task('local_bash')
      await minutes(5)
      session.end()
      // 35 minutes after the first idle, 10 after the second.
      await minutes(10)
      expect(query.stopTask).not.toHaveBeenCalled()
      expect(report(one.ticket.id)).toBeUndefined()
      await minutes(20)
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(query.stopTask).toHaveBeenCalledWith(second))
    expect(report(one.ticket.id)?.state).toBe('waiting')
  })
})
