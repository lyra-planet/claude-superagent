/** The Claude Code executor: one worker Session and one directory per ticket, through the Agent SDK. */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { latestAssignment, latestReport, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Executor, Ticket, TicketInput, Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory, type SubprocessRuntime } from '../infra/environment.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Logger } from '../infra/log.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Variable } from '../app/execution-environment.ts'
import { resultRelay } from '../app/notices.ts'
import { subagent, type ClaudeSession } from '../app/session.ts'
import type { Sessions } from '../app/sessions.ts'
import { KV } from '../kv.ts'
import { ASSIGNMENT_CHARS, BACKGROUND_LIMIT_MS, PREPARE_TIMEOUT_MS, PrepareFailed, RETRIED, SHUTDOWN_STOP_MS, SLOT_WAIT_MS, TRANSIENT_BACKOFF_MS,
  TRANSIENT_TRIES, WorkerSlots, batchLine, batchOf, capped, fromPerson, inputMessage, inputResource, sourceTrigger, ticketExecution, transient,
  triggerMessage } from './common.ts'

const now = (): string => new Date().toISOString()
/** `work`, or false once `signal` aborts or `ms` pass first. */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  timer?.unref?.()
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}

/** Host dependencies used by `ClaudeExecutor`. */
export interface ExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'afterCommit' | 'get' | 'set'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry: whether handling worker Session events failed. */
  readonly health: HealthEntry
  readonly logger: Logger
  readonly machine: Pick<Machine, 'stateDir'>
  readonly subprocess: SubprocessRuntime
  readonly lifetime: AbortSignal
  readonly sessions: Pick<Sessions, 'worker' | 'prompt' | 'promptedId' | 'relay'>
  closing(): boolean
  /** Whether processing is paused, which holds launches and deliveries. */
  paused(): boolean
  /** Execution environment variables of `ticket`, which its prepare command reads. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  repliedTo(trigger: Trigger): Trigger | undefined
}

/**
 * Runs Assignments in Claude Code Sessions, one per ticket, each in its ticket's directory, as upstream's DSH executor runs
 * them in DSH Sessions. Launches and deliveries are durable effects. A ticket holds a worker slot while its worker's turn runs,
 * and while background work its turn left runs, at most `BACKGROUND_LIMIT_MS` from each idle; a worker that handed off to a
 * person frees its slot at once. The Engine hears what the Sessions do: an Assignment started, Inputs reached it, a step took
 * them, a turn ended, a failure, an interrupted run.
 */
export class ClaudeExecutor implements Executor {
  private readonly slots: WorkerSlots
  /** Transient failures tried so far, by `assignment.id` for turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Assignments waiting on a backoff before their worker goes on; their idle is no end of a turn. */
  private readonly resuming = new Set<string>()
  /** The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when the worker runs again. */
  private readonly settling = new Map<string, AbortController>()
  /** What a look waits on: called on each change of its worker's Session. */
  private readonly watchers = new Map<string, () => void>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** The shell jobs workers left to a person when they handed off, by ticket: they hold no slot and run past any limit. */
  private readonly left = new Map<string, Set<string>>()
  /** When a person last worked directly in a worker's Session, by ticket (see `personWorked`). */
  private readonly personal = new Map<string, string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
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
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cuts its turn short unless its last word was a `ready` or
   * `dropped` report with no Input delivered since, lets go of what it was handed and did not take, and stops its background
   * tasks, those it left to a person too. Its Session stays on disk for a later Assignment.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      this.left.delete(ticket.id); this.personal.delete(ticket.id)
      const session = this.host.sessions.worker(ticket.id)
      if (!session) return
      this.track(ticket.id, (async () => {
        session.forget(session.pendingIds())
        if (!ownTurn) await session.interrupt()
        for (const task of session.background) await session.stopTask(task.id)
        // A worker that ends its own turn finishes it; then its query closes.
        if (ownTurn) await until(session.whenIdle(), this.host.lifetime)
        await session.close()
        this.host.logger.info('claude-superagent: stopped the worker of %s (%s)', ticket.id.slice(0, 12), reason)
      })())
    })
  }
  /** The open tickets whose worker holds a slot. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /**
   * A person worked directly in the worker's Session (`claude-superagent open`): the turns since are their work, which does
   * not count as the worker handing off with its earlier report.
   */
  personWorked(ticketId: string): void { this.personal.set(ticketId, now()) }
  /**
   * A person takes the worker's Session to work in it directly, in Claude Code's own terminal (`claude-superagent open`), as
   * upstream let a person open an Executor Session in DSH's UI. Two processes may not write one Session, so the worker's turn
   * ends first (`now` cuts it short), its query closes with its background tasks, and nothing reaches it until `release`:
   * Inputs and launches wait, and it holds no slot. The hold outlives a restart.
   */
  async hold(ticketId: string, now = false): Promise<{ stopped: number }> {
    this.setHeld(ticketId, true)
    this.settling.get(ticketId)?.abort()
    const session = this.host.sessions.worker(ticketId)
    if (!session) return { stopped: 0 }
    if (session.working) {
      if (now) await session.interrupt()
      await until(session.whenIdle(), this.host.lifetime)
    }
    const stopped = session.background.length
    await session.close()
    return { stopped }
  }
  /** The person is done in the Session: their turns there are their work, and what waited for the worker reaches it now. */
  release(ticketId: string): void {
    if (!this.held(ticketId)) return
    this.setHeld(ticketId, false)
    this.personWorked(ticketId)
    const ticket = this.current(ticketId)
    const running = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    if (ticket && running && ticket.undelivered.length) this.deliver(ticket, running)
  }
  /** Whether a person holds the worker's Session (`hold`). */
  held(ticketId: string): boolean { return (this.host.store.get(KV.executor.held) ?? []).includes(ticketId) }
  private setHeld(ticketId: string, held: boolean): void {
    const others = (this.host.store.get(KV.executor.held) ?? []).filter(id => id !== ticketId)
    this.host.store.set(KV.executor.held, held ? [...others, ticketId] : others)
  }

  /** Whether a ticket's worker holds a slot: its turn runs or waits to, or a look at its background work runs. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket) || this.held(ticket.id)) return false
    return !!this.host.sessions.worker(ticket.id)?.working || this.settling.has(ticket.id)
  }
  private current(ticketId: string): Ticket | undefined { return this.host.store.tickets.get(ticketId) }
  /** The worker Session of a ticket, made on first use, with its events. */
  private session(ticket: Ticket): ClaudeSession {
    return this.host.sessions.worker(ticket.id, () => this.current(ticket.id) ?? ticket, {
      running: () => { this.settling.get(ticket.id)?.abort(); this.watchers.get(ticket.id)?.() },
      idle: (_session, result) => { void this.background(this.workerIdle(ticket.id, result)) },
      tasks: () => { this.watchers.get(ticket.id)?.() },
      took: (session, uuid) => { void this.background(Promise.resolve().then(() => { this.markRead(ticket.id, session.id, uuid) })) },
      ended: (_session, error) => { this.watchers.get(ticket.id)?.(); if (error) void this.background(this.sessionFailed(ticket.id, error)) },
    })
  }

  /** Runs `executor.prepare` for a new ticket directory with the ticket's variables, then checks the directory as a worker sees it. */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // A hung prepare command, such as one waiting on a credential prompt, fails the ticket instead of holding a slot.
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
    if (this.held(ticketId)) throw new Later('A person works in the worker\'s Session')
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
    // An existing directory counts as prepared.
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    const session = this.session(ticket)
    // The background work of the Assignment this one replaces stops first, so its end does not take this one's message.
    await this.stopped(ticket.id)
    if (!current()) return
    // An Input put back for this Assignment may still wait in the Session, kept across a restart or by the query that runs:
    // its delivery to this Assignment is the only copy.
    const copies = (this.current(ticket.id)?.undelivered ?? []).map(id => this.host.sessions.promptedId(session.id, id))
    if (copies.some(uuid => session.queuedHas(uuid))) await session.close()
    session.forget(copies)
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const told = ticket.assignments.length > 1 && await session.holds(this.host.sessions.promptedId(session.id, first))
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const { text: brief, chars, read } = capped(ticket.execution?.assignment ?? '', ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const source = sourceTrigger(this.host, ticket)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    await this.host.sessions.prompt(session, ticket.assignments.length > 1 ? `assignment:${ticket.id}:${assignment.id}` : first, text, 'later',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Hand a ticket's waiting Inputs to its running Assignment one by one, reading the ticket afresh before each. */
  private async deliverQueued(ticketId: string): Promise<void> {
    // A stop of the worker's background work cuts its turn, which would drop what is delivered meanwhile.
    await this.stopped(ticketId)
    const first = this.current(ticketId)
    if (!first || !liveTicket(first) || !runningAssignment(first) || !first.undelivered.length) return
    if (this.held(ticketId)) throw new Later('A person works in the worker\'s Session')
    let woken = false
    try {
      for (;;) {
        const ticket = this.current(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try { if (input) await this.deliverInput(ticket, assignment, input) }
        catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.current(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Checked again right before the Session takes the message: the ticket may end meanwhile.
    const live = () => {
      const current = this.current(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
      if (this.held(ticket.id)) throw new Later('A person works in the worker\'s Session')
    }
    live()
    const card = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, card)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(this.session(ticket), input.id, text, 'next', live)
  }
  /** A trigger on `ticket` for its worker, with a preview of the message it replies to when the worker has not seen that one. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /** The Trigger Inputs a message carries count as read once a step of the Session took it into its history. */
  private markRead(ticketId: string, sessionId: string, uuid: string): void {
    if (this.host.closing()) return
    const read = this.current(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
      && this.host.sessions.promptedId(sessionId, input.id) === uuid).map(input => input.id) ?? []
    if (read.length) this.host.engine.inputsRead(ticketId, read)
  }

  /** A worker whose last word was its result, a question for a person, or a blocked or failed report, with nothing delivered since. */
  private handedOff(ticket: Ticket): boolean {
    const assignment = runningAssignment(ticket), report = assignment?.report
    const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
    return ((report?.state === 'ready' || !!ticket.attention) && !since) || waitsForPerson(ticket)
  }
  /**
   * A worker's Session went idle: no turn runs and none waits to. A failed turn goes on after a backoff when its failure
   * passes. A worker that handed off to a person ends its turn and frees its slot (`handOff`). Otherwise its turn ends once
   * nothing runs for it in the background, which holds its slot meanwhile, at most `BACKGROUND_LIMIT_MS` from this idle and
   * until it runs again; at the limit its shell jobs are stopped, and with no report since its Inputs it reports waiting.
   */
  private async workerIdle(ticketId: string, result: SDKResultMessage | undefined): Promise<void> {
    const idle = this.current(ticketId)
    const assignment = idle && liveTicket(idle) ? runningAssignment(idle) : undefined
    if (!idle || !assignment || this.host.closing() || this.resuming.has(assignment.id)) return
    if (result && (result.subtype !== 'success' || result.is_error)) {
      const error = new Error(('errors' in result && result.errors?.join('; ')) || ('result' in result && result.result) || result.subtype || 'The worker turn failed')
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticketId, assignment.id, error); return }
      this.failed(ticketId, String(error)); return
    }
    // A turn that ended as turns do starts the count of passing failures again.
    this.transient.delete(assignment.id)
    const live = () => {
      const stored = this.current(ticketId)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === assignment.id ? stored : undefined
    }
    const session = this.host.sessions.worker(ticketId)
    // A turn a person started in the Session is the person's work, which goes on as any turn's does.
    const report = assignment.report, person = this.personal.get(ticketId)
    if (this.handedOff(idle) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticketId, assignment.id)
      if (session) await this.handOff(ticketId, session)
      return
    }
    this.settling.get(ticketId)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticketId, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    try { quiet = session ? await this.untilQuiet(ticketId, session, AbortSignal.any([this.host.lifetime, look.signal, limit.signal])) : true }
    finally { clearTimeout(timer); if (this.settling.get(ticketId) === look) this.settling.delete(ticketId) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(assignment.id)) return
    if (quiet) this.host.engine.turnEnded(ticketId, assignment.id)
    let stopped = ''
    if (!quiet && session) {
      // Its shell jobs that ran past the limit stop, which it reads at its next turn; its subagents go on.
      const left = this.left.get(ticketId) ?? new Set()
      const jobs = session.background.filter(task => !subagent(task) && !left.has(task.id))
      const minutes = BACKGROUND_LIMIT_MS / 60_000
      for (const job of jobs) await session.stopTask(job.id)
      if (jobs.length) {
        const names = jobs.map(job => `${job.id} (${job.description})`).join(', ')
        await this.host.sessions.prompt(session, `killed:${jobs.map(job => job.id).join(',')}`,
          `Your background jobs ran ${minutes} minutes after your turn ended and were stopped: ${names}.`, 'inject')
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were stopped: ${jobs.map(job => job.description).join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    if (this.handedOff(current)) return
    const said = [result && 'result' in result ? result.result.trim() : '', stopped].filter(Boolean).join('\n\n')
    this.reportWaiting(current, said)
    // Nothing runs for it now: its query closes, and its next Input resumes the Session.
    if (quiet && session && !session.busy) await session.close()
  }
  /**
   * Wait until nothing runs for a worker that went idle but the jobs it left to a person: true once all of it ended with the
   * worker idle; false when the worker runs again, or when `signal` aborts first.
   */
  private untilQuiet(ticketId: string, session: ClaudeSession, signal: AbortSignal): Promise<boolean> {
    const left = this.left.get(ticketId)
    const quiet = () => !session.background.some(task => !left?.has(task.id))
    if (session.working) return Promise.resolve(false)
    if (quiet()) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = (value: boolean) => { this.watchers.delete(ticketId); signal.removeEventListener('abort', aborted); resolve(value) }
      const aborted = () => { done(false) }
      this.watchers.set(ticketId, () => {
        if (session.working || !session.open) done(!session.open)
        else if (quiet()) done(true)
      })
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends; they hold no slot and run past any limit. Unlike in DSH, a job
   * that ends starts a turn of the worker by itself, in which it reads of it. A worker with nothing left closes its query.
   */
  private async handOff(ticketId: string, session: ClaudeSession): Promise<void> {
    const left = this.left.get(ticketId) ?? new Set<string>()
    this.left.set(ticketId, left)
    for (const task of session.background) {
      if (subagent(task)) await session.stopTask(task.id)
      else left.add(task.id)
    }
    if (!session.background.some(task => !subagent(task)) && !session.working) await session.close()
  }
  /** Report `waiting` for a turn that ended without a report since its Inputs, with its last words, and tell the router. */
  private reportWaiting(ticket: Ticket, said: string): void {
    this.host.store.atomic(() => {
      const before = latestReport(ticket)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
    })
  }
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
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
  /** Tell a worker whose turn failed for a passing reason to go on, after a backoff that doubles, in a slot of its own. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.current(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      if (this.host.paused() || this.held(ticketId)) { this.after(SLOT_WAIT_MS, go); return }
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.sessions.prompt(this.session(ticket), `retry:${assignmentId}:${tries}`, text, 'later')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
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
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => {
        this.host.logger.warn('claude-superagent: a worker event failed: %s', String(error))
        health.set({ state: 'error', detail: String(error), at: now() })
      })
  }
  /**
   * At startup: an Assignment that was running when the host stopped is interrupted, which starts it again with a recovery
   * note unless it had reported since; what its Session was handed and did not take stays in its ledger and goes in when the
   * Session opens again. A pending Assignment is launched again, oldest ticket first, unless it waits for a person.
   */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /**
   * On a host stop, for a bounded time: cut each worker's turn short, keeping what it was handed and did not take in its
   * ledger; stop its background tasks, those left to a person too; close its query.
   */
  async shutdown(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const look of this.settling.values()) look.abort()
    const stops = this.host.store.tickets.list().flatMap(ticket => this.host.sessions.worker(ticket.id) ?? []).map(async session => {
      if (session.working) await session.interrupt()
      for (const task of session.background) await session.stopTask(task.id)
      await session.close()
    })
    await until(Promise.allSettled(stops), undefined, SHUTDOWN_STOP_MS)
  }
}
