/** The interactive terminal, drawn by Ink against a stand-in service. */
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiveEvent, TerminalTicket } from '../src/remote.ts'
import { App, type AppProps, type Exit } from '../src/tui/app.tsx'
import { activityOf } from '../src/app/activity.ts'
import { parse, plain, ticketNamed, tilde } from '../src/tui/model.ts'
import { waitUntil } from './fixtures/async.ts'

const ticket = (overrides: Partial<TerminalTicket> = {}): TerminalTicket => ({ id: 'a1b2c3d4e5f6', title: 'Fix the README typo', state: 'open', stage: 'working',
  threads: [], held: false, sessionId: 's1', conversation: 'c1', ...overrides } as TerminalTicket)
function service() {
  let emit: (event: LiveEvent) => void = () => {}
  const client = {
    base: 'http://127.0.0.1:3082',
    conversations: vi.fn(async () => ({ conversations: [{ id: 'c1', messages: 2, first: 'Fix the typo', at: '2026-11-02T10:00:00Z' }] })),
    conversation: vi.fn(async (id: string) => ({ next: 2, messages: id === 'c1' ? [{ id: 'm1', from: 'alice', at: '', text: 'Fix the typo' },
      { id: 'm2', from: 'agent', at: '', text: 'On it: fixing [the README](https://github.com/acme/widgets/blob/main/README.md).', agent: true as const, kind: 'acknowledgement' as const }] : [] })),
    ask: vi.fn(async (_text: string, conversation?: string) => ({ conversation: conversation ?? 'c2', trigger_id: 't', received: 'stored' })),
    tickets: vi.fn(async () => ({ tickets: [ticket()] })),
    follow: vi.fn(async (onEvent: (event: LiveEvent) => void, _signal: AbortSignal, connected: (up: boolean) => void) => { emit = onEvent; connected(true) }),
    call: vi.fn(async () => ({ status: 200, body: { load: { running: 1, queued: 0, maxWorkers: 3 }, paused: false, health: {}, setup: { problem: null } } })),
    ok: vi.fn(async () => ({})),
  }
  const exits: Exit[] = []
  const props: AppProps = { client: client as unknown as AppProps['client'], stateDir: '/srv/state', onExit: exit => { exits.push(exit) } }
  return { client, props, exits, emit: (event: LiveEvent) => { emit(event) } }
}
let unmount: (() => void) | undefined
afterEach(() => { unmount?.(); unmount = undefined })
function draw(props: AppProps) {
  const app = render(<App {...props} />)
  unmount = app.unmount
  const all = () => app.frames.join('\n')
  const type = async (text: string) => { app.stdin.write(text); await new Promise(resolve => setTimeout(resolve, 10)) }
  return { app, all, type, enter: () => type('\r') }
}

it('opens on the latest conversation, its last messages and the service\'s load, and links read as text', async () => {
  const s = service()
  const { all, app } = draw(s.props)
  await waitUntil(() => all().includes('On it: fixing the README (https://github.com/acme/widgets/blob/main/README.md).'))
  expect(all()).toContain('claude-superagent · /srv/state')
  expect(all()).toContain('> Fix the typo')
  await waitUntil(() => app.lastFrame()!.includes('1/3 working') && app.lastFrame()!.includes('conversation c1'))
  expect(app.lastFrame()).toContain('live')
})

it('hands what a person types to the agent in the current conversation, and a new one after /new', async () => {
  const s = service()
  const { all, type, enter } = draw(s.props)
  await waitUntil(() => all().includes('conversation c1'))
  await type('还有 CONTRIBUTING.md 也看一下'); await enter()
  await waitUntil(() => s.client.ask.mock.calls.length === 1)
  expect(s.client.ask).toHaveBeenCalledWith('还有 CONTRIBUTING.md 也看一下', 'c1')
  expect(all()).toContain('> 还有 CONTRIBUTING.md 也看一下')
  await type('/new'); await enter()
  await type('Another request'); await enter()
  await waitUntil(() => s.client.ask.mock.calls.length === 2)
  expect(s.client.ask).toHaveBeenLastCalledWith('Another request', undefined)
})

it('shows the agent\'s replies, its tickets\' changes once each and what their workers do, live, and hides the workers on /activity', async () => {
  const s = service()
  const { all, type, enter, app } = draw(s.props)
  await waitUntil(() => all().includes('conversation c1'))
  s.emit({ type: 'message', conversation: 'c1', message: { id: 'm3', from: 'agent', at: '', text: 'PR #2 is ready.', agent: true, kind: 'reply' } })
  const pull = [{ key: 'github:2', source: 'github', title: 'PR', url: 'https://github.com/acme/widgets/pull/2', facts: {} }]
  s.emit({ type: 'ticket', ticket: ticket({ stage: 'person', action: 'review', threads: pull } as never) })
  s.emit({ type: 'ticket', ticket: ticket({ stage: 'person', action: 'review', threads: pull, summary: 'saved again' } as never) })
  s.emit({ type: 'activity', ticketId: 'a1b2c3d4e5f6', lines: [{ kind: 'tool', text: 'Bash(git push)' }] })
  s.emit({ type: 'message', conversation: 'other', message: { id: 'm9', from: 'agent', at: '', text: 'elsewhere', agent: true, kind: 'reply' } })
  await waitUntil(() => all().includes('⎿ Bash(git push)'))
  expect(all()).toContain('● PR #2 is ready.')
  expect(all()).toContain('◆ a1b2c3 Fix the README typo · awaiting review · https://github.com/acme/widgets/pull/2')
  // Ink prints a transcript line once; the last frame holds them all, so a change printed twice would show twice there.
  expect(app.lastFrame()!.split('◆ a1b2c3').length - 1).toBe(1)
  expect(all()).toContain('A reply in conversation other')
  expect(all()).not.toContain('elsewhere')
  await type('/activity'); await enter()
  s.emit({ type: 'activity', ticketId: 'a1b2c3d4e5f6', lines: [{ kind: 'tool', text: 'Bash(npm test)' }] })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(all()).not.toContain('Bash(npm test)')
})

it('lists the tickets by number, and leaves the terminal to open one\'s worker Session in Claude Code', async () => {
  const s = service()
  const { all, type, enter } = draw(s.props)
  await waitUntil(() => all().includes('conversation c1'))
  await type('/tickets'); await enter()
  await waitUntil(() => all().includes('1. a1b2c3  Fix the README typo · working'))
  await type('/open 1 now'); await enter()
  await waitUntil(() => s.exits.length === 1)
  expect(s.exits[0]).toMatchObject({ kind: 'open', now: true, fork: false, ticket: { id: 'a1b2c3d4e5f6' } })
})

it('names an unknown command, lists the commands, and leaves on Ctrl-C with nothing typed', async () => {
  const s = service()
  const { all, type, enter } = draw(s.props)
  await waitUntil(() => all().includes('conversation c1'))
  await type('/frobnicate'); await enter()
  await waitUntil(() => all().includes('/frobnicate is not a command'))
  await type('/help'); await enter()
  await waitUntil(() => all().includes('/open <ticket> [now]'))
  await type('half typed'); await type('\x03')
  expect(s.exits).toEqual([])
  await type('\x03')
  await waitUntil(() => s.exits.length === 1)
  expect(s.exits[0]).toEqual({ kind: 'quit' })
})

it('parses commands and names tickets by number or by the start of their id', () => {
  expect(parse('  ')).toBeUndefined()
  expect(parse('/open a1b2 now')).toEqual({ kind: 'command', name: 'open', args: ['a1b2', 'now'] })
  expect(parse('/exit')).toEqual({ kind: 'command', name: 'quit', args: [] })
  expect(parse('fix it')).toEqual({ kind: 'message', text: 'fix it' })
  const known = [ticket(), ticket({ id: 'a1ffff000000', title: 'Other' })]
  expect(ticketNamed('2', known, ['a1b2c3d4e5f6', 'a1ffff000000'])).toMatchObject({ title: 'Other' })
  expect(ticketNamed('a1b2', known, [])).toMatchObject({ id: 'a1b2c3d4e5f6' })
  expect(ticketNamed('a1', known, [])).toBe('a1 names 2 tickets; give more of its id')
  expect(plain('see [PR #2](https://x.y/2)')).toBe('see PR #2 (https://x.y/2)')
})

it('sends what arrives in one piece with a line break at its end, as a fast typist or a paste does', async () => {
  const s = service()
  const { all, type } = draw(s.props)
  await waitUntil(() => all().includes('conversation c1'))
  await type('/tickets\r')
  await waitUntil(() => all().includes('1. a1b2c3  Fix the README typo · working'))
  await type('line one\nline two\r')
  await waitUntil(() => s.client.ask.mock.calls.length === 1)
  expect(s.client.ask).toHaveBeenCalledWith('line one line two', 'c1')
})

it('prints a ticket\'s line again only when what it shows changed', async () => {
  const s = service()
  const { app, all } = draw(s.props)
  await waitUntil(() => all().includes('conversation c1'))
  s.emit({ type: 'ticket', ticket: ticket({ id: 'b0b0b0b0b0b0', stage: 'working', action: 'run' } as never) })
  s.emit({ type: 'ticket', ticket: ticket({ id: 'b0b0b0b0b0b0', stage: 'working', action: 'wait' } as never) })
  s.emit({ type: 'ticket', ticket: ticket({ id: 'b0b0b0b0b0b0', stage: 'idle' } as never) })
  await waitUntil(() => app.lastFrame()!.includes('◆ b0b0b0 Fix the README typo · waiting for a message'))
  expect(app.lastFrame()!.split('◆ b0b0b0 Fix the README typo · working').length - 1).toBe(1)
})

it('names a state directory under the home directory as a shell does', () => {
  expect(tilde('/home/alice/.claude-superagent', '/home/alice')).toBe('~/.claude-superagent')
  expect(tilde('/home/alice', '/home/alice')).toBe('~')
  expect(tilde('/home/alicia/state', '/home/alice')).toBe('/home/alicia/state')
  expect(tilde('/srv/state', '')).toBe('/srv/state')
})

it('shortens the long absolute paths in a worker\'s command, as in a file tool\'s, and leaves a URL whole', () => {
  const command = 'git commit -q -F /srv/state/work/.drafts/fix-typo-1/commit.txt && gh pr view https://github.com/acme/widgets/pull/1 > /dev/null'
  expect(activityOf({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }))
    .toEqual([{ kind: 'tool', text: 'Bash(git commit -q -F …/.drafts/fix-typo-1/commit.txt && gh pr view https://github.com/acme/widgets/pull/1 > /dev/null)' }])
})

it('keeps a wrapped line of the ticket list under its own indent', async () => {
  const s = service()
  s.client.tickets.mockResolvedValue({ tickets: [ticket({ title: 'Add an .editorconfig with UTF-8, LF line endings, 2-space indents and a final newline, then open a PR' })] })
  const { all, type, enter } = draw(s.props)
  await waitUntil(() => all().includes('conversation c1'))
  await type('/tickets'); await enter()
  await waitUntil(() => all().includes('1. a1b2c3'))
  const listed = all().split('\n').slice(all().split('\n').findIndex(line => line.includes('1. a1b2c3')))
  expect(listed[1]).toMatch(/^ {2}/)
  expect(listed.slice(0, 2).join(' ')).toContain('then open a PR · working')
})
