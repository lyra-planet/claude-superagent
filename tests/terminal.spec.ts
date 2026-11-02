/** The terminal's live view of the service, and a person taking a worker's Session to work in it directly. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { LiveEvent } from '../src/app/runtime.ts'
import { waitUntil } from './fixtures/async.ts'
import { feishu, MEMBER, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
/** A request to the terminal's routes, as the terminal makes it; `leave` closes its connection before the answer, as a person who quits does. */
async function local(method: string, path: string, json?: unknown, leave?: Promise<void>) {
  let status = 0, text = ''
  const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
  const req = { method, url: path, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, on: () => {}, async *[Symbol.asyncIterator]() { yield* chunks } }
  const closed = new Set<() => void>()
  const res = { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data; res.writableFinished = true }, write: () => true, headersSent: false,
    writableFinished: false, destroyed: false, on: (_event: string, listener: () => void) => { closed.add(listener) }, off: (_event: string, listener: () => void) => { closed.delete(listener) } }
  void leave?.then(() => { res.destroyed = true; for (const listener of closed) listener() })
  await h.runtime.handle(req as never, res as never)
  return { status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> }
}
function listen() {
  const events: LiveEvent[] = []
  h.runtime.bus.on('event', event => { events.push(event) })
  return events
}

it('streams a conversation\'s messages, its ticket\'s changes and what its worker does', async () => {
  const events = listen()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, local: { enabled: true, config: { operator: 'alice' } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, local: { allowed: [{ id: 'alice' }], admission: {} } } } })
  const asked = await local('POST', '/local/messages', { text: 'Fix the typo in README' })
  expect(asked.status).toBe(200)
  const conversation = asked.body.conversation as string
  expect(events).toContainEqual({ type: 'message', conversation, message: expect.objectContaining({ from: 'alice', text: 'Fix the typo in README' }) })
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: asked.body.trigger_id, title: 'Fix the typo', worktree_name: 'fix-typo', acknowledgement: 'On it.' })
  await h.runtime.idle()
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await waitUntil(() => events.some(event => event.type === 'ticket' && event.ticket.id === ticketId && event.ticket.conversation === conversation))
  await waitUntil(() => events.some(event => event.type === 'message' && event.message.agent && event.message.text === 'On it.'))
  const worker = h.claude.session(h.runtime.terminalTicket(ticketId)!.sessionId)
  worker.assistant({ type: 'text', text: 'Reading the README.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -n recieve README.md' } })
  await waitUntil(() => events.some(event => event.type === 'activity' && event.ticketId === ticketId && event.lines.some(line => line.text === 'Bash(grep -n recieve README.md)')))
  expect((await local('GET', `/local/tickets/${ticketId}/activity`)).body.lines).toEqual([{ kind: 'text', text: 'Reading the README.' },
    { kind: 'tool', text: 'Bash(grep -n recieve README.md)' }])
  expect((await local('GET', '/local/tickets')).body.tickets).toEqual([expect.objectContaining({ id: ticketId, conversation, held: false })])
})

it('hands a worker\'s Session to a person once its turn ended, holds what reaches it meanwhile, and hands it back', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId)
  await waitUntil(() => worker.status === 'running')
  const held = local('POST', `/local/tickets/${one.ticket.id}/hold`, {})
  await new Promise(resolve => setTimeout(resolve, 20))
  // The worker's turn goes on until it ends by itself.
  expect(worker.query).toBeDefined()
  worker.end({ result: 'Working on it.' })
  expect((await held).body).toEqual({ sessionId: one.sessionId, cwd: one.ticket.execution!.directory, claudeConfigDir: expect.any(String), stopped: 0,
    working: false, held: true,
    env: expect.objectContaining({ GIT_CONFIG_GLOBAL: expect.stringContaining('worker-gitconfig'), GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'agent-bot' }) })
  expect(worker.query).toBeUndefined()
  expect(h.runtime.terminalTicket(one.ticket.id)!.held).toBe(true)
  expect(h.runtime.executor.activeCount()).toBe(0)
  // A person's follow-up waits while the Session is theirs.
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: MEMBER }))
  await h.runtime.idle()
  expect(h.ticket(one.ticket.id).undelivered).toHaveLength(1)
  expect(worker.query).toBeUndefined()
  expect((await local('POST', `/local/tickets/${one.ticket.id}/release`)).body).toEqual({ released: true })
  await h.runtime.idle()
  await waitUntil(() => h.ticket(one.ticket.id).undelivered.length === 0)
  await waitUntil(() => h.claude.to(one.sessionId).some(message => message.text.includes('一的补充')))
})

it('cuts the worker\'s turn short when the person asks for the Session now', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId)
  await waitUntil(() => worker.status === 'running')
  const query = worker.query!
  await local('POST', `/local/tickets/${one.ticket.id}/hold`, { now: true })
  expect(query.interrupt).toHaveBeenCalled()
  expect(worker.query).toBeUndefined()
})

it('opens no event stream while the service stops, and answers a body that is not JSON with a 400', async () => {
  const req = { method: 'POST', url: '/local/messages', headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, on: () => {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"text": ') } }
  let status = 0
  await h.runtime.handle(req as never, { writeHead: (code: number) => { status = code }, end: () => {}, write: () => true, headersSent: false } as never)
  expect(status).toBe(400)
  const stopping = h.runtime.stop()
  expect((await local('GET', '/local/events')).status).toBe(503)
  await stopping
  h.stop = async () => {}
})

it('gives the Session back to the worker when the person leaves before their hold was granted', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId)
  await waitUntil(() => worker.status === 'running')
  let quit!: () => void
  const held = local('POST', `/local/tickets/${one.ticket.id}/hold`, {}, new Promise<void>(resolve => { quit = resolve }))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(h.runtime.executor.held(one.ticket.id)).toBe(true)
  // Ctrl-C while the worker's turn runs: no one would hand the Session back.
  quit()
  worker.end({ result: 'Working on it.' })
  expect((await held).body).toBeUndefined()
  expect(h.runtime.executor.held(one.ticket.id)).toBe(false)
  // What reaches the worker goes on reaching it.
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: MEMBER }))
  await h.runtime.idle()
  await waitUntil(() => h.claude.to(one.sessionId).some(message => message.text.includes('一的补充')))
})

it('ends the worker\'s turn without a failure when the person cuts it short for the Session', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.claude.session(one.sessionId)
  await waitUntil(() => worker.status === 'running')
  // Claude Code ends the interrupted turn with an error result (as the stand-in does).
  await local('POST', `/local/tickets/${one.ticket.id}/hold`, { now: true })
  await h.runtime.idle()
  expect(h.ticket(one.ticket.id).assignments.at(-1)?.report?.state).not.toBe('failed')
  expect(h.ticket(one.ticket.id).ended).toBeUndefined()
})

it('streams each committed change of a ticket, such as its worker\'s report', async () => {
  const events = listen()
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const before = events.filter(event => event.type === 'ticket').length
  await h.runTool(one.ticket.id, 'orchestrator_report', { state: 'ready', summary: 'Fixed it in PR #3.' })
  await waitUntil(() => events.filter(event => event.type === 'ticket').length > before)
  // A ready report without a pull request ends the ticket, as upstream's core does.
  expect(events.filter(event => event.type === 'ticket').at(-1)).toMatchObject({ ticket: { id: one.ticket.id, summary: 'Fixed it in PR #3.' } })
})
