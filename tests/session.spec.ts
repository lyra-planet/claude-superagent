import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeSession, type Sdk, type SessionEvents } from '../src/app/session.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))
/** A query the test drives: it records what the Session sends and yields what the test emits. */
class FakeQuery {
  readonly sent: SDKUserMessage[] = []
  private queue: SDKMessage[] = []
  private wake?: () => void
  private ended = false
  readonly interrupt = vi.fn(async () => {})
  readonly stopTask = vi.fn(async (_: string) => {})
  constructor(prompt: AsyncIterable<SDKUserMessage>, readonly options: Record<string, unknown>) {
    void (async () => { for await (const message of prompt) this.sent.push(message) })()
  }
  emit(message: Record<string, unknown>): void { this.queue.push(message as unknown as SDKMessage); this.wake?.() }
  close(): void { this.ended = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}
function host(options: { exists?: boolean; history?: string[]; fingerprint?: () => string } = {}) {
  const queries: FakeQuery[] = []
  let exists = options.exists ?? false
  const sdk = {
    query: ({ prompt, options: given }: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      const query = new FakeQuery(prompt, given); queries.push(query); exists = true; return query
    },
    getSessionInfo: async (id: string) => exists ? { sessionId: id } : undefined,
    getSessionMessages: async () => (options.history ?? []).map(uuid => ({ type: 'user', uuid, message: {} })),
  } as unknown as Sdk
  const events = { turnEnded: vi.fn(), ended: vi.fn() } satisfies SessionEvents
  const session = new ClaudeSession('s1', '/work/t1', async () => ({ options: { model: 'm' }, fingerprint: options.fingerprint?.() ?? 'f1' }), events, sdk)
  return { session, queries, events }
}

describe('ClaudeSession', () => {
  it('starts a Session with its id, and resumes it once it exists', async () => {
    const h = host()
    await h.session.openSession()
    expect(h.queries[0]!.options).toMatchObject({ model: 'm', cwd: '/work/t1', sessionId: 's1' })
    expect(h.queries[0]!.options).not.toHaveProperty('resume')
    await h.session.close()
    expect(h.session.open).toBe(false)
    await h.session.openSession()
    expect(h.queries[1]!.options).toMatchObject({ resume: 's1' })
    expect(h.queries[1]!.options).not.toHaveProperty('sessionId')
  })
  it('sends each message once, skipping one its history already holds, so a retry after a restart is not doubled', async () => {
    const h = host({ exists: true, history: ['u1'] })
    await h.session.send('u1', 'old', 'next')
    expect(h.queries).toHaveLength(0)
    await h.session.send('u2', 'new', 'next')
    await h.session.send('u2', 'new', 'next')
    await flush()
    expect(h.queries[0]!.sent.map(message => message.uuid)).toEqual(['u2'])
  })
  it('maps a delivery to the SDK\'s priority, and an injection to a message that starts no turn', async () => {
    const h = host()
    await h.session.send('a', 'steer', 'next')
    await h.session.send('b', 'queue', 'later')
    await h.session.send('c', 'note', 'inject')
    await flush()
    const [steer, queue, note] = h.queries[0]!.sent
    expect(steer).toMatchObject({ type: 'user', message: { role: 'user', content: 'steer' }, priority: 'next' })
    expect(queue).toMatchObject({ priority: 'later' })
    expect(note).toMatchObject({ shouldQuery: false })
    expect(note).not.toHaveProperty('priority')
  })
  it('stays busy while background tasks a turn started run, and says so when the turn ends', async () => {
    const h = host()
    await h.session.send('a', 'run the tests in the background', 'next')
    expect(h.session.busy).toBe(true)
    const idle = h.session.whenIdle()
    const query = h.queries[0]!
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'b1' })
    query.emit({ type: 'result', subtype: 'success' })
    await idle
    expect(h.events.turnEnded).toHaveBeenCalledWith(h.session, expect.objectContaining({ type: 'result' }), true)
    expect(h.session.busy).toBe(true)
    expect(h.session.background).toEqual(['b1'])
    // The task's end starts a turn by itself (an init), which ends with a result of its own.
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' })
    query.emit({ type: 'system', subtype: 'init' })
    await flush()
    expect(h.session.busy).toBe(true)
    query.emit({ type: 'result', subtype: 'success' })
    await flush()
    expect(h.session.busy).toBe(false)
    expect(h.events.turnEnded).toHaveBeenLastCalledWith(h.session, expect.anything(), false)
  })
  it('reports the query\'s end and is neither open nor busy after it', async () => {
    const h = host()
    await h.session.send('a', 'work', 'next')
    h.queries[0]!.close()
    await flush()
    expect(h.events.ended).toHaveBeenCalledWith(h.session, undefined)
    expect(h.session).toMatchObject({ open: false, busy: false })
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
