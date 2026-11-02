/**
 * A worker's background work: waiting for its shell jobs and subagents, and stopping them. Ported from upstream's
 * tests/background.spec.ts, which unit-tested src/executor/background.ts on DSH's job registry and subagents. Here the
 * Executor follows the background tasks Claude Code reports for a worker's Session (`local_bash` a shell job, `local_agent` a
 * subagent) and stops one with `stopTask` (src/executor/claude.ts:397 `untilQuiet`, :418 `handOff`), so the cases run a worker on
 * the Runtime and the stand-in Claude Code, whose task ends wake an idle worker as Claude Code's do.
 *
 * Left out, as DSH-only:
 * - 'looks at the jobs only when one ends, not at each output of a noisy one': Claude Code reports no output of a background
 *   task to the host, only changes of the set of tasks.
 * - 'joins a worker's subagents once for the looks that wait on them, as DSH cannot cancel the join': the host joins nothing;
 *   it reads the tasks Claude Code reports.
 * - The cancel of 'gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke':
 *   a task the host stops starts no turn in Claude Code, so no turn of its end is left to cancel.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { vi.useRealTimers(); await h.stop() })
/** Lets the host handle what the stand-in Claude Code emitted: microtasks run, and no faked timer. */
const flush = async (times = 1) => { for (let round = 0; round < times; round++) await new Promise(resolve => setImmediate(resolve)) }
const report = (ticketId: string) => latestAssignment(h.ticket(ticketId))?.report

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  // Adapted: the worker's turn ends with a job running, so the Executor looks at its background work; the job ends meanwhile,
  // and its end wakes the worker.
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId), query = worker.running
  const job = worker.task('local_bash', 'npm test')
  await flush()
  worker.end(); await h.runtime.idle(); await flush()
  expect(h.runtime.executor.activeCount()).toBe(1)
  query.taskEnd(job)
  await h.runtime.idle(); await flush()
  // Not quiet: the turn the end woke is the worker's, which nothing ended or reported for.
  expect(worker.status).toBe('running')
  expect(report(one.ticket.id)).toBeUndefined()
  // That turn's own idle looks again, and finds nothing running.
  worker.end(); await h.runtime.idle()
  await vi.waitFor(() => expect(report(one.ticket.id)).toMatchObject({ state: 'waiting' }))
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  // Adapted: the look is not quiet when it ends: it ends no turn, and the worker reports nothing.
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId)
  worker.task('local_agent', 'Review the change')
  await flush()
  worker.end(); await h.runtime.idle(); await flush()
  // The look waits for the subagent, which never settles by itself.
  expect(h.runtime.executor.activeCount()).toBe(1)
  const turnEnded = vi.spyOn(h.runtime.engine, 'turnEnded'), reported = vi.spyOn(h.runtime.engine, 'report')
  await h.runtime.stop()
  expect(turnEnded).not.toHaveBeenCalled()
  expect(reported).not.toHaveBeenCalled()
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  // Adapted: the release is the stop (`stopTask`) of the subagents of a worker that hands off to a person; while it runs, the
  // person's answer waits for it, and reaches the worker once it is given up.
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId), query = worker.running
  worker.task('local_agent', 'Review the change')
  await flush()
  const stopTask = query.stopTask.getMockImplementation()!
  query.stopTask.mockImplementation(() => new Promise(() => {}))
  await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' }); await h.runtime.idle()
  const answered = () => h.claude.to(one.sessionId).some(message => message.text.includes('蓝色'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    worker.end(); await flush(5)
    expect(query.stopTask).toHaveBeenCalled()
    h.runtime.receive(feishu('2', '蓝色', { mentions: [], root_id: 'om_1' }))
    await vi.advanceTimersByTimeAsync(9_999); await flush(5)
    expect(answered()).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await flush(5)
    expect(answered()).toBe(true)
  } finally {
    vi.useRealTimers()
    // The host's own stop at the end of the case stops the subagent as the stand-in does.
    query.stopTask.mockImplementation(stopTask)
  }
})
