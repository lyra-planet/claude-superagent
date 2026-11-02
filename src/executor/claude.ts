/** The Claude Code executor: one worker Session and one directory per ticket, through the Agent SDK. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { latestAssignment, latestReport, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Executor, Ticket, TicketInput } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory, type SubprocessRuntime } from '../infra/environment.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Logger } from '../infra/log.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Variable } from '../app/execution-environment.ts'
import { resultRelay } from '../app/notices.ts'
import { AGENT_SDK, ClaudeSession, type Sdk } from '../app/session.ts'
import type { Sessions } from '../app/sessions.ts'
import { ASSIGNMENT_CHARS, BACKGROUND_LIMIT_MS, PREPARE_TIMEOUT_MS, PrepareFailed, RETRIED, SLOT_WAIT_MS, TRANSIENT_BACKOFF_MS, TRANSIENT_TRIES,
  WorkerSlots, batchLine, batchOf, capped, fromPerson, inputMessage, inputResource, sourceTrigger, ticketExecution, transient, triggerMessage,
  workerSessionId } from './common.ts'

/** Host dependencies used by `ClaudeExecutor`. */
export interface ExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'afterCommit'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry: whether handling worker Session events failed. */
  readonly health: HealthEntry
  readonly logger: Logger
  readonly machine: Pick<Machine, 'stateDir'>
  readonly subprocess: SubprocessRuntime
  readonly lifetime: AbortSignal
  readonly sessions: Pick<Sessions, 'workerStart' | 'prompt' | 'promptedId' | 'relay' | 'events'>
  closing(): boolean
  /** Whether processing is paused, which holds launches and deliveries. */
  paused(): boolean
  /** Execution environment variables of `ticket`, which its prepare command reads. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: import('../core/index.ts').Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  repliedTo(trigger: import('../core/index.ts').Trigger): import('../core/index.ts').Trigger | undefined
  /** The Agent SDK the worker Sessions call; tests pass a stand-in. */
  readonly sdk?: Sdk
}

/**
 * Runs Assignments in Claude Code Sessions, one per ticket, each in its ticket's directory. Launches and deliveries are durable
 * effects; a worker holds a slot while its turn runs and while background tasks a turn left run, at most `BACKGROUND_LIMIT_MS`
 * after the turn. A worker that is idle closes its query; the next delivery resumes the same Session. The Engine hears what the
 * Sessions do: an Assignment started, Inputs reached it, the Session took them, a turn ended, a failure, an interrupted run.
 */
export class ClaudeExecutor implements Executor {
  private readonly slots: WorkerSlots
  private readonly workers = new Map<string, ClaudeSession>()
  /** Transient failures tried so far, by `assignment.id` for turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** The Inputs handed to each ticket's Session that it has not taken into its history yet, by Input id, with their message uuid. */
  private readonly unread = new Map<string, Map<string, string>>()
  /** The timers that stop a worker's background tasks once they ran `BACKGROUND_LIMIT_MS` after its turn, by ticket. */
  private readonly limits = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => [...this.workers].flatMap(([ticketId, session]) => session.busy ? [ticketId] : []),
      () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed deliveries show on their ticket instead of on the `delivery` health entry.
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** A newly accepted ticket's execution: its short name, directory and assignment text. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /**
   * After the ending transaction commits: cut the worker's turn short unless its last word was a `ready` or `dropped` report
   * with nothing delivered since, stop its background tasks, and close its query. Its Session stays on disk for a resume.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    this.host.store.afterCommit(() => {
      const session = this.workers.get(ticket.id)
      if (!session) return
      void this.background((async () => {
        if (!ownTurn) await session.interrupt()
        for (const task of session.background) await session.stopTask(task)
        this.clearLimit(ticket.id)
        await session.close()
        this.host.logger.info('claude-superagent: stopped the worker of %s (%s)', ticket.id.slice(0, 12), reason)
      })())
    })
  }
  /** The open tickets whose worker holds a slot. */
  activeCount(): number { return [...this.workers.values()].filter(session => session.busy).length }

  /** The worker Session of a ticket, made on first use; its events reach this executor. */
  private session(ticket: Ticket): ClaudeSession {
    let session = this.workers.get(ticket.id)
    if (!session) {
      session = new ClaudeSession(workerSessionId(ticket.id), ticket.execution?.directory ?? '', () => this.host.sessions.workerStart(this.current(ticket.id) ?? ticket),
        this.host.sessions.events(`worker ${ticket.id.slice(0, 12)}`, {
          turnEnded: (_session, result, background) => { void this.background(this.turnEnded(ticket.id, result, background)) },
          ended: (_session, error) => { if (error) void this.background(this.sessionFailed(ticket.id, error)) },
        }), this.host.sdk ?? AGENT_SDK)
      this.workers.set(ticket.id, session)
    }
    return session
  }
  private current(ticketId: string): Ticket | undefined { return this.host.store.tickets.get(ticketId) }

  /** Runs `executor.prepare` for a new ticket directory with the ticket's variables, then checks the directory as a worker sees it. */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // An empty directory a failed command left would count as prepared next time.
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which its output explains. */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.subprocess, this.host.lifetime)
  }
  /** Launch a queued Assignment unless its ticket ended or a newer Assignment replaced it. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.current(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      // A failed prepare command is not tried again: what it left behind would count as a prepared directory.
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      const stored = this.current(ticketId)
      if (stored && liveTicket(stored) && latestAssignment(stored)?.id === assignmentId) this.failed(ticketId, String(error))
    } finally { this.slots.free(ticketId) }
  }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('claude-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.current(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    const session = this.session(ticket)
    // The Session an earlier Assignment left open stops first, so its turn does not take this Assignment's messages.
    if (latestAssignment(ticket) !== ticket.assignments[0] && session.open && session.busy) { await session.interrupt(); await session.close() }
    await session.openSession()
    if (!current()) return
    const first = `assignment:${ticket.id}`
    const told = ticket.assignments.length > 1 && await session.took(this.host.sessions.promptedId(session.id, first))
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const { text: brief, chars, read } = capped(ticket.execution?.assignment ?? '', ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const source = sourceTrigger(this.host, ticket)
    const card = told || !source ? undefined : triggerMessage(source, await this.host.sourceLink(source), undefined, this.host.repliedTo(source))
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    await this.host.sessions.prompt(session, ticket.assignments.length > 1 ? `assignment:${ticket.id}:${assignment.id}` : first, text, 'later')
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Hand a ticket's waiting Inputs to its running Assignment one by one, reading the ticket afresh before each. */
  private async deliverQueued(ticketId: string): Promise<void> {
    const first = this.current(ticketId)
    if (!first || !liveTicket(first) || !runningAssignment(first) || !first.undelivered.length) return
    let reserved = false
    try {
      for (;;) {
        const ticket = this.current(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        const session = this.session(ticket)
        if (!reserved && !session.busy) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          reserved = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try { if (input) await this.deliverInput(session, ticket, input) }
        catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.current(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (reserved) this.slots.free(ticketId) }
  }
  private async deliverInput(session: ClaudeSession, ticket: Ticket, input: TicketInput): Promise<void> {
    const trigger = input.kind === 'trigger' ? this.host.store.triggers.get(input.triggerId) : undefined
    const parent = trigger && this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    const card = trigger ? triggerMessage(trigger, await this.host.sourceLink(trigger), input.kind === 'trigger' ? input.note : undefined, seen ? undefined : parent) : undefined
    const message = inputMessage(input, card)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(session, input.id, text, 'next')
    if (input.kind === 'trigger') this.unreadOf(ticket.id).set(input.id, this.host.sessions.promptedId(session.id, input.id))
  }
  private unreadOf(ticketId: string): Map<string, string> {
    let unread = this.unread.get(ticketId)
    if (!unread) { unread = new Map(); this.unread.set(ticketId, unread) }
    return unread
  }

  /**
   * A worker's turn ended. The Inputs its Session took count as read. A failed turn tries again when its failure is passing.
   * A worker that handed off to a person, or whose report says it waits, frees its slot; one with background tasks keeps it
   * until they end, at most `BACKGROUND_LIMIT_MS`; then, with nothing reported, it reports waiting with its last words.
   */
  private async turnEnded(ticketId: string, result: SDKMessage, background: boolean): Promise<void> {
    const ticket = this.current(ticketId)
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    if (!ticket || !assignment || this.host.closing()) return
    const session = this.workers.get(ticketId)
    await this.markRead(ticketId, session)
    const outcome = result as { subtype?: string; is_error?: boolean; result?: string; errors?: string[] }
    if (outcome.subtype !== 'success' || outcome.is_error) {
      const error = new Error(outcome.errors?.join('; ') || outcome.result || outcome.subtype || 'The worker turn failed')
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticketId, assignment.id, error); return }
      this.failed(ticketId, String(error)); return
    }
    this.transient.delete(assignment.id)
    if (background) { this.armLimit(ticketId, assignment.id); return }
    this.clearLimit(ticketId)
    const stored = this.current(ticketId)
    if (!stored || runningAssignment(stored)?.id !== assignment.id) return
    this.host.engine.turnEnded(ticketId, assignment.id)
    if (!this.handedOff(stored)) this.reportWaiting(stored, outcome.result ?? '')
    // Nothing runs for it now: its query closes, and its next Input resumes the Session.
    if (session && !session.busy && !this.current(ticketId)?.undelivered.length) await session.close()
  }
  /** Inputs the Session's history holds now count as read. */
  private async markRead(ticketId: string, session: ClaudeSession | undefined): Promise<void> {
    const unread = this.unread.get(ticketId)
    if (!session || !unread?.size) return
    const held = new Set((await session.history()).map(message => message.uuid))
    const read = [...unread].flatMap(([inputId, uuid]) => held.has(uuid) ? [inputId] : [])
    for (const inputId of read) unread.delete(inputId)
    if (read.length && this.current(ticketId)) this.host.engine.inputsRead(ticketId, read)
  }
  /** A worker whose last word was its result, a question for a person, or a blocked or failed report, with nothing delivered since. */
  private handedOff(ticket: Ticket): boolean {
    const assignment = runningAssignment(ticket), report = assignment?.report
    const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
    return ((report?.state === 'ready' || !!ticket.attention) && !since) || waitsForPerson(ticket)
  }
  /** Report `waiting` for a turn that ended without a report since its Inputs, with its last words, and tell the router. */
  private reportWaiting(ticket: Ticket, said: string): void {
    this.host.store.atomic(() => {
      const before = latestReport(ticket)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said.trim() || before })
      if (said.trim()) this.relay(resultRelay(updated, 'waiting', said.trim()))
      else if (!before.trim()) this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
    })
  }
  /** Stop the background tasks a worker's turn left once they ran `BACKGROUND_LIMIT_MS`, and report it waiting. */
  private armLimit(ticketId: string, assignmentId: string): void {
    if (this.limits.has(ticketId)) return
    const timer = setTimeout(() => {
      this.limits.delete(ticketId)
      void this.background((async () => {
        const session = this.workers.get(ticketId), ticket = this.current(ticketId)
        if (!session || !ticket || runningAssignment(ticket)?.id !== assignmentId) return
        const tasks = session.background
        for (const task of tasks) await session.stopTask(task)
        this.host.engine.turnEnded(ticketId, assignmentId)
        const minutes = BACKGROUND_LIMIT_MS / 60_000
        if (!this.handedOff(ticket)) this.reportWaiting(ticket, `Background tasks ran ${minutes} minutes after the worker's turn ended and were stopped: ${tasks.join(', ')}.`)
      })())
    }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    this.limits.set(ticketId, timer)
  }
  private clearLimit(ticketId: string): void { const timer = this.limits.get(ticketId); if (timer) { clearTimeout(timer); this.limits.delete(ticketId) } }
  /** A worker Session's query failed: a passing failure goes on after a backoff; any other fails the ticket. */
  private async sessionFailed(ticketId: string, error: unknown): Promise<void> {
    const ticket = this.current(ticketId)
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    if (!ticket || !assignment || this.host.closing()) return
    if (this.retries(assignment.id, error)) { this.resumeAfter(ticketId, assignment.id, error); return }
    this.failed(ticketId, String(error))
  }
  /** Records a `failed` report and tells the router, in one transaction. */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  /** Counts a passing failure under `key`: true while it may be tried again. */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Tell a worker whose turn failed for a passing reason to go on, after a backoff that doubles. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.current(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) return
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      try { this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const session = this.session(ticket)
      void this.background(this.host.sessions.prompt(session, `retry:${assignmentId}:${tries}`, text, 'next')
        .finally(() => { this.slots.free(ticketId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /** Runs worker event handling in the background, and keeps the `worker` health entry on its failure or recovery. */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: new Date().toISOString() }) },
      (error: unknown) => {
        this.host.logger.warn('claude-superagent: a worker event failed: %s', String(error))
        health.set({ state: 'error', detail: String(error), at: new Date().toISOString() })
      })
  }
  /**
   * At startup: an Assignment that was running when the host stopped is interrupted, which starts it again with a recovery
   * note unless it had reported since; a pending one is launched again, oldest ticket first, unless it waits for a person.
   */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** On a host stop: stop each worker's background tasks and close its query, within ten seconds in all. */
  async shutdown(): Promise<void> {
    for (const timer of [...this.timers, ...this.limits.values()]) clearTimeout(timer)
    this.timers.clear(); this.limits.clear()
    const stops = [...this.workers.values()].map(async session => {
      for (const task of session.background) await session.stopTask(task)
      await session.close()
    })
    await Promise.race([Promise.allSettled(stops), new Promise(resolve => { setTimeout(resolve, 10_000).unref?.() })])
  }
}
