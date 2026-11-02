/**
 * The interactive terminal, drawn as Claude Code's own: a transcript that scrolls up, an input box under it, and a status line.
 * A message goes to the agent in the current conversation; the agent's replies, its tickets' changes and what their workers do
 * arrive live. Commands start with `/` (see `COMMANDS`).
 */
import { Box, Static, Text, useApp, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { LiveEvent, ServiceClient, TerminalTicket } from '../remote.ts'
import { COMMANDS, activityEntries, entry, messageEntry, parse, short, stageText, suggestions, ticketEntry, ticketMark, ticketNamed, type Entry } from './model.ts'

/** What the terminal leaves to its caller: open a worker's Session in Claude Code, or stop the service. */
export type Exit = { kind: 'quit' } | { kind: 'shutdown' } | { kind: 'open'; ticket: TerminalTicket; now: boolean; fork: boolean }
export interface AppProps {
  client: Pick<ServiceClient, 'call' | 'ok' | 'conversations' | 'conversation' | 'ask' | 'tickets' | 'follow' | 'base'>
  stateDir: string
  /** Back from Claude Code: the transcript above is already on screen. */
  resumed?: { conversation?: string; note: string }
  onExit(exit: Exit, conversation?: string): void
}
interface Status { connected: boolean; running: number; queued: number; maxWorkers: number; paused: boolean; problems: string[] }

export function App({ client, stateDir, resumed, onExit }: AppProps) {
  const { exit } = useApp()
  const [entries, setEntries] = useState<Entry[]>(() => resumed ? [entry('info', resumed.note)] : [])
  const [conversation, setConversation] = useState<string | undefined>(resumed?.conversation)
  const [tickets, setTickets] = useState<TerminalTicket[]>([])
  const [listed, setListed] = useState<string[]>([])
  const [threads, setThreads] = useState<string[]>([])
  const [activity, setActivity] = useState(true)
  const [status, setStatus] = useState<Status>({ connected: false, running: 0, queued: 0, maxWorkers: 0, paused: false, problems: [] })
  const [busy, setBusy] = useState<string>()
  const [input, setInput] = useState('')
  const [cursor, setCursor] = useState(0)
  const history = useRef<string[]>([]), recall = useRef(-1)
  // Event handlers read the latest state through refs: they are bound once.
  const current = useRef({ conversation, tickets, activity })
  current.current = { conversation, tickets, activity }
  const marks = useRef(new Map<string, string>())
  const print = (...items: Entry[]) => { setEntries(before => [...before, ...items]) }
  const fail = (error: unknown) => { print(entry('error', error instanceof Error ? error.message : String(error))) }
  const leave = (how: Exit) => { onExit(how, current.current.conversation); exit() }

  // Once: what there is to show, then the live events and the service's load.
  useEffect(() => {
    const stop = new AbortController()
    void (async () => {
      const [{ conversations }, { tickets: known }] = await Promise.all([client.conversations(), client.tickets()])
      setTickets(known)
      for (const ticket of known) marks.current.set(ticket.id, ticketMark(ticket))
      if (resumed) return
      const header = entry('header', `claude-superagent · ${stateDir}`)
      const latest = [...conversations].sort((a, b) => a.at.localeCompare(b.at)).at(-1)
      if (!latest) { print(header, entry('info', 'Type a request for the agent, or /help.')); return }
      const { messages } = await client.conversation(latest.id)
      setConversation(latest.id)
      print(header, entry('info', `Conversation ${latest.id} (${latest.messages} messages); /new starts another, /threads lists them.`),
        ...messages.slice(-12).map(messageEntry))
    })().catch(fail)
    void client.follow(event => { onEvent(event) }, stop.signal, connected => { setStatus(before => ({ ...before, connected })) })
    const poll = async () => {
      const { body } = await client.call('GET', '/orchestrator/api/state').catch(() => ({ body: undefined }))
      if (!body?.load) return
      const problems = [body.setup?.problem?.code, ...Object.entries(body.health ?? {}).flatMap(([name, value]) => (value as { state?: string }).state === 'error' ? [name] : [])].filter(Boolean)
      setStatus(before => ({ ...before, running: body.load.running, queued: body.load.queued, maxWorkers: body.load.maxWorkers, paused: body.paused, problems }))
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 5000)
    return () => { stop.abort(); clearInterval(timer) }
  }, [])

  /** What a live event shows: messages of the current conversation, its tickets' changes, what their workers do. */
  function onEvent(event: LiveEvent): void {
    const { conversation: here, tickets: known, activity: showing } = current.current
    if (event.type === 'message') {
      if (event.conversation === here) print(messageEntry(event.message))
      else if (event.message.agent) print(entry('info', `A reply in conversation ${event.conversation}: /thread ${event.conversation} to read it.`))
      return
    }
    if (event.type === 'ticket') {
      const ticket = event.ticket
      setTickets(before => [ticket, ...before.filter(item => item.id !== ticket.id)])
      const mark = ticketMark(ticket)
      if (marks.current.get(ticket.id) === mark) return
      marks.current.set(ticket.id, mark)
      if (!here || ticket.conversation === here) print(ticketEntry(ticket))
      return
    }
    const ticket = known.find(item => item.id === event.ticketId)
    if (showing && ticket && (!here || ticket.conversation === here)) print(...activityEntries(event.lines))
  }

  async function run(text: string): Promise<void> {
    const command = parse(text)
    if (!command) return
    if (command.kind === 'message') {
      print(entry('person', command.text))
      setBusy('handing it to the agent')
      try { const asked = await client.ask(command.text, conversation); setConversation(asked.conversation) } catch (error) { fail(error) } finally { setBusy(undefined) }
      return
    }
    if (command.kind === 'unknown') { print(entry('error', `${command.text} is not a command; /help lists them.`)); return }
    const [first] = command.args
    const named = () => {
      const found = ticketNamed(first, tickets, listed)
      if (typeof found === 'string') { print(entry('error', found)); return undefined }
      return found
    }
    switch (command.name) {
      case 'help': print(...COMMANDS.map(item => entry('info', `/${item.name}${item.args ? ` ${item.args}` : ''}  ${item.about}`))); return
      case 'new': setConversation(undefined); print(entry('info', 'Your next message starts a new conversation.')); return
      case 'threads': {
        const { conversations } = await client.conversations()
        const ordered = [...conversations].sort((a, b) => b.at.localeCompare(a.at))
        setThreads(ordered.map(item => item.id))
        print(...ordered.length ? ordered.map((item, index) => entry('info', `${index + 1}. ${item.id}  ${item.messages} messages  ${item.first}`)) : [entry('info', 'No conversation yet.')])
        return
      }
      case 'thread': {
        const id = first && /^\d{1,3}$/.test(first) ? threads[Number(first) - 1] : first
        if (!id) { print(entry('error', 'Name a conversation: its number in /threads or its id')); return }
        const { messages } = await client.conversation(id).catch(error => { fail(error); return { messages: undefined } })
        if (!messages) return
        setConversation(id)
        print(entry('info', `Conversation ${id}`), ...messages.slice(-12).map(messageEntry))
        return
      }
      case 'tickets': {
        const { tickets: fresh } = await client.tickets()
        setTickets(fresh); setListed(fresh.map(ticket => ticket.id))
        print(...fresh.length ? fresh.map((ticket, index) => entry('info', `${index + 1}. ${short(ticket.id)}  ${ticket.title} · ${stageText(ticket)}`)) : [entry('info', 'No ticket yet.')])
        return
      }
      case 'open': case 'fork': {
        const ticket = named()
        if (ticket) leave({ kind: 'open', ticket, now: command.args.includes('now'), fork: command.name === 'fork' })
        return
      }
      case 'stop': case 'retry': {
        const ticket = named()
        if (!ticket) return
        await client.ok('POST', `/orchestrator/api/tickets/${ticket.id}/${command.name}`).then(() => {
          print(entry('info', `${command.name === 'stop' ? 'Stopped' : 'Retried'} ${short(ticket.id)} ${ticket.title}`))
        }, fail)
        return
      }
      case 'activity': setActivity(!activity); print(entry('info', activity ? 'Worker activity hidden.' : 'Worker activity shown.')); return
      case 'status':
        print(entry('info', `${status.connected ? 'connected' : 'reconnecting'} · ${status.running}/${status.maxWorkers} workers running · ${status.queued} queued${status.paused ? ' · paused' : ''}${status.problems.length ? ` · problems: ${status.problems.join(', ')}` : ''}`))
        return
      case 'panel': print(entry('info', `Web panel: ${client.base}/`)); return
      case 'pause': case 'resume':
        await client.ok('POST', '/orchestrator/api/executor/pause', { paused: command.name === 'pause' }).then(() => {
          setStatus(before => ({ ...before, paused: command.name === 'pause' })); print(entry('info', command.name === 'pause' ? 'Processing paused.' : 'Processing resumed.'))
        }, fail)
        return
      case 'quit': leave({ kind: 'quit' }); return
      case 'shutdown': leave({ kind: 'shutdown' }); return
    }
  }

  useInput((typed, key) => {
    if (key.ctrl && typed === 'c') { if (input) { setInput(''); setCursor(0) } else leave({ kind: 'quit' }); return }
    if (key.return) {
      const text = input
      setInput(''); setCursor(0); recall.current = -1
      if (text.trim()) history.current = [text, ...history.current.filter(item => item !== text)].slice(0, 100)
      void run(text).catch(fail)
      return
    }
    if (key.escape) { setInput(''); setCursor(0); return }
    if (key.upArrow || key.downArrow) {
      const next = Math.max(-1, Math.min(history.current.length - 1, recall.current + (key.upArrow ? 1 : -1)))
      recall.current = next
      const text = next < 0 ? '' : history.current[next]!
      setInput(text); setCursor(text.length); return
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return }
    if (key.rightArrow) { setCursor(Math.min(input.length, cursor + 1)); return }
    if (key.ctrl && typed === 'a') { setCursor(0); return }
    if (key.ctrl && typed === 'e') { setCursor(input.length); return }
    if (key.ctrl && typed === 'u') { setInput(input.slice(cursor)); setCursor(0); return }
    if (key.ctrl && typed === 'w') {
      const start = input.slice(0, cursor).replace(/\S+\s*$/, '').length
      setInput(input.slice(0, start) + input.slice(cursor)); setCursor(start); return
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      setInput(input.slice(0, cursor - 1) + input.slice(cursor)); setCursor(cursor - 1); return
    }
    if (key.ctrl || key.meta || key.tab || !typed) return
    // A paste arrives as one piece: its line breaks become spaces, as one message.
    const text = typed.replace(/\r\n?|\n/g, ' ')
    setInput(input.slice(0, cursor) + text + input.slice(cursor)); setCursor(cursor + text.length)
  })

  const hints = suggestions(input)
  return <>
    <Static items={entries}>{item => <Line key={item.id} item={item} />}</Static>
    <Box flexDirection="column" marginTop={1}>
      {busy && <Text color="magenta">✻ {busy}…</Text>}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>
          <Text color="gray">{'> '}</Text>
          {input ? <>{input.slice(0, cursor)}<Text inverse>{input[cursor] ?? ' '}</Text>{input.slice(cursor + 1)}</> : <><Text inverse> </Text><Text color="gray">Ask the agent, or type / for commands</Text></>}
        </Text>
      </Box>
      {hints.slice(0, 8).map(item => <Text key={item.name} color="gray">  /{item.name}{item.args ? ` ${item.args}` : ''}  <Text dimColor>{item.about}</Text></Text>)}
      <Text color="gray">
        <Text color={status.connected ? 'green' : 'yellow'}>●</Text> {status.connected ? 'live' : 'reconnecting'} · {status.running}/{status.maxWorkers} working · {status.queued} queued
        {status.paused ? <Text color="yellow"> · paused</Text> : null}
        {status.problems.length ? <Text color="red"> · {status.problems.join(', ')}</Text> : null}
        {' · '}{conversation ? `conversation ${conversation}` : 'new conversation'}{activity ? '' : ' · activity hidden'} · /help
      </Text>
    </Box>
  </>
}

/** One transcript line, colored as Claude Code colors its own; one Text each, so a wide glyph does not pad its line. */
function Line({ item }: { item: Entry }) {
  switch (item.kind) {
    case 'header': return <Box marginBottom={1}><Text><Text color="magenta">✻</Text> <Text bold>{item.text}</Text></Text></Box>
    case 'person': return <Box marginTop={1}><Text><Text color="gray">{'>'}</Text> {item.text}</Text></Box>
    case 'agent': {
      const color = item.tone === 'acknowledgement' ? 'cyan' : item.tone === 'question' ? 'yellow' : 'green'
      return <Box marginTop={1}><Text><Text color={color}>⏺</Text> {item.text}</Text></Box>
    }
    case 'ticket': return <Text color={item.tone === 'ended' ? 'gray' : item.tone === 'person' || item.tone === 'held' ? 'yellow' : 'blue'}>  ● {item.text}</Text>
    case 'activity': return <Text color={item.tone === 'error' ? 'red' : 'gray'}>  ⎿ {item.text}</Text>
    case 'error': return <Text color="red">  {item.text}</Text>
    default: return <Text color="gray">  {item.text}</Text>
  }
}
