/** What the terminal shows and understands, apart from how Ink draws it: its lines, its commands, and how it names tickets. */
import type { LocalMessage } from '../sources/local.ts'
import type { ActivityLine } from '../app/activity.ts'
import type { TerminalTicket } from '../remote.ts'

/** One line of the terminal's transcript, which scrolls up and never changes once printed. */
export interface Entry {
  id: string
  kind: 'header' | 'person' | 'agent' | 'ticket' | 'activity' | 'info' | 'error'
  text: string
  /** For an agent's message, what kind of reply it is; for a ticket, its stage. */
  tone?: string
}
let counter = 0
export const entry = (kind: Entry['kind'], text: string, tone?: string): Entry => ({ id: `e${++counter}`, kind, text, ...tone ? { tone } : {} })

/** A Markdown link shows as its text with the address after it: a terminal has no links to click. */
export const plain = (text: string): string => text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
export const messageEntry = (message: LocalMessage): Entry =>
  message.agent ? entry('agent', plain(message.text), message.kind) : entry('person', message.text)
export const activityEntries = (lines: readonly ActivityLine[]): Entry[] =>
  lines.map(line => entry('activity', line.text, line.error ? 'error' : line.kind))
/** The short name a ticket goes by in the terminal: the start of its id. */
export const short = (id: string): string => id.slice(0, 6)
/** A ticket's stage as a person reads it. */
export function stageText(ticket: TerminalTicket): string {
  if (ticket.held) return 'a person works in its Session'
  if (ticket.state === 'ended') return `ended${ticket.ended?.outcome ? `: ${ticket.ended.outcome}` : ''}`
  const action = 'action' in ticket && typeof ticket.action === 'string' ? ticket.action : ''
  return { queued: 'queued', working: 'working', person: action === 'answer' ? 'waits for your answer' : action === 'failed' ? 'failed' : 'awaiting review',
    idle: 'waiting for a message' }[ticket.stage as string] ?? ticket.stage
}
export const pullOf = (ticket: TerminalTicket): string | undefined => ticket.threads.find(thread => thread.source === 'github' && thread.url)?.url
export const ticketEntry = (ticket: TerminalTicket): Entry => {
  const pull = pullOf(ticket)
  return entry('ticket', `${short(ticket.id)} ${ticket.title} · ${stageText(ticket)}${pull ? ` · ${pull}` : ''}`, ticket.held ? 'held' : ticket.state === 'ended' ? 'ended' : ticket.stage)
}
/** What changed of a ticket that the terminal reports: its stage, a hold, its end. */
export const ticketMark = (ticket: TerminalTicket): string => `${ticket.state}:${ticket.stage}:${'action' in ticket ? String(ticket.action) : ''}:${ticket.held}`

/** The terminal's commands; anything else is a message to the agent. */
export const COMMANDS: readonly { name: string; args?: string; about: string }[] = [
  { name: 'new', about: 'start a new conversation; your next message opens it' },
  { name: 'threads', about: 'list the conversations' },
  { name: 'thread', args: '<n|id>', about: 'switch to a conversation' },
  { name: 'tickets', about: 'list the tickets' },
  { name: 'open', args: '<ticket> [now]', about: 'open a ticket\'s worker Session in Claude Code; now cuts its turn short' },
  { name: 'fork', args: '<ticket>', about: 'open a copy of a worker\'s Session in Claude Code, leaving the worker alone' },
  { name: 'stop', args: '<ticket>', about: 'stop a ticket' },
  { name: 'retry', args: '<ticket>', about: 'retry a ticket' },
  { name: 'activity', about: 'show or hide what the workers do' },
  { name: 'status', about: 'the service\'s health and load' },
  { name: 'panel', about: 'where the web panel is' },
  { name: 'pause', about: 'pause processing' },
  { name: 'resume', about: 'resume processing' },
  { name: 'help', about: 'this list' },
  { name: 'quit', about: 'leave the terminal; the service goes on' },
  { name: 'shutdown', about: 'stop the service and leave' },
]
export type Command = { kind: 'command'; name: string; args: string[] } | { kind: 'message'; text: string } | { kind: 'unknown'; text: string }
export function parse(input: string): Command | undefined {
  const text = input.trim()
  if (!text) return undefined
  if (!text.startsWith('/')) return { kind: 'message', text }
  const [name = '', ...args] = text.slice(1).split(/\s+/)
  const known = COMMANDS.find(command => command.name === name) ?? (name === 'exit' ? { name: 'quit' } : undefined)
  return known ? { kind: 'command', name: known.name, args } : { kind: 'unknown', text }
}
/** The commands a typed `/…` may mean, for the hint under the input. */
export const suggestions = (input: string) => input.startsWith('/') && !input.includes(' ')
  ? COMMANDS.filter(command => command.name.startsWith(input.slice(1))) : []
/** The ticket `ref` names: its number in the last list shown, or the start of its id. */
export function ticketNamed(ref: string | undefined, tickets: readonly TerminalTicket[], listed: readonly string[]): TerminalTicket | string {
  if (!ref) return 'Name a ticket: its number in /tickets or the start of its id'
  const byNumber = /^\d{1,3}$/.test(ref) ? listed[Number(ref) - 1] : undefined
  const found = byNumber ? tickets.filter(ticket => ticket.id === byNumber) : tickets.filter(ticket => ticket.id.startsWith(ref))
  if (found.length === 1) return found[0]!
  return found.length ? `${ref} names ${found.length} tickets; give more of its id` : `No ticket ${ref}`
}
