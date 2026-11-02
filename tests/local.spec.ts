import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { localSource, localTrigger, SOURCE } from '../src/sources/local.ts'

function host() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'local-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { local: { enabled: true, config: { operator: 'alice' } } },
    policy: { sources: { local: { allowed: [{ id: 'alice' }] } } } }))
  const plugin = localSource()
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  sources.register(plugin.kind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps = { store, engine, outbox: { send: vi.fn() }, commands: {} as never, sources, deployment: {} as never, ready: Promise.resolve(),
    configured: () => true, receive } as unknown as SourceContextDeps
  const ctx = sourceContextOf(deps, plugin.kind)
  plugin.attach(ctx)
  return { store, engine, plugin, sources, receive, ctx }
}
/** A request to the terminal routes, as the CLI makes it. */
async function call(handler: ReturnType<ReturnType<typeof localSource>['handler']>, method: string, path: string, body?: unknown) {
  let status = 0, payload: any
  const res = { writeHead: (code: number) => { status = code }, end: (text: string) => { payload = JSON.parse(text) } }
  const handled = await handler({ method, url: path } as never, res as never, new URL(path, 'http://localhost').pathname, async () => body)
  return { handled, status, body: payload }
}

describe('the terminal Source', () => {
  it('translates a person\'s message into an addressed Trigger on its conversation\'s Thread', () => {
    const trigger = localTrigger({ id: 'm1', from: 'alice', at: '2026-11-02T00:00:00.000Z', text: 'Fix the typo' }, 'c1')
    expect(trigger).toMatchObject({ source: SOURCE, threads: [{ source: SOURCE, id: 'c1' }], actor: { source: SOURCE, id: 'alice' }, human: true,
      addressed: 'direct', channel: { source: SOURCE, address: { conversation: 'c1', message: 'm1' } }, meta: { conversation: 'c1', messageId: 'm1' } })
    expect(localTrigger({ id: 'm1', from: 'alice', at: '', text: '' }, 'c1').id).toBe(trigger.id)
  })
  it('takes a request from the operator as an explicit candidate, and keeps the conversation', async () => {
    const h = host()
    const asked = await call(h.plugin.handler(), 'POST', '/local/messages', { text: 'Fix the typo in README' })
    expect(asked).toMatchObject({ handled: true, status: 200, body: { received: 'stored' } })
    const { conversation, trigger_id } = asked.body
    expect(h.engine.candidate(trigger_id)?.strength).toBe('explicit')
    const read = await call(h.plugin.handler(), 'GET', `/local/conversations/${conversation}`)
    expect(read.body.messages).toEqual([expect.objectContaining({ from: 'alice', text: 'Fix the typo in README' })])
    expect((await call(h.plugin.handler(), 'GET', '/local/conversations')).body.conversations).toEqual([expect.objectContaining({ id: conversation, messages: 1 })])
    h.store.close()
  })
  it('stores the agent\'s replies in their conversation once per message id, and reads them after a position', async () => {
    const h = host()
    const { body } = await call(h.plugin.handler(), 'POST', '/local/messages', { text: 'Hello' })
    const channel = { source: SOURCE, thread: `${SOURCE}:${body.conversation}`, address: { conversation: body.conversation, message: 'm' } }
    const reply = { id: 'r1', channel, text: 'On it', kind: 'acknowledgement' as const, ticketId: 'k1' }
    expect(await h.plugin.kind.channel!.send({ commands: {} as never }, reply)).toBe('sent')
    await h.plugin.kind.channel!.send({ commands: {} as never }, reply)
    const after = await call(h.plugin.handler(), 'GET', `/local/conversations/${body.conversation}?after=1`)
    expect(after.body).toMatchObject({ next: 2, messages: [{ id: 'r1', agent: true, kind: 'acknowledgement', text: 'On it', ticketId: 'k1' }] })
    h.store.close()
  })
  it('refuses a malformed request and leaves other paths alone', async () => {
    const h = host()
    expect((await call(h.plugin.handler(), 'POST', '/local/messages', { text: '' })).status).toBe(400)
    expect((await call(h.plugin.handler(), 'GET', '/orchestrator/api/state')).handled).toBe(false)
    h.store.close()
  })
  it('gives assessments the conversation as Thread context', async () => {
    const h = host()
    const { body } = await call(h.plugin.handler(), 'POST', '/local/messages', { text: 'First' })
    await call(h.plugin.handler(), 'POST', '/local/messages', { text: 'Second', conversation: body.conversation })
    const trigger = h.store.triggers.get(body.trigger_id)!
    const context = h.sources.threadContext(trigger)!
    expect((await context.read({} as never, 'thread')).messages.map(message => message.text)).toEqual(['First', 'Second'])
    h.store.close()
  })
})
