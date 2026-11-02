/** One Claude Code Session, driven through the Agent SDK in streaming input mode. */
import { getSessionInfo, getSessionMessages, query, type Options, type Query, type SDKMessage, type SDKResultMessage, type SDKUserMessage }
  from '@anthropic-ai/claude-agent-sdk'

/** The Agent SDK calls a Session makes; tests pass a stand-in. */
export interface Sdk {
  query: typeof query
  getSessionInfo: typeof getSessionInfo
  getSessionMessages: typeof getSessionMessages
}
export const AGENT_SDK: Sdk = { query, getSessionInfo, getSessionMessages }

/**
 * How a message reaches a Session (see docs/host-probes.md): `next` at the next step of a turn that runs, or as a new turn;
 * `later` after the turn that runs; `inject` into the history with the next message that queries, starting no turn of its own.
 */
export type Delivery = 'next' | 'later' | 'inject'
/** A message handed to a Session that it has not taken into its history yet. */
export interface QueuedMessage { uuid: string; text: string; delivery: Delivery }
/**
 * Where a Session keeps the messages it was handed and has not taken, so that a restart or a query that ended hands them over
 * again: upstream's persisted inbox.
 */
export interface SessionLedger {
  pending(): QueuedMessage[]
  save(pending: QueuedMessage[]): void
}
const memoryLedger = (): SessionLedger => { let list: QueuedMessage[] = []; return { pending: () => list, save: next => { list = next } } }
/** A background task of the Session, from the SDK's `background_tasks_changed`: `local_bash` and `monitor` are shell jobs, `local_agent` subagents. */
export interface BackgroundTask { id: string; type: string; description: string }
export const subagent = (task: BackgroundTask): boolean => task.type === 'local_agent'
type Uuid = `${string}-${string}-${string}-${string}-${string}`
/** How long a finished background task may take to start the turn it wakes the Session for, before it counts as waking none. */
const WAKE_GRACE_MS = 5000

/** A prompt stream the host pushes into while the query runs. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false
  push(message: SDKUserMessage): void { this.queue.push(message); this.wake?.() }
  close(): void { this.closed = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!
      if (this.closed) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
/** What a Session starts with; the host builds it afresh at each start, so a change of prompt or settings applies then. */
export interface SessionStart {
  options: Omit<Options, 'resume' | 'sessionId' | 'cwd' | 'abortController'>
  /** What the start's prompt and options say, which `stale` compares with what a start would say now. */
  fingerprint: string
}
export interface SessionEvents {
  /** Every message the query yields, after the Session has updated its own state from it. */
  message?(session: ClaudeSession, message: SDKMessage): void
  /** The Session took the message `uuid` into its history: a step read it. */
  took?(session: ClaudeSession, uuid: string): void
  /** A turn started. */
  running?(session: ClaudeSession): void
  /**
   * No turn runs and none waits to: the Session's own turn-over signal, with the last turn's result. Background tasks may
   * still run (`background`); a finished one starts a turn by itself.
   */
  idle?(session: ClaudeSession, result: SDKResultMessage | undefined): void
  /** The set of background tasks changed. */
  tasks?(session: ClaudeSession): void
  /** The query ended: closed by the host, or failed, with the error. */
  ended?(session: ClaudeSession, error?: unknown): void
}

/**
 * A Claude Code Session with a fixed id and working directory. `openSession` starts its query, resuming the Session when one
 * with its id exists; `send` hands it a message once per uuid; `close` ends the query, which `openSession` can start again.
 *
 * Its state comes from what the query reports, with two Claude Code options the host turns on: a replay of each message as a
 * step takes it (`replay-user-messages`), and the Session's own idle and running signal (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`).
 * A message is recorded in the ledger before it is pushed and leaves it once taken, so one handed over and not taken is handed
 * over again when the query next opens.
 */
export class ClaudeSession {
  private inbox?: Inbox
  private running?: Query
  private loop?: Promise<void>
  private opening?: Promise<void>
  private started?: SessionStart
  private state: 'idle' | 'running' | 'requires_action' = 'idle'
  private lastResult?: SDKResultMessage
  private readonly tasks = new Map<string, BackgroundTask>()
  /** Tasks the host stops, whose end wakes no turn. */
  private readonly stopping = new Set<string>()
  /** A finished task is starting a turn: Claude Code says it ended before it says the Session runs. */
  private waking?: ReturnType<typeof setTimeout>
  /** Pushed into the running query and not taken yet; `querying` holds those that start or continue a turn. */
  private readonly queued = new Set<string>()
  private readonly querying = new Set<string>()
  /**
   * The uuids of the messages the Session took: read from its history, then kept up to date from the replays while its query
   * runs; read again once it ended, as the Session on disk may have changed or gone meanwhile.
   */
  private taken?: Set<string>
  /** A read of the history that runs, which replays meanwhile join (`tookMeanwhile`). */
  private loading?: Promise<Set<string>>
  private readonly tookMeanwhile = new Set<string>()
  private idleWaiters: (() => void)[] = []
  constructor(readonly id: string, readonly cwd: string, private readonly start: () => Promise<SessionStart>, private readonly events: SessionEvents = {},
    private readonly sdk: Sdk = AGENT_SDK, private readonly ledger: SessionLedger = memoryLedger()) {}

  /** Whether the query runs. */
  get open(): boolean { return this.running !== undefined }
  /** Whether a turn runs or a message waits to start one. */
  get working(): boolean { return this.open && (this.state !== 'idle' || this.querying.size > 0 || this.waking !== undefined) }
  /** Whether a turn runs, one waits, or background work a turn started runs; a Session that is not open is not busy. */
  get busy(): boolean { return this.working || (this.open && this.tasks.size > 0) }
  /** The background tasks that run, by task id. */
  get background(): readonly BackgroundTask[] { return [...this.tasks.values()] }
  /** Whether the Session started with options that differ from what a start would use now. */
  async stale(): Promise<boolean> { return !!this.started && (await this.start()).fingerprint !== this.started.fingerprint }

  /** Start the query unless it runs or starts; resume the Session when it exists. One start runs at a time. */
  openSession(): Promise<void> {
    if (this.running) return Promise.resolve()
    return this.opening ??= this.begin().finally(() => { this.opening = undefined })
  }
  private async begin(): Promise<void> {
    const start = await this.start()
    const exists = !!await this.sdk.getSessionInfo(this.id, { dir: this.cwd }).catch(() => undefined)
    const taken = await this.takenSet()
    const env = { ...start.options.env ?? process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
    const inbox = new Inbox()
    const running = this.sdk.query({ prompt: inbox, options: { ...start.options, env, extraArgs: { ...start.options.extraArgs, 'replay-user-messages': null },
      cwd: this.cwd, ...exists ? { resume: this.id } : { sessionId: this.id } } })
    this.inbox = inbox; this.running = running; this.started = start
    this.state = 'idle'; this.lastResult = undefined; this.tasks.clear(); this.queued.clear(); this.querying.clear()
    // What an earlier query was handed and did not take goes in first, in its order.
    const pending = this.ledger.pending().filter(message => !taken.has(message.uuid))
    this.ledger.save(pending)
    for (const message of pending) this.push(message)
    this.loop = this.consume(running)
  }
  /**
   * Hand the Session a message once per `uuid`: not again once it took it or while the running query holds it. Opens the
   * Session when it is closed; `authorize` runs last before the message is recorded and pushed, and throws to withhold it. The
   * ledger keeps the message until a step takes it, so a restart hands it over again.
   */
  async send(uuid: string, text: string, delivery: Delivery, authorize?: () => void): Promise<void> {
    const taken = await this.takenSet()
    // One a step took before, such as just before a restart, counts as taken now: its sender may not have heard.
    if (taken.has(uuid)) { this.events.took?.(this, uuid); return }
    if (this.queued.has(uuid)) return
    await this.openSession()
    authorize?.()
    // Opening hands over what the ledger kept, this message too when an earlier send recorded it.
    if (this.queued.has(uuid) || taken.has(uuid)) return
    const pending = this.ledger.pending()
    if (!pending.some(message => message.uuid === uuid)) this.ledger.save([...pending, { uuid, text, delivery }])
    this.push({ uuid, text, delivery })
  }
  /** Whether the running query holds the message `uuid` and no step took it yet. */
  queuedHas(uuid: string): boolean { return this.queued.has(uuid) }
  /** The uuids of the messages handed over and not taken, oldest first. */
  pendingIds(): string[] { return this.ledger.pending().map(message => message.uuid) }
  /** Let go of messages handed over and not taken, such as Inputs a new Assignment delivers afresh; the running query keeps what it holds. */
  forget(uuids: readonly string[]): void {
    const drop = new Set(uuids)
    const pending = this.ledger.pending()
    if (pending.some(message => drop.has(message.uuid))) this.ledger.save(pending.filter(message => !drop.has(message.uuid)))
  }
  /** Whether the Session took the message `uuid`, or holds it to take. */
  async holds(uuid: string): Promise<boolean> {
    return (await this.takenSet()).has(uuid) || this.queued.has(uuid) || this.ledger.pending().some(message => message.uuid === uuid)
  }
  /** The Session's messages, oldest first; none while it does not exist yet. */
  async history(): Promise<{ type: 'user' | 'assistant' | 'system'; uuid: string; message: unknown }[]> {
    return this.sdk.getSessionMessages(this.id, { dir: this.cwd }).catch(() => [])
  }
  /** Cut the turn that runs short; messages it had not taken stay queued and run next. */
  async interrupt(): Promise<void> { await this.running?.interrupt().catch(() => undefined) }
  /** Stop a background task of the Session. */
  async stopTask(taskId: string): Promise<void> {
    if (!this.running) return
    this.stopping.add(taskId)
    await this.running.stopTask(taskId).catch(() => { this.stopping.delete(taskId) })
  }
  /**
   * End the query: its turn stops, its background tasks with it. Messages handed over and not taken stay in the ledger (see
   * `forget`). Waits until the query has ended; a start that runs meanwhile finishes first.
   */
  async close(): Promise<void> {
    await this.opening?.catch(() => undefined)
    const running = this.running, loop = this.loop
    if (!running) return
    this.inbox?.close()
    running.close()
    await loop?.catch(() => undefined)
  }
  /** Resolves once no turn runs and none waits to; at once while none does. */
  whenIdle(): Promise<void> {
    if (!this.working) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.push(resolve) })
  }
  /** The query's handle while it runs, for the controls this class does not wrap. */
  get query(): Query | undefined { return this.running }

  /** Mark the Session as starting a turn a finished task wakes it for, or no longer; one that never starts counts as none. */
  private wake(waking: boolean): void {
    clearTimeout(this.waking)
    this.waking = waking ? setTimeout(() => { this.waking = undefined; this.events.tasks?.(this) }, WAKE_GRACE_MS) : undefined
    this.waking?.unref?.()
  }
  private push(message: QueuedMessage): void {
    const fields = message.delivery === 'inject' ? { shouldQuery: false } : { priority: message.delivery }
    this.inbox!.push({ type: 'user', message: { role: 'user', content: message.text }, parent_tool_use_id: null, uuid: message.uuid as Uuid, ...fields })
    this.queued.add(message.uuid)
    if (message.delivery !== 'inject') this.querying.add(message.uuid)
  }
  /**
   * What the Session took. A history that cannot be read fails the send, which its effect tries again, unless the Session does
   * not exist yet; replays that come while it is read join it.
   */
  private takenSet(): Promise<Set<string>> {
    if (this.taken) return Promise.resolve(this.taken)
    return this.loading ??= (async () => {
      let history: { uuid: string }[]
      try { history = await this.sdk.getSessionMessages(this.id, { dir: this.cwd }) }
      catch (error) {
        if (await this.sdk.getSessionInfo(this.id, { dir: this.cwd }).catch(() => undefined)) throw error
        history = []
      }
      const taken = new Set([...history.map(message => message.uuid), ...this.tookMeanwhile])
      this.tookMeanwhile.clear()
      this.taken = taken
      return taken
    })().finally(() => { this.loading = undefined })
  }
  private async consume(running: Query): Promise<void> {
    let failure: unknown
    try {
      for await (const message of running) {
        const changed = this.observe(message)
        this.events.message?.(this, message)
        if (changed === 'running') this.events.running?.(this)
        else if (changed === 'idle') {
          const result = this.lastResult
          this.lastResult = undefined
          for (const resolve of this.idleWaiters.splice(0)) resolve()
          this.events.idle?.(this, result)
        } else if (changed === 'tasks') this.events.tasks?.(this)
        else if (changed) this.events.took?.(this, changed.took)
      }
    } catch (error) { failure = error }
    finally {
      if (this.running === running) {
        this.running = undefined; this.inbox = undefined; this.state = 'idle'; this.tasks.clear(); this.queued.clear(); this.querying.clear()
        this.stopping.clear(); this.wake(false); this.taken = undefined
      }
      for (const resolve of this.idleWaiters.splice(0)) resolve()
      this.events.ended?.(this, failure)
    }
  }
  /** Update the Session's state from one message; say what changed. */
  private observe(message: SDKMessage): 'running' | 'idle' | 'tasks' | { took: string } | undefined {
    const m = message as { type: string; subtype?: string; isReplay?: boolean; uuid?: string; state?: string; task_id?: string
      tasks?: { task_id: string; task_type: string; description: string; ambient?: boolean }[] }
    if (m.type === 'result') { this.lastResult = message as SDKResultMessage; return undefined }
    if (m.type === 'user' && m.isReplay && m.uuid && this.queued.has(m.uuid)) {
      this.queued.delete(m.uuid); this.querying.delete(m.uuid)
      if (this.taken) this.taken.add(m.uuid); else this.tookMeanwhile.add(m.uuid)
      this.forget([m.uuid])
      return { took: m.uuid }
    }
    if (m.type !== 'system') return undefined
    if (m.subtype === 'task_notification' && m.task_id) {
      // A task that ended by itself starts a turn of an idle Session, which Claude Code says only after.
      if (!this.stopping.delete(m.task_id) && this.state === 'idle') this.wake(true)
      return undefined
    }
    if (m.subtype === 'session_state_changed') {
      const was = this.state
      this.state = m.state === 'running' || m.state === 'requires_action' ? m.state : 'idle'
      this.wake(false)
      if (this.state !== 'idle') return was === 'idle' ? 'running' : undefined
      // A message pushed as the turn ended starts the next one: no turn-over yet.
      return this.querying.size ? undefined : 'idle'
    }
    if (m.subtype === 'background_tasks_changed' && m.tasks) {
      this.tasks.clear()
      for (const task of m.tasks) if (!task.ambient) this.tasks.set(task.task_id, { id: task.task_id, type: task.task_type, description: task.description })
      return 'tasks'
    }
    return undefined
  }
}
