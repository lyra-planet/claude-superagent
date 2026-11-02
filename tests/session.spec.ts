import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeSession, type QueuedMessage, type Sdk, type SessionEvents, type SessionLedger } from '../src/app/session.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))
/** A query the test drives: it records what the Session sends and yields what the test emits, as Claude Code would. */
class FakeQuery {
  readonly sent: SDKUserMessage[] = []
  private queue: SDKMessage[] = []
  private wake?: () => void
  private ended = false
  readonly interrupt = vi.fn(async () => {})
  readonly stopTask = vi.fn(async (_: string) => {})
  constructor(prompt: AsyncIterable<SDKUserMessage>, readonly options: Record<string, any>) {
    void (async () => { for await (const message of prompt) this.sent.push(message) })()
  }
  emit(message: Record<string, unknown>): void { this.queue.push(message as unknown as SDKMessage); this.wake?.() }
  /** A step takes the message `uuid`: Claude Code replays it. */
  take(uuid: string): void { this.emit({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: '' } }) }
  state(state: 'idle' | 'running'): void { this.emit({ type: 'system', subtype: 'session_state_changed', state }) }
  close(): void { this.ended = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}
function host(options: { exists?: boolean; history?: string[]; fingerprint?: () => string; ledger?: QueuedMessage[] } = {}) {
  const queries: FakeQuery[] = []
  let exists = options.exists ?? false
  let opening = 0
  const sdk = {
    query: ({ prompt, options: given }: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      const query = new FakeQuery(prompt, given); queries.push(query); exists = true; return query
    },
    getSessionInfo: async (id: string) => { opening++; await flush(); return exists ? { sessionId: id } : undefined },
    getSessionMessages: async () => (options.history ?? []).map(uuid => ({ type: 'user', uuid, message: {} })),
  } as unknown as Sdk
  let pending = options.ledger ?? []
  const ledger: SessionLedger = { pending: () => pending, save: next => { pending = next } }
  const events = { idle: vi.fn(), running: vi.fn(), took: vi.fn(), tasks: vi.fn(), ended: vi.fn() } satisfies SessionEvents
  const session = new ClaudeSession('s1', '/work/t1', async () => ({ options: { model: 'm', env: { PATH: '/bin' } }, fingerprint: options.fingerprint?.() ?? 'f1' }),
    events, sdk, ledger)
  return { session, queries, events, ledger: () => pending, opening: () => opening }
}

describe('ClaudeSession', () => {
  it('starts a Session with its id and Claude Code\'s replays and state signals, and resumes it once it exists', async () => {
    const h = host()
    await h.session.openSession()
    expect(h.queries[0]!.options).toMatchObject({ model: 'm', cwd: '/work/t1', sessionId: 's1', extraArgs: { 'replay-user-messages': null },
      env: { PATH: '/bin', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } })
    expect(h.queries[0]!.options).not.toHaveProperty('resume')
    await h.session.close()
    expect(h.session.open).toBe(false)
    await h.session.openSession()
    expect(h.queries[1]!.options).toMatchObject({ resume: 's1' })
    expect(h.queries[1]!.options).not.toHaveProperty('sessionId')
  })
  it('starts one query for starts that overlap', async () => {
    const h = host()
    await Promise.all([h.session.openSession(), h.session.send('a', 'one', 'next'), h.session.send('b', 'two', 'inject')])
    expect(h.queries).toHaveLength(1)
    expect(h.opening()).toBe(1)
  })
  it('maps a delivery to the SDK\'s priority, and an injection to a message that starts no turn', async () => {
    const h = host()
    await h.session.send('a', 'steer', 'next')
    await h.session.send('b', 'queue', 'later')
    await h.session.send('c', 'note', 'inject')
    await flush()
    const [steer, queue, note] = h.queries[0]!.sent
    expect(steer).toMatchObject({ type: 'user', uuid: 'a', message: { role: 'user', content: 'steer' }, priority: 'next' })
    expect(queue).toMatchObject({ uuid: 'b', priority: 'later' })
    expect(note).toMatchObject({ uuid: 'c', shouldQuery: false })
    expect(note).not.toHaveProperty('priority')
  })
  it('counts a message taken once Claude Code replays it, and keeps it in the ledger until then', async () => {
    const h = host()
    await h.session.send('a', 'work', 'next')
    expect(h.ledger().map(message => message.uuid)).toEqual(['a'])
    expect(await h.session.holds('a')).toBe(true)
    h.queries[0]!.take('a')
    await flush()
    expect(h.events.took).toHaveBeenCalledWith(h.session, 'a')
    expect(h.ledger()).toEqual([])
    expect(await h.session.holds('a')).toBe(true)
    await h.session.send('a', 'work', 'next')
    await flush()
    expect(h.queries[0]!.sent.map(message => message.uuid)).toEqual(['a'])
  })
  it('sends a message its history holds no more, and one a running query holds only once', async () => {
    const h = host({ exists: true, history: ['old'] })
    await h.session.send('old', 'taken before a restart', 'next')
    expect(h.queries).toHaveLength(0)
    await h.session.send('new', 'x', 'next')
    await h.session.send('new', 'x', 'next')
    await flush()
    expect(h.queries[0]!.sent.map(message => message.uuid)).toEqual(['new'])
  })
  it('hands over again, first and in order, what an earlier query was handed and did not take, and lets go of what it forgets', async () => {
    const h = host({ exists: true, history: ['done'], ledger: [{ uuid: 'done', text: 'taken', delivery: 'next' },
      { uuid: 'relay', text: 'a report', delivery: 'next' }, { uuid: 'copy', text: 'an Input', delivery: 'next' }, { uuid: 'note', text: 'a notice', delivery: 'inject' }] })
    h.session.forget(['copy'])
    await h.session.send('fresh', 'new', 'next')
    await flush()
    expect(h.queries[0]!.sent.map(message => message.uuid)).toEqual(['relay', 'note', 'fresh'])
    expect(h.ledger().map(message => message.uuid)).toEqual(['relay', 'note', 'fresh'])
    // Closing keeps what was not taken; the next query is handed it again.
    await h.session.close()
    await h.session.openSession()
    await flush()
    expect(h.queries[1]!.sent.map(message => message.uuid)).toEqual(['relay', 'note', 'fresh'])
  })
  it('withholds a message its authorization refuses at the last moment, and records nothing of it', async () => {
    const h = host()
    await expect(h.session.send('a', 'x', 'next', () => { throw new Error('The ticket ended') })).rejects.toThrow('The ticket ended')
    await flush()
    expect(h.queries[0]!.sent).toEqual([])
    expect(h.ledger()).toEqual([])
  })
  it('ends a turn on Claude Code\'s idle signal only when no message waits to start another, with the last result', async () => {
    const h = host()
    await h.session.send('a', 'go', 'next')
    expect(h.session).toMatchObject({ working: true, busy: true })
    const query = h.queries[0]!
    query.state('running'); query.take('a')
    await h.session.send('b', 'after this turn', 'later')
    query.emit({ type: 'result', subtype: 'success', result: 'first' })
    query.state('idle')
    await flush()
    expect(h.events.idle).not.toHaveBeenCalled()
    expect(h.session.working).toBe(true)
    query.state('running'); query.take('b')
    query.emit({ type: 'result', subtype: 'success', result: 'second' })
    query.state('idle')
    await flush()
    expect(h.events.idle).toHaveBeenCalledTimes(1)
    expect(h.events.idle).toHaveBeenCalledWith(h.session, expect.objectContaining({ result: 'second' }))
    expect(h.events.running).toHaveBeenCalledTimes(2)
    expect(h.session.working).toBe(false)
  })
  it('follows background tasks as the set Claude Code reports, leaving ambient ones out, and stays busy while they run', async () => {
    const h = host()
    await h.session.send('a', 'run the tests in the background', 'next')
    const query = h.queries[0]!
    query.state('running'); query.take('a')
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm test' },
      { task_id: 'w1', task_type: 'monitor', description: 'watch', ambient: true }, { task_id: 'g1', task_type: 'local_agent', description: 'review' }] })
    query.emit({ type: 'result', subtype: 'success', result: '' }); query.state('idle')
    await flush()
    expect(h.session.background.map(task => [task.id, task.type])).toEqual([['b1', 'local_bash'], ['g1', 'local_agent']])
    expect(h.session).toMatchObject({ working: false, busy: true })
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    await flush()
    expect(h.events.tasks).toHaveBeenCalledTimes(2)
    expect(h.session.busy).toBe(false)
  })
  it('reports the query\'s end and is neither open nor busy after it', async () => {
    const h = host()
    await h.session.send('a', 'work', 'next')
    h.queries[0]!.close()
    await flush()
    expect(h.events.ended).toHaveBeenCalledWith(h.session, undefined)
    expect(h.session).toMatchObject({ open: false, busy: false })
    expect(h.ledger().map(message => message.uuid)).toEqual(['a'])
  })
  it('passes interrupts and task stops to the query', async () => {
    const h = host()
    await h.session.openSession()
    await h.session.interrupt()
    await h.session.stopTask('b1')
    expect(h.queries[0]!.interrupt).toHaveBeenCalled()
    expect(h.queries[0]!.stopTask).toHaveBeenCalledWith('b1')
  })
  it('is stale once a start would use other options', async () => {
    let fingerprint = 'f1'
    const h = host({ fingerprint: () => fingerprint })
    expect(await h.session.stale()).toBe(false)
    await h.session.openSession()
    expect(await h.session.stale()).toBe(false)
    fingerprint = 'f2'
    expect(await h.session.stale()).toBe(true)
  })
})
