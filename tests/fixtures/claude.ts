/**
 * A stand-in for Claude Code behind the Agent SDK, as the probes in docs/host-probes.md saw it behave: a query takes the
 * messages its host pushes, replays each one as a step takes it into the Session's history, and says when the Session runs
 * and goes idle. The test plays the model: `step` takes what waits for the next step, `end` ends the turn, `task` and
 * `taskEnd` start and end background work, whose end starts a turn by itself. Histories outlive queries, as files on disk do.
 */
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { vi } from 'vitest'
import type { Delivery, Sdk } from '../../src/app/session.ts'

export interface Pushed { sessionId: string; uuid: string; delivery: Delivery; text: string }
type Queued = { uuid: string; text: string }

/** One running query of a Session: what it was handed, its turn, its background tasks. */
export class FakeQuery {
  status: 'idle' | 'running' = 'idle'
  readonly nextStep: Queued[] = []
  readonly nextTurn: Queued[] = []
  readonly injected: Queued[] = []
  readonly tasks = new Map<string, { type: string; description: string }>()
  closed = false
  private out: SDKMessage[] = []
  private wake?: () => void
  private taskCount = 0
  readonly interrupt = vi.fn(async () => {
    if (this.status !== 'running') return { still_queued: [] }
    this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Interrupted'] })
    this.after()
    return { still_queued: this.nextTurn.map(message => message.uuid) }
  })
  readonly stopTask = vi.fn(async (id: string) => { this.taskEnd(id, 'stopped', false) })
  readonly close = vi.fn(() => {
    this.closed = true; this.status = 'idle'; this.tasks.clear()
    if (this.session.query === this) this.session.query = undefined
    this.wake?.()
  })
  constructor(readonly session: FakeSession, readonly options: Record<string, any>, prompt: AsyncIterable<SDKUserMessage>, private readonly pushed: (message: Pushed) => void) {
    void (async () => { for await (const message of prompt) { if (this.closed) return; this.receive(message) } })()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      while (this.out.length) {
        const next = this.out.shift()! as SDKMessage & { fail?: Error }
        if (next.fail) throw next.fail
        yield next
      }
      if (this.closed) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
  emit(message: Record<string, unknown>): void { this.out.push(message as unknown as SDKMessage); this.wake?.() }
  private state(state: 'idle' | 'running'): void { this.status = state; this.emit({ type: 'system', subtype: 'session_state_changed', state }) }
  private receive(message: SDKUserMessage): void {
    const delivery: Delivery = message.shouldQuery === false ? 'inject' : message.priority === 'later' ? 'later' : 'next'
    const text = typeof message.message.content === 'string' ? message.message.content : ''
    const uuid = message.uuid!
    this.pushed({ sessionId: this.session.id, uuid, delivery, text })
    ;(delivery === 'inject' ? this.injected : delivery === 'later' ? this.nextTurn : this.nextStep).push({ uuid, text })
    if (delivery !== 'inject' && this.status === 'idle') this.startTurn()
  }
  /** A turn starts and its first step takes what waits: the next queued message as well. */
  private startTurn(): void { this.state('running'); this.take(true) }
  /** A step takes the messages that wait for one, and injected ones with them; a turn's first also the next queued one. */
  private take(starts: boolean): void {
    const batch = [...this.injected.splice(0), ...this.nextStep.splice(0), ...(starts ? this.nextTurn.splice(0, 1) : [])]
    for (const message of batch) {
      this.session.history.push({ type: 'user', uuid: message.uuid, message: { role: 'user', content: message.text } })
      this.emit({ type: 'user', isReplay: true, uuid: message.uuid, message: { role: 'user', content: message.text } })
    }
  }
  /** The model takes its next step, which takes the messages steered in since its last. */
  step(): void { if (this.status === 'running') this.take(false) }
  /** The turn ends with a result; what waits starts the next one, else the Session goes idle. */
  end(result: { result?: string; subtype?: string; is_error?: boolean; errors?: string[] } = {}): void {
    if (this.status !== 'running') throw new Error(`The Session ${this.session.id} runs no turn`)
    this.emit({ type: 'result', subtype: 'success', is_error: false, result: '', ...result })
    this.after()
  }
  private after(): void {
    if (this.nextTurn.length || this.nextStep.length) this.take(true)
    else this.state('idle')
  }
  /** The turn starts background work: `local_bash` a shell job, `local_agent` a subagent. */
  task(type = 'local_bash', description = 'npm test'): string {
    const id = `task-${++this.taskCount}`
    this.tasks.set(id, { type, description })
    this.emitTasks()
    return id
  }
  /** Background work ends; an end that was not a stop starts a turn of an idle Session by itself, as Claude Code does. */
  taskEnd(id: string, status = 'completed', wakes = true): void {
    if (!this.tasks.delete(id)) return
    this.emit({ type: 'system', subtype: 'task_notification', task_id: id, status })
    this.emitTasks()
    if (wakes && this.status === 'idle' && !this.closed) this.state('running')
  }
  private emitTasks(): void {
    this.emit({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [...this.tasks].map(([task_id, task]) => ({ task_id, task_type: task.type, description: task.description })) })
  }
  /** The query fails, as a crashed Claude Code process does. */
  fail(error: Error): void {
    this.out.push({ fail: error } as never); this.closed = true; this.wake?.()
  }
}
/** A Session on disk: its history, and the query that runs it, if any. */
export class FakeSession {
  readonly history: { type: 'user'; uuid: string; message: unknown }[] = []
  query?: FakeQuery
  constructor(readonly id: string) {}
  /** The running query; throws when none runs. */
  get running(): FakeQuery { if (!this.query) throw new Error(`No query runs the Session ${this.id}`); return this.query }
  get status(): 'idle' | 'running' { return this.query?.status ?? 'idle' }
  step(): void { this.running.step() }
  end(result?: Parameters<FakeQuery['end']>[0]): void { this.running.end(result) }
  task(type?: string, description?: string): string { return this.running.task(type, description) }
  taskEnd(id: string, status?: string): void { this.running.taskEnd(id, status) }
  /** The uuids its history holds, oldest first. */
  taken(): string[] { return this.history.map(message => message.uuid) }
}

/** Claude Code behind the Agent SDK, for the host's Sessions to drive; see the module comment. */
export function fakeClaude() {
  const sessions = new Map<string, FakeSession>()
  const queries: FakeQuery[] = []
  const pushed = vi.fn<(message: Pushed) => void>()
  const session = (id: string): FakeSession => { let found = sessions.get(id); if (!found) { found = new FakeSession(id); sessions.set(id, found) } return found }
  const sdk = {
    query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, any> }) => {
      const target = session(options.resume ?? options.sessionId ?? 'models')
      const query = new FakeQuery(target, options, prompt, message => { pushed(message) })
      // A query that lists models only answers its control request.
      Object.assign(query, { supportedModels: async () => [{ value: 'claude-opus-5-5', displayName: 'Opus', description: '' }] })
      if (options.resume || options.sessionId) { target.query = query; queries.push(query) }
      return query as unknown as ReturnType<Sdk['query']>
    }),
    getSessionInfo: vi.fn(async (id: string) => sessions.get(id)?.history.length || sessions.get(id)?.query ? { sessionId: id } : undefined),
    getSessionMessages: vi.fn(async (id: string) => [...sessions.get(id)?.history ?? []]),
  } as unknown as Sdk & { query: ReturnType<typeof vi.fn> }
  return { sdk, sessions, queries, pushed, session,
    /** What the host pushed to `sessionId`, in order. */
    to: (sessionId: string) => pushed.mock.calls.map(([message]) => message).filter(message => message.sessionId === sessionId) }
}
export type FakeClaude = ReturnType<typeof fakeClaude>
