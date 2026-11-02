/**
 * Ported from upstream's tests/runtime-concurrency.spec.ts, from 'kills the jobs that run 30 minutes after the turn ended…'
 * to its end: hand-offs, background work, its limit, stops, shutdown and restarts, what a worker read, and the Executor's parts.
 *
 * Left out, as DSH-only mechanics:
 * - 'sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn
 *   ended': in Claude Code a message that waits as a turn ends starts the next turn, which takes it (src/app/session.ts:240,
 *   tests/fixtures/claude.ts `end`), so no delivered message is left untaken at a turn's end.
 *
 * Upstream's in-process restart (`executor.resume()` while DSH's Sessions ran on) is a stop of this Runtime and a start of
 * another on the same state directory here (src/cli.ts:101): `restart()` below; a crash is `crash()`.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Later } from '../src/app/effects.ts'
import { reportRelay } from '../src/app/notices.ts'
import { Runtime } from '../src/app/runtime.ts'
import { ClaudeSession } from '../src/app/session.ts'
import { latestAssignment, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
import { WorkerSlots, inputMessage, mandateInstructions, ticketExecution, transient, triggerMessage } from '../src/executor/common.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuSource } from '../src/sources/feishu.ts'
import { githubSource } from '../src/sources/github.ts'
import type { SourcePlugin } from '../src/sources/kind.ts'
import { deferred, sleep, waitUntil } from './fixtures/async.ts'
import type { FakeQuery } from './fixtures/claude.ts'
import { testMachine } from './fixtures/deployment.ts'
import { MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
/** The Runtime a restart opened, if any. */
let reopened: Runtime | undefined
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await reopened?.stop(); reopened = undefined; await h.stop() })
const lark = { users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false }
/** Lets the host handle what the stand-in Claude Code emitted: microtasks run, and no faked timer. */
const flush = () => new Promise(resolve => setImmediate(resolve))
const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000)
const report = (ticketId: string, runtime: Runtime = h.runtime) => latestAssignment(runtime.store.tickets.get(ticketId)!)?.report
/** The order of the calls of a mock, by the vitest-wide invocation counter. */
const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder

/** A Runtime on the state directory of `h`, on the same stand-in Claude Code, whose Sessions outlive a Runtime as files on disk do. */
async function reopen(): Promise<Runtime> {
  const quietly = (kind: SourcePlugin['kind']): SourcePlugin => ({ kind, run: async () => {} })
  reopened = new Runtime(testMachine({ stateDir: h.directory, claudeConfigDir: join(h.directory, 'claude') }), { logger: h.logger, restart: h.restart,
    subprocess: h.subprocess, sdk: h.claude.sdk, listen: false, plugins: local => [quietly(githubSource.kind), quietly(feishuSource.kind), local] })
  await reopened.start()
  return reopened
}
/** The host restarts: this Runtime stops, as a restart stops it, and another opens what it stored. */
async function restart(): Promise<Runtime> { await h.runtime.stop(); return reopen() }
/** The process dies: Claude Code's processes end with it, no stop of its own reaches them, and another Runtime opens what it stored. */
async function crash(): Promise<Runtime> {
  for (const query of h.claude.queries) if (!query.closed) query.close()
  await h.runtime.stop()
  return reopen()
}

describe('a worker whose work runs in the background', () => {
  /**
   * A worker that hands off to a person, with `report`, frees its slot and stops its subagents; its job, a server for the
   * person, runs on. Adapted: the job's end wakes the worker, as Claude Code's ends do; the turn it wakes is one of its own,
   * in which it reads of the end, and it hands off again. With `woken`, the woken turn is left running for the caller.
   */
  async function handsOff(report: Record<string, unknown>, before?: (ticketId: string) => void, woken = false) {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    before?.(one.ticket.id)
    const worker = h.claude.session(one.sessionId), query = worker.running
    const job = worker.task('local_bash', 'pnpm dev'), child = worker.task('local_agent', 'Review the change')
    await flush()
    await h.runTool(one.ticket.id, 'orchestrator_report', report); await h.runtime.idle()
    const relayed = h.relays(h.runtime.masterId).length
    worker.end(); await h.runtime.idle()
    // The subagent stops; the job is left to the person, and holds no slot.
    await vi.waitFor(() => expect(query.tasks.has(child)).toBe(false))
    expect(query.stopTask).toHaveBeenCalledWith(child)
    expect(worker.status).toBe('idle')
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(query.stopTask).not.toHaveBeenCalledWith(job)
    query.taskEnd(job)
    expect(worker.status).toBe('running')
    if (woken) return { ...one, worker, query }
    worker.end(); await h.runtime.idle()
    await vi.waitFor(() => expect(worker.status).toBe('idle'))
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
    expect(report && latestAssignment(h.ticket(one.ticket.id))?.report).toMatchObject({ state: report.state })
    return { ...one, worker, query }
  }

  it('kills the jobs that run 30 minutes after the turn ended, leaving its subagents, and reports waiting after the worker\'s words', async () => {
    // Adapted: Claude Code stops a background task (`stopTask`) where DSH killed a job, so the texts say "stopped"; the worker's
    // words are its turn's result.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const worker = h.claude.session(one.sessionId), query = worker.running
    const job = worker.task('local_bash', 'pnpm test\n  --watch=false'), child = worker.task('local_agent', 'Review the change')
    await flush()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      worker.end({ result: 'The tests run in the background.' })
      await flush()
      await minutes(29)
      expect(report(one.ticket.id)).toBeUndefined()
      await minutes(1)
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(report(one.ticket.id)).toMatchObject({ state: 'waiting', summary: 'The tests run in the background.\n\n'
      + `Background jobs ran 30 minutes after the worker's turn ended and were stopped: ${job} (pnpm test).` }))
    expect(query.stopTask).toHaveBeenCalledWith(job)
    // The worker reads of the stop at its next turn.
    expect(h.claude.to(one.sessionId)).toContainEqual(expect.objectContaining({ delivery: 'inject',
      text: `Your background jobs ran 30 minutes after your turn ended and were stopped: ${job} (pnpm test).` }))
    // Stopping its subagent would end it in the Assignment it was just reported waiting in.
    expect(query.stopTask).not.toHaveBeenCalledWith(child)
    expect(query.tasks.has(child)).toBe(true)
    expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'waiting' })
  })
  it('says a worker\'s subagents still run when only they ran 30 minutes after the turn ended', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const worker = h.claude.session(one.sessionId)
    worker.task('local_agent', 'Review the change')
    await flush()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { worker.end(); await flush(); await minutes(30) } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(report(one.ticket.id)).toMatchObject({ state: 'waiting',
      summary: 'Subagents still ran 30 minutes after the worker\'s turn ended.' }))
  })
  it('holds a delivery that reached a worker while a hand-off stopped its subagents until the stop ended', async () => {
    // Adapted: the message is held on its way in at its source link lookup, between the delivery's checks, where DSH held it at
    // the Session's resolution; the hand-off's stop of the subagent is a slow `stopTask`, where DSH drained it.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const worker = h.claude.session(one.sessionId), query = worker.running
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    worker.task('local_agent', 'Review the change')
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    // A person's message is on its way into the worker's Session, held there, as the worker hands off; the stop is slow.
    const events: string[] = []
    const lookup = deferred(), drain = deferred(), stopTask = query.stopTask.getMockImplementation()!
    query.stopTask.mockImplementationOnce(async id => { await drain.promise; await stopTask(id); events.push('stopped') })
    h.claude.pushed.mockImplementation(message => { if (message.sessionId === one.sessionId && message.text.includes('按钮再大一点')) events.push('delivered') })
    await sleep(5)
    let held = false
    vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
      if (args.includes('+messages-mget') && args.includes('om_2') && !held) { held = true; await lookup.promise }
      return lark
    })
    h.runtime.receive(feishu('2', '按钮再大一点', { mentions: [], root_id: 'om_1' }))
    await waitUntil(() => held)
    worker.end()
    await vi.waitFor(() => expect(query.stopTask).toHaveBeenCalled())
    lookup.resolve()
    await sleep(20)
    drain.resolve()
    // The message reaches the worker after the stop ended.
    await waitUntil(() => events.includes('delivered'), 5000)
    expect(events).toEqual(['stopped', 'delivered'])
  })
  it('keeps an Input a restart found handed over to a settled worker, and delivers a waiting one once its subagents stopped', async () => {
    // Adapted: a worker settles with a subagent still running at the limit; a message handed over and not taken waits in the
    // Session's ledger, where DSH's inbox held it; the restart's stop of the subagent (`stopTask`) is slow.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const worker = h.claude.session(one.sessionId), query = worker.running
    worker.task('local_agent', 'Review the change')
    await flush()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { worker.end(); await flush(); await minutes(30) } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
    // One Input waits in the Session, handed over, another in the ticket.
    await h.runtime.sessions.prompt(h.runtime.sessions.worker(one.ticket.id)!, 'taken-later', 'Handed over', 'inject')
    const handed = h.runtime.sessions.promptedId(one.sessionId, 'taken-later')
    const stored = h.ticket(one.ticket.id)
    stored.inputs.push({ id: 'input-late', kind: 'text', text: 'One more thing', at: new Date().toISOString() })
    stored.undelivered.push('input-late')
    h.runtime.store.tickets.save(stored)
    const gate = deferred(), stopTask = query.stopTask.getMockImplementation()!
    query.stopTask.mockImplementationOnce(async id => { await gate.promise; await stopTask(id) })
    // Distinct reports: the router's untaken ones go in again when the restarted service opens it.
    const reports = () => new Set(h.claude.to(h.runtime.masterId).filter(message => message.text.includes('"kind":"worker_report"')).map(message => message.uuid)).size
    const reported = reports()
    // The delivery waits for the stop.
    const restarting = restart()
    await sleep(20)
    const late = expect.objectContaining({ sessionId: one.sessionId, text: expect.stringContaining('One more thing') })
    expect(h.claude.pushed).not.toHaveBeenCalledWith(late)
    const before = h.claude.to(one.sessionId).length
    gate.resolve()
    const next = await restarting
    await vi.waitFor(() => expect(h.claude.pushed).toHaveBeenCalledWith(late))
    // The message handed over before is handed over again: the stop let go of nothing.
    expect(h.claude.to(one.sessionId).slice(before).map(message => message.uuid)).toContain(handed)
    // The stop of the subagent reports nothing.
    await next.idle()
    expect(reports()).toBe(reported)
  })
  it('collects the end of a job left to a person until dsh-superagent stopped its workers', async () => {
    // Adapted: the turn the first job's end woke starts the second server and hands off again; the server ends as the host
    // stops it, which wakes the worker in Claude Code, and the host hands it nothing and ends its query.
    const one = await handsOff({ state: 'blocked', summary: 'Which color?' }, undefined, true)
    const { worker, query } = one
    const server = worker.task('local_bash', 'pnpm dev')
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'blocked', summary: 'Which size?' }); await h.runtime.idle()
    worker.end(); await h.runtime.idle()
    await vi.waitFor(() => expect(h.runtime.executor.activeCount()).toBe(0))
    expect(query.stopTask).not.toHaveBeenCalledWith(server)
    // The server ends while the host stops, as it stops the worker's tasks.
    query.stopTask.mockImplementationOnce(async id => { query.taskEnd(id) })
    const handed = h.claude.to(one.sessionId).length
    await h.runtime.stop()
    expect(h.claude.to(one.sessionId)).toHaveLength(handed)
    expect(worker.status).toBe('idle')
  })
  it('stops every worker\'s jobs and subagents when dsh-superagent stops, before it releases their tool limits', async () => {
    // Adapted: the worker's tools end with its query, which the host closes after the stops.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const worker = h.claude.session(one.sessionId), query = worker.running
    const job = worker.task('local_bash'), child = worker.task('local_agent', 'Review the change')
    await flush()
    await h.runtime.stop()
    expect(query.stopTask).toHaveBeenCalledWith(job)
    expect(query.stopTask).toHaveBeenCalledWith(child)
    expect(query.tasks.size).toBe(0)
    expect(Math.max(...order(query.stopTask))).toBeLessThan(order(query.close)[0]!)
  })
  it('cancels no worker for a subagent that ended before, and cancels the turn a release woke also when the release fails', async () => {
    // Adapted: a cancel is the query's `interrupt` or its `close`; a release is `stopTask`.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const worker = h.claude.session(one.sessionId), query = worker.running
    worker.taskEnd(worker.task('local_agent', 'Review the change'))
    // Its ready report ends the ticket, and it ends its own turn.
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Done' })
    await h.runtime.idle(); await sleep(10)
    expect(query.interrupt).not.toHaveBeenCalled()
    expect(query.close).not.toHaveBeenCalled()
    worker.end()
    // A release that fails after the end woke the worker still cancels that turn.
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    const other = h.claude.session(two.sessionId), otherQuery: FakeQuery = other.running
    other.task('local_agent', 'Review the change')
    await flush()
    otherQuery.stopTask.mockImplementationOnce(async id => { otherQuery.taskEnd(id); throw new Error('ACTIVATION_TEARDOWN_FAILED') })
    h.runtime.engine.stopTicket(two.ticket.id)
    await vi.waitFor(() => expect(otherQuery.stopTask).toHaveBeenCalled())
    await vi.waitFor(() => expect(order(otherQuery.close).at(-1)).toBeGreaterThan(order(otherQuery.stopTask).at(-1)!))
    expect(other.status).toBe('idle')
  })
  it('stops the jobs and the turn of a worker a restart in this process left running, before its Assignment starts again', async () => {
    // Adapted: the restart is a stop of this Runtime and a start of another; the cut keeps what the Session was handed in its ledger.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const worker = h.claude.session(one.sessionId), query = worker.running
    const job = worker.task('local_bash')
    await flush()
    const next = await restart()
    expect(query.interrupt).toHaveBeenCalled()
    expect(query.stopTask).toHaveBeenCalledWith(job)
    await next.idle()
    const relaunch = h.claude.sdk.query.mock.calls.findLastIndex(([call]) => (call as { options: { resume?: string } }).options.resume === one.sessionId)
    expect(relaunch).toBeGreaterThan(-1)
    expect(order(query.stopTask)[0]!).toBeLessThan(order(h.claude.sdk.query)[relaunch]!)
    expect(next.store.tickets.get(one.ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
  })
  it('stops a ticket whose worker Session was never created without a health error, and goes on past a failing kill', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    const first = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const queued = await h.acceptedTicket(feishu('5', '@bot 修二'))
    // Adapted: no Session of it exists, neither in the host nor in Claude Code; the host asks Claude Code nothing of it.
    expect(h.runtime.sessions.worker(queued.ticket.id)).toBeUndefined()
    expect(h.claude.session(queued.sessionId).query).toBeUndefined()
    h.runtime.engine.stopTicket(queued.ticket.id); await h.runtime.idle()
    await sleep(10)
    expect(h.runtime.health.worker?.state).not.toBe('error')
    // A stop that fails leaves the other jobs to be stopped. Adapted: the SDK's stopTask fails by rejecting.
    const worker = h.claude.session(first.sessionId), query = worker.running
    const [one, two] = [worker.task('local_bash'), worker.task('local_bash')]
    await flush()
    query.stopTask.mockImplementationOnce(async () => { throw new Error('No such process') })
    h.runtime.engine.stopTicket(first.ticket.id)
    await vi.waitFor(() => expect(query.stopTask).toHaveBeenCalledWith(two))
    expect(query.stopTask).toHaveBeenCalledWith(one)
  })
})
describe('what a worker read', () => {
  const later = () => sleep(5)
  /** A ticket its worker completed, and a person's thanks on its thread, which resumes it once received. */
  async function completed() {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Done' }); await h.runtime.idle()
    h.claude.session(one.sessionId).end()
    await later()
    return { one, thanks: feishu('2', '@bot 谢谢', { root_id: 'om_1' }), ticket: () => h.ticket(one.ticket.id) }
  }
  /** Deliveries to the worker Session `sessionId` of a message with `text` fail until the returned function lets them through. */
  function failing(sessionId: string, text: string) {
    let fail = true
    const send = ClaudeSession.prototype.send
    vi.spyOn(ClaudeSession.prototype, 'send').mockImplementation(function (this: ClaudeSession, ...args: Parameters<ClaudeSession['send']>) {
      if (fail && this.id === sessionId && args[1].includes(text)) return Promise.reject(new Error('Session busy'))
      return send.apply(this, args)
    })
    return () => { fail = false }
  }
  /** Runs `then` after the delivery retry, two seconds on; the clock moves on only by `vi.setSystemTime`. */
  async function retried(then: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
    try { await h.runtime.pump(); await h.runtime.idle(); await then(); await h.runtime.pump(); await h.runtime.idle() }
    finally { vi.useRealTimers() }
  }
  const triggerInput = (ticket: Ticket, triggerId: string) =>
    ticket.inputs.find(item => item.kind === 'trigger' && item.triggerId === triggerId) as { readAt?: string | null; deliveredTo?: string } | undefined

  it('sends to Eval a message that woke a ticket and that a retry delivered after a progress report, at a dropped report', async () => {
    const { one, thanks, ticket } = await completed()
    const pass = failing(one.sessionId, '谢谢')
    h.runtime.receive(thanks); await h.runtime.idle()
    expect(ticket().delivery).toBeDefined()
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'progress', summary: 'Looking' })
    pass()
    // The retry hands the message in while the worker writes that nothing is left, and no step takes it before.
    await retried(async () => {
      expect(ticket().undelivered).toEqual([])
      await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    })
    expect(h.candidates()).toContain(thanks.id)
  })
  it('counts a delivered message as read only once its step took it into the Session, not when a cut-off step claimed it', async () => {
    // Adapted: no step of Claude Code claims a message apart from taking it (its replay), so none is cut off between the two
    // (upstream's `h.claim`): a delivered message no step took is not read, and is once a step takes it.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const more = feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    const input = () => triggerInput(h.ticket(one.ticket.id), more.id)!
    await vi.waitFor(() => expect(input().readAt).toBe(null))
    await h.runtime.idle(); await later()
    expect(input().readAt).toBe(null)
    h.claude.session(one.sessionId).step()
    await vi.waitFor(() => expect(input().readAt).toEqual(expect.any(String)))
  })
  it('keeps a note waiting in a worker\'s Session across an in-process restart, for the next Assignment\'s first step', async () => {
    // Adapted: the restart cuts the worker's turn short with the note waiting, which Claude Code takes as the next turn starts;
    // the Session holds it once, and it is handed over once.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.note(one.ticket.id, 'Ticket B changes the same page.'); await h.runtime.idle()
    const copies = () => h.claude.to(one.sessionId).filter(message => message.text.includes('Ticket B changes the same page.'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    const next = await restart()
    await next.idle()
    await vi.waitFor(() => expect(h.claude.session(one.sessionId).taken()).toContain(copies()[0]!.uuid))
    expect(h.claude.session(one.sessionId).taken().filter(uuid => uuid === copies()[0]!.uuid)).toHaveLength(1)
    expect(copies()).toHaveLength(1)
  })
  it('delivers once a message a crash left waiting in a worker\'s Session, which the restart puts back for the next Assignment', async () => {
    // Adapted: the crash ends Claude Code's processes with the message untaken, which the Session's ledger keeps, where DSH's
    // persisted inbox did.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    const copies = () => h.claude.to(one.sessionId).filter(message => message.text.includes('再改一下'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    const before = h.claude.to(one.sessionId).length
    const next = await crash()
    await vi.waitFor(() => expect(copies()).toHaveLength(2))
    await next.idle(); await later()
    expect(copies()).toHaveLength(2)
    // The launch's message found no copy of it waiting, which its step would take beside the copy delivered after.
    const after = h.claude.to(one.sessionId).slice(before)
    const launch = after.findIndex(message => message.delivery === 'later')
    expect(launch).toBeGreaterThan(-1)
    expect(after.slice(0, launch).map(message => message.uuid)).not.toContain(copies()[0]!.uuid)
  })
  it('gives the Assignment an in-process restart starts a message a cut-off step had claimed, once', async () => {
    // Adapted: no step claims a message apart from taking it; the restart cuts the turn short with the message waiting. Its
    // worker gets it once, and it counts as read for the Assignment the restart started.
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const more = feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    const sent = () => h.claude.to(one.sessionId).filter(message => message.text.includes('再改一下'))
    await vi.waitFor(() => expect(sent()).toHaveLength(1))
    const next = await restart()
    await next.idle(); await later()
    const uuid = sent()[0]!.uuid
    expect(h.claude.session(one.sessionId).taken().filter(id => id === uuid)).toHaveLength(1)
    const ticket = next.store.tickets.get(one.ticket.id)!
    expect(triggerInput(ticket, more.id)).toMatchObject({ deliveredTo: latestAssignment(ticket)!.id, readAt: expect.any(String) })
  })
  it('counts a message that woke a ticket as read by a later dropped report once a step of its worker took it', async () => {
    const { one, thanks } = await completed()
    // The resumed Assignment's message wakes the worker; its next step takes the note that it resumed and the message.
    h.runtime.receive(thanks); await h.runtime.idle()
    h.claude.session(one.sessionId).step()
    await later()
    await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    await h.runtime.pump(); await h.runtime.idle()
    expect(h.candidates()).not.toContain(thanks.id)
  })
  it('counts a message a retry delivered to its idle worker as read by the report of the turn it woke', async () => {
    const { one, thanks, ticket } = await completed()
    const pass = failing(one.sessionId, '谢谢')
    h.runtime.receive(thanks); await h.runtime.idle()
    // Adapted: what reached the worker waits for its next step, which takes it before the turn ends (else it starts the next).
    const worker = h.claude.session(one.sessionId)
    worker.step(); worker.end()
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    pass()
    // The retry wakes the worker, whose first step takes the message.
    await retried(async () => {
      expect(worker.status).toBe('running')
      vi.setSystemTime(Date.now() + 1000)
      await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    })
    expect(h.candidates()).not.toContain(thanks.id)
  })
})
it('reports nothing for a worker whose turn ends while it waits out the backoff of a passing failure', async () => {
  // Adapted: Claude Code ends a turn whose model call failed for a passing reason with an error result, so the turn's end
  // comes with its failure.
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const relayed = h.relays(h.runtime.masterId).length
  h.claude.session(one.sessionId).end({ subtype: 'error_during_execution', is_error: true, errors: ['API Error: 503 Service Unavailable'] })
  await h.runtime.idle()
  await sleep(20)
  expect(report(one.ticket.id)).toBeUndefined()
  expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
})
it('wakes an idle worker for a status request in the slot kept for a person, while every other slot is taken', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  // Its worker ended its turn without a report, so it waits.
  h.claude.session(one.sessionId).end()
  await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.claude.session(two.sessionId).status).toBe('running')
  expect(h.runtime.engine.requestStatus(one.ticket.id)).toBe(true); await h.runtime.idle()
  expect(h.ticket(one.ticket.id).undelivered).toEqual([])
  expect(h.claude.session(one.sessionId).status).toBe('running')
})
it('tells a passing failure of the provider or the network from one that a later try would meet again', () => {
  for (const error of [Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { status: 503 }),
    Object.assign(new Error('connect'), { code: 'ECONNRESET' }), new TypeError('fetch failed'), new Error('getaddrinfo EAI_AGAIN api.example.com')]) {
    expect(transient(error)).toBe(true)
  }
  for (const error of [Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 401 }), new Error('context too long'), 'LlmError: offline']) {
    expect(transient(error)).toBe(false)
  }
})
it('reports a worker waiting when its turn ends after a person answered its blocked report', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' })
  // The person answers later than the report.
  await sleep(5)
  h.runtime.receive(feishu('2', '蓝色', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  const ticket = () => h.ticket(one.ticket.id)
  expect(waitsForPerson(ticket())).toBe(false)
  // Adapted: the answer waits for the worker's next step, which takes it before the turn ends (else it starts the next).
  const worker = h.claude.session(one.sessionId)
  worker.step(); worker.end()
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
})

it('resumes an ended ticket a person wrote to during a pause once it lifts, under the Policy then', async () => {
  const pass = async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
    try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  }
  const ended = async (id: string) => {
    const { ticket } = await h.acceptedTicket(feishu(id, `@bot 修${id}`, { root_id: `om_${id}` }))
    await h.runTool(ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
    return ticket.id
  }
  const first = await ended('1'), second = await ended('3')
  const followUp = async (id: string, root: string) => {
    await h.runtime.settings.pause(true, 'panel')
    h.runtime.receive(feishu(id, '再改一下', { mentions: [], root_id: root })); await h.runtime.idle()
  }
  // While processing is paused, the message waits on the ended ticket; the first pass after the pause resumes it.
  await followUp('2', 'om_1')
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ ended: expect.anything(), undelivered: [expect.any(String)] })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'running' })] })
  expect(h.runtime.store.tickets.get(first)).not.toHaveProperty('ended')
  // A Mandate the Policy no longer holds when the pause lifts does not resume: its sender left the list meanwhile.
  await followUp('4', 'om_3')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu!, allowed: [] } } } })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(second)).toMatchObject({ ended: expect.anything(), undelivered: [] })
})

it('ends a worker\'s turn only when the stop that ended its Assignment commits', async () => {
  // Adapted: the worker's turn is cut with the query's `interrupt`, where DSH cancelled its agent.
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const query = h.claude.session(one.sessionId).running
  expect(() => h.runtime.store.atomic(() => { h.runtime.engine.stopTicket(one.ticket.id); throw new Error('rolled back') })).toThrow('rolled back')
  expect(query.interrupt).not.toHaveBeenCalled()
  expect(h.ticket(one.ticket.id).ended).toBeUndefined()
  h.runtime.engine.stopTicket(one.ticket.id)
  expect(query.interrupt).toHaveBeenCalledOnce()
})

describe('the Executor\'s parts', () => {
  it('holds one worker slot per ticket that runs or starts, and lets launches take the slots no worker or wake holds', () => {
    const running = ['t1']
    const slots = new WorkerSlots(() => running, () => 3)
    slots.reserve('t2', 'launch')
    slots.reserve('t3', 'wake')
    expect(slots.used()).toBe(3)
    // launches() excludes 'launch' reservations because the launch queue tracks active launches separately.
    expect(slots.launches()).toBe(1)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    expect(() => slots.reserve('t3', 'wake')).not.toThrow()
    slots.free('t3')
    expect(slots.used()).toBe(2)
    slots.reserve('t4', 'launch')
    expect(slots.used()).toBe(3)
  })
  it('wakes a worker for a person\'s message in the one slot beyond the limit, and ahead of launches once a slot frees up', () => {
    const running = ['t1', 't2', 't3']
    const slots = new WorkerSlots(() => running, () => 3)
    expect(() => slots.reserve('t4', 'launch')).toThrow(Later)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    slots.reserve('t5', 'person')
    expect(slots.used()).toBe(4)
    expect(slots.launches()).toBeLessThanOrEqual(0)
    // No second person's wake fits beyond the limit; once a worker ends, it does, while a launch still waits.
    expect(() => slots.reserve('t6', 'person')).toThrow(Later)
    running.splice(0, 1)
    expect(() => slots.reserve('t7', 'launch')).toThrow(Later)
    slots.reserve('t6', 'person')
    expect(slots.used()).toBe(4)
  })
  it('words an assignment, and the limits an inferred mandate sets, from the ticket alone', () => {
    const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true,
      instruction: 'Fix typos only.' }] } })
    const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
      mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules: ['copy'] }, actor: { source: 'github', id: 'alice' },
        scope: '' } } as unknown as Ticket
    const execution = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' } as never,
      settings, '/state')
    expect(execution).toEqual(expect.objectContaining({ name: 'fix-typo-ticket-01234' }))
    expect(execution).not.toHaveProperty('session')
    // The source Trigger goes with the assignment, so the text does not point at it.
    expect(execution.assignment).toContain('Scope: the typo.')
    expect(execution.assignment).not.toContain('trigger/tr1')
    expect(ticketExecution({ ...ticket, mandate: { ...ticket.mandate, strength: 'explicit' } } as Ticket,
      { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'r', name: 'fix-login', note: 'the login page' } as never, settings, '/state').assignment)
      .toBe('Routing note (not the source request): the login page')
    // The worker's system prompt holds the limits an inferred Mandate sets, so the assignment does not repeat them.
    expect(execution.assignment).not.toContain(mandateInstructions(ticket.mandate))
    expect(execution.assignment).toContain('- Copy fixes (copy): Fix typos only.')
    expect(mandateInstructions({ strength: 'explicit' })).toBe('')
  })
  it('renders each kind of Input as its worker reads it, inline, and no reopen Input', () => {
    const asked = { id: 'tr1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Which page?', meta: {} } as Trigger
    const reply = { ...asked, id: 'tr2', text: 'The login page. '.repeat(50) }
    const card = triggerMessage(reply, { source_url: 'https://x' }, 'see the log', asked)
    expect(card).toEqual({ trigger_id: 'tr2', from: 'ou_a', thread: 'feishu:oc:om_1', at: '2026-09-01T00:00:00Z', text: expect.stringMatching(/^The login page\./),
      chars: reply.text.length, read: 'trigger/tr2', source_url: 'https://x', routing_note: 'see the log', replies_to: { trigger_id: 'tr1', preview: 'Which page?' } })
    expect(card.text).toHaveLength(601)
    expect(triggerMessage(asked, {})).toEqual({ trigger_id: 'tr1', from: 'ou_a', thread: 'feishu:oc:om_1', at: asked.at, text: 'Which page?' })
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: '' }, card)!)).toEqual(card)
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'gone', at: '' })!)).toEqual({ trigger_id: 'gone', read: 'trigger/gone' })
    expect(inputMessage({ id: 'i2', kind: 'text', at: '', text: 'Please also update the docs' })).toBe('Please also update the docs')
    // A Policy change says what it means for the ticket, without version hashes.
    const changed = inputMessage({ id: 'i3', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { requesterAllowed: false,
      requester: { source: 'github', id: 'ci-bot' },
      rules: [{ id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix typos only.' }, { id: 'visual', name: 'Visual', change: 'disabled' }] } })!
    expect(changed).toContain('Rule Copy fixes (copy), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: Fix typos only.')
    expect(changed).toContain('Rule Visual (visual), which this ticket was accepted under, no longer applies')
    // The sender is named, a bot as a person.
    expect(changed).toContain('The sender this ticket is for, ci-bot on github, may no longer start work here')
    expect(changed).not.toContain('person')
    expect(changed).not.toContain('v2')
    const mode = inputMessage({ id: 'i6', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { proactive: false } })!
    expect(mode).toContain('Work inferred from a rule is no longer accepted, as the accept mode is no longer auto')
    expect(mode).not.toContain('sender')
    expect(inputMessage({ id: 'i5', kind: 'resumed', at: '', triggerId: 'tr2' })).not.toContain('tr2')
    expect(inputMessage({ id: 'i4', kind: 'reopen', at: '' } as never)).toBeUndefined()
  })
  it('relays a worker\'s question, result or answer to the main Session, and keeps its progress internal', () => {
    const ticket = { id: 't1', title: 'Fix', updatedAt: '2026-09-01T00:00:00Z', attention: { id: 'a1', question: 'Which color?' }, assignments: [],
      mandate: { strength: 'explicit' }, origin: { triggerId: 'tr1' } } as unknown as Ticket
    expect(reportRelay(ticket, { state: 'progress', summary: 'halfway' })).toBeUndefined()
    expect(reportRelay(ticket, { state: 'blocked', summary: 'need input', question: 'Which color?' }))
      .toMatchObject({ id: 'attention:t1:a1', text: expect.stringContaining('"kind":"worker_attention"') })
    const ready = reportRelay({ ...ticket, attention: undefined } as unknown as Ticket, { state: 'ready', summary: 'Done',
      answers: 'tr9' })!
    expect(ready.id).toMatch(/^report:/)
    expect(JSON.parse(ready.text)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: 't1' }, trigger_id: 'tr1', state: 'ready', answer_to: 'tr9', summary: 'Done' })
  })
})
