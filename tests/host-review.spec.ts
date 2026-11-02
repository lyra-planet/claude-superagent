/**
 * Host behaviours a review of the executor and the Sessions found wrong, each run on the stand-in Claude Code: a second passing
 * failure, a ticket that ends while its worker idles with a job left to a person, a hold that comes while a launch prepares, a
 * finished task that starts no turn, a delivery a hold withholds, a relay a stop leaves behind the router's turn, and a
 * directory a stop leaves half prepared.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Runtime } from '../src/app/runtime.ts'
import { feishuSource } from '../src/sources/feishu.ts'
import { githubSource } from '../src/sources/github.ts'
import { deferred, sleep, waitUntil } from './fixtures/async.ts'
import { testMachine } from './fixtures/deployment.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { vi.useRealTimers(); await h.stop() })
const flush = () => new Promise(resolve => setImmediate(resolve))
const report = (id: string) => latestAssignment(h.ticket(id))?.report
const passing = { subtype: 'error_during_execution', is_error: true, errors: ['API Error: 503 Service Unavailable'] }
const retries = (sessionId: string) => h.claude.to(sessionId).filter(message => message.text.startsWith('Your last turn failed')).length

it('goes on after each passing failure, also one that follows a turn that ended well', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId)
  const fail = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    worker.end(passing); await flush(); await vi.advanceTimersByTimeAsync(16_000); await flush()
    vi.useRealTimers()
  }
  await fail()
  await waitUntil(() => retries(one.sessionId) === 1 && worker.status === 'running')
  worker.end({ result: 'step done' })
  await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
  h.runtime.receive(feishu('2', '继续', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  await waitUntil(() => worker.status === 'running')
  await fail()
  await waitUntil(() => retries(one.sessionId) === 2 && worker.status === 'running')
})

it('closes the query of a worker that handed off with a job left once its ticket ends', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '12' }, true)
  const worker = h.claude.session(one.sessionId), query = worker.running
  worker.task('local_bash', 'pnpm dev')
  await flush()
  await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'PR #12 is open; a dev server runs.' })
  await h.runtime.idle()
  worker.end(); await h.runtime.idle(); await sleep(50)
  expect(query.closed).toBe(false)
  h.runtime.engine.stopTicket(one.ticket.id, 'done here')
  await h.runtime.idle()
  await waitUntil(() => query.closed)
  expect(query.tasks.size).toBe(0)
})

it('starts no worker on a Session a person took while its directory was prepared', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'make worktree' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  const trigger = feishu('1', '@bot 修一')
  h.runtime.receive(trigger); await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-one', acknowledgement: '收到。' })
  const ticketId = (accepted as { ticket: { ticket_id: string } }).ticket.ticket_id
  await sleep(50)
  await h.runtime.executor.hold(ticketId)
  prepare.resolve(); await h.runtime.idle(); await sleep(50)
  const sessionId = h.runtime.terminalTicket(ticketId)!.sessionId
  expect(h.claude.to(sessionId)).toEqual([])
  // Once the person leaves, the launch, which waited, starts the worker at its next try.
  h.runtime.executor.release(ticketId)
  await waitUntil(() => h.claude.to(sessionId).length > 0, 15_000)
}, 20_000)

it('ends the turn of a worker a finished task did not wake, which lets a hold through', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId), query = worker.running!
  const job = worker.task('local_bash', 'pnpm test')
  await flush()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  worker.end({ result: 'tests run in the background' }); await flush()
  // The job ends; Claude Code says so, and starts no turn.
  query.tasks.delete(job)
  query.emit({ type: 'system', subtype: 'task_notification', task_id: job, status: 'completed' } as never)
  ;(query as unknown as { emitTasks(): void }).emitTasks()
  await flush()
  await vi.advanceTimersByTimeAsync(6000); await flush()
  vi.useRealTimers()
  await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
  const session = h.runtime.sessions.worker(one.ticket.id)!
  expect(session.working).toBe(false)
  await expect(Promise.race([session.whenIdle().then(() => 'idle'), sleep(200).then(() => 'hangs')])).resolves.toBe('idle')
})

it('opens no query on a Session a person took while a delivery to it waited', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId)
  worker.end({ result: 'first turn' })
  await vi.waitFor(() => expect(report(one.ticket.id)?.state).toBe('waiting'))
  await waitUntil(() => !worker.query)
  const lookup = deferred()
  let stalled = false
  vi.mocked(Commands.prototype.lark).mockImplementation(async (args: string[]) => {
    if (args.includes('+messages-mget') && args.includes('om_2') && !stalled) { stalled = true; await lookup.promise }
    return { users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false }
  })
  const before = h.claude.queries.length
  h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' }))
  await waitUntil(() => stalled)
  await h.runtime.executor.hold(one.ticket.id)
  lookup.resolve(); await sleep(100)
  expect(h.claude.queries.length - before).toBe(0)
  expect(h.ticket(one.ticket.id).undelivered).toHaveLength(1)
})

it('hands the router, after a restart, a relay its last turn left waiting at a stop', async () => {
  const router = h.claude.session(h.runtime.masterId)
  h.runtime.sessions.relay('r1', 'first relay'); await h.runtime.idle()
  await waitUntil(() => router.status === 'running')
  h.runtime.sessions.relay('r2', 'second relay, a worker result'); await h.runtime.idle()
  const id = h.claude.to(h.runtime.masterId).find(message => message.text.includes('second relay'))!.uuid
  await h.runtime.stop()
  expect(router.taken()).not.toContain(id)
  const quietly = (kind: { kind: string }) => ({ kind, run: async () => {} })
  const reopened = new Runtime(testMachine({ stateDir: h.directory, claudeConfigDir: join(h.directory, 'claude') }), { logger: h.logger, restart: h.restart,
    subprocess: h.subprocess, sdk: h.claude.sdk, listen: false, plugins: local => [quietly(githubSource.kind), quietly(feishuSource.kind), local] as never })
  try {
    await reopened.start(); await reopened.idle()
    await waitUntil(() => router.taken().includes(id))
  } finally { await reopened.stop(); h.stop = async () => {} }
})

it('fails, saying why, a ticket whose directory a stop left half prepared', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'make worktree' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  const trigger = feishu('1', '@bot 修一')
  h.runtime.receive(trigger); await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-one', acknowledgement: '收到。' })
  const ticketId = (accepted as { ticket: { ticket_id: string } }).ticket.ticket_id
  await sleep(50)
  // The prepare command made part of the directory when the stop cut it short.
  const directory = h.ticket(ticketId).execution!.directory
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'half-checked-out'), '')
  const stopping = h.runtime.stop()
  prepare.reject(new Error('Command was killed with SIGTERM'))
  await stopping
  const quietly = (kind: { kind: string }) => ({ kind, run: async () => {} })
  const reopened = new Runtime(testMachine({ stateDir: h.directory, claudeConfigDir: join(h.directory, 'claude') }), { logger: h.logger, restart: h.restart,
    subprocess: h.subprocess, sdk: h.claude.sdk, listen: false, plugins: local => [quietly(githubSource.kind), quietly(feishuSource.kind), local] as never })
  try {
    await reopened.start(); await reopened.idle()
    await waitUntil(() => latestAssignment(reopened.store.tickets.get(ticketId)!)?.report?.state === 'failed', 15_000)
    expect(latestAssignment(reopened.store.tickets.get(ticketId)!)?.report?.summary).toMatch(/cut short/)
    expect(h.claude.to(reopened.terminalTicket(ticketId)!.sessionId)).toEqual([])
  } finally { await reopened.stop(); h.stop = async () => {} }
}, 20_000)
