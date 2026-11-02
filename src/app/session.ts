/** One Claude Code Session, driven through the Agent SDK in streaming input mode. */
import { getSessionInfo, getSessionMessages, query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** The Agent SDK calls a Session makes; tests pass a stand-in. */
export interface Sdk {
  query: typeof query
  getSessionInfo: typeof getSessionInfo
  getSessionMessages: typeof getSessionMessages
}
export const AGENT_SDK: Sdk = { query, getSessionInfo, getSessionMessages }

/**
 * How a message reaches a Session (see docs/host-probes.md): `next` at the next step of a turn that runs, or as a new turn;
 * `later` after the turn that runs; `inject` into the history without starting a turn of its own.
 */
export type Delivery = 'next' | 'later' | 'inject'
type Uuid = `${string}-${string}-${string}-${string}-${string}`
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
  /** A turn ended (a `result`); `background` says whether shell jobs or subagents still run for it. */
  turnEnded?(session: ClaudeSession, result: SDKMessage, background: boolean): void
  /** The query ended: closed by the host, or failed, with the error. */
  ended?(session: ClaudeSession, error?: unknown): void
}

/**
 * A Claude Code Session with a fixed id and working directory. `open` starts its query, resuming the Session when one with
 * its id exists; `send` hands it a message; `close` ends the query, which `open` can start again. It keeps no state of its own
 * beyond what the query reports: whether a turn runs, which background tasks run, and which messages it took.
 */
export class ClaudeSession {
  private inbox?: Inbox
  private running?: Query
  private loop?: Promise<void>
  private started?: SessionStart
  private turn = false
  private readonly tasks = new Set<string>()
  /** The uuids of the messages this Session holds or was sent, read from its history once, then kept up to date. */
  private known?: Set<string>
  private idleWaiters: (() => void)[] = []
  constructor(readonly id: string, readonly cwd: string, private readonly start: () => Promise<SessionStart>, private readonly events: SessionEvents = {},
    private readonly sdk: Sdk = AGENT_SDK) {}

  /** Whether the query runs. */
  get open(): boolean { return this.running !== undefined }
  /** Whether a turn runs, or background work started by one; a Session that is not open is not busy. */
  get busy(): boolean { return this.open && (this.turn || this.tasks.size > 0) }
  /** The background tasks a turn left running, by task id. */
  get background(): readonly string[] { return [...this.tasks] }
  /** Whether the Session started with options that differ from what a start would use now. */
  async stale(): Promise<boolean> { return !!this.started && (await this.start()).fingerprint !== this.started.fingerprint }

  /** Start the query unless it runs; resume the Session when it exists. */
  async openSession(): Promise<void> {
    if (this.running) return
    const start = await this.start()
    const exists = !!await this.sdk.getSessionInfo(this.id, { dir: this.cwd }).catch(() => undefined)
    const inbox = new Inbox()
    const running = this.sdk.query({ prompt: inbox, options: { ...start.options, cwd: this.cwd, ...exists ? { resume: this.id } : { sessionId: this.id } } })
    this.inbox = inbox; this.running = running; this.started = start; this.turn = false; this.tasks.clear()
    this.loop = this.consume(running)
  }
  /**
   * Hand the Session a message once per `uuid`: one the Session's history holds, or this process sent, is not sent again, so
   * a delivery retried after a restart is not doubled. Opens the Session first when it is closed.
   */
  async send(uuid: string, text: string, delivery: Delivery): Promise<void> {
    this.known ??= new Set((await this.history()).map(message => message.uuid))
    if (this.known.has(uuid)) return
    await this.openSession()
    const fields = delivery === 'inject' ? { shouldQuery: false } : { priority: delivery }
    this.inbox!.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: uuid as Uuid, ...fields })
    this.known.add(uuid)
    if (delivery !== 'inject') this.turn = true
  }
  /** Whether the Session's history holds the message with `uuid`: its Session took it into a step. */
  async took(uuid: string): Promise<boolean> {
    return (await this.history()).some(message => message.uuid === uuid)
  }
  /** The Session's messages, oldest first; none while it does not exist yet. */
  async history(): Promise<{ type: 'user' | 'assistant' | 'system'; uuid: string; message: unknown }[]> {
    return this.sdk.getSessionMessages(this.id, { dir: this.cwd }).catch(() => [])
  }
  /** Cut the turn that runs short; the query goes on and takes later messages. */
  async interrupt(): Promise<void> { await this.running?.interrupt().catch(() => undefined) }
  /** Stop a background task of the Session. */
  async stopTask(taskId: string): Promise<void> { await this.running?.stopTask(taskId).catch(() => undefined) }
  /** End the query: its turn stops, its background tasks with it. Waits until the query has ended. */
  async close(): Promise<void> {
    const running = this.running, loop = this.loop
    if (!running) return
    this.inbox?.close()
    running.close()
    await loop?.catch(() => undefined)
  }
  /** Resolves once no turn runs; at once while none does. */
  whenIdle(): Promise<void> {
    if (!this.turn) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.push(resolve) })
  }
  /** The query's handle while it runs, for the controls this class does not wrap. */
  get query(): Query | undefined { return this.running }

  private async consume(running: Query): Promise<void> {
    let failure: unknown
    try {
      for await (const message of running) {
        this.observe(message)
        this.events.message?.(this, message)
        if (message.type === 'result') {
          this.turn = false
          for (const resolve of this.idleWaiters.splice(0)) resolve()
          this.events.turnEnded?.(this, message, this.tasks.size > 0)
        }
      }
    } catch (error) { failure = error }
    finally {
      if (this.running === running) { this.running = undefined; this.inbox = undefined; this.turn = false; this.tasks.clear() }
      for (const resolve of this.idleWaiters.splice(0)) resolve()
      this.events.ended?.(this, failure)
    }
  }
  /** Follow the turn and the background tasks from the query's system messages. */
  private observe(message: SDKMessage): void {
    const m = message as { type: string; subtype?: string; task_id?: string; status?: string }
    if (m.type !== 'system') return
    // A finished background task starts a turn by itself: its init is the turn's start.
    if (m.subtype === 'init') this.turn = true
    if (m.subtype === 'task_started' && m.task_id) this.tasks.add(m.task_id)
    if (m.subtype === 'task_notification' && m.task_id) this.tasks.delete(m.task_id)
  }
}
