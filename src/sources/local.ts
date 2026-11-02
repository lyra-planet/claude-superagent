/**
 * The terminal Source: requests a person hands the agent with `claude-superagent ask`, and the agent's replies, which
 * `claude-superagent inbox` reads. A conversation is one Thread; a person's message there is always addressed to the agent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind, SourcePlugin } from './kind.ts'

export const SOURCE = 'local'
/** One message of a conversation: a person's (`from` their name) or the agent's (`agent`), with what kind of reply it is. */
export interface LocalMessage { id: string; from: string; at: string; text: string; agent?: true; kind?: OutboundMessage['kind']; ticketId?: string }
const ConfigSchema = z.object({
  /** The name a person who asks from this machine goes by, which the Policy's allowed list names. */
  operator: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('operator'),
}).strict()
export type LocalConfig = z.infer<typeof ConfigSchema>
const ConversationId = z.string().regex(/^[a-z0-9-]{1,64}$/)
/** What the local Source keeps: the conversations, and a message log per conversation. */
interface LocalStore { get: SourceContext['state']['get']; set: SourceContext['state']['set'] }

const threadId = (conversation: string) => conversation
const messages = (state: LocalStore, conversation: string): LocalMessage[] => state.get(KV.local.messages(conversation)) ?? []
/** Hears each message a conversation gets, once. */
export type LocalObserver = (conversation: string, message: LocalMessage) => void
function append(state: LocalStore, conversation: string, message: LocalMessage, observe?: LocalObserver): void {
  const log = messages(state, conversation)
  if (log.some(item => item.id === message.id)) return
  state.set(KV.local.messages(conversation), [...log, message])
  const known = state.get(KV.local.conversations) ?? []
  if (!known.includes(conversation)) state.set(KV.local.conversations, [...known, conversation])
  observe?.(conversation, message)
}

/**
 * The local Source with its Channel and Thread reader bound to `state`, which the runtime gives it once the Source's context
 * exists. A reply goes into its conversation's log, once per outbound message id.
 */
export function localSource(observe?: LocalObserver): SourcePlugin<LocalConfig> & { attach(ctx: SourceContext): void; handler(): LocalHandler } {
  let context: SourceContext | undefined
  const state = (): LocalStore => {
    if (!context) throw new Error('The local Source is not attached yet')
    return context.state
  }
  const kind: SourceKind<LocalConfig> = {
    kind: SOURCE,
    title: { zh: '终端', en: 'Terminal' },
    description: { zh: '在这台机器上用 claude-superagent ask 交给智能体的请求，回复用 claude-superagent inbox 看。', en: 'Requests handed to the agent on this machine with claude-superagent ask; read the replies with claude-superagent inbox.' },
    schema: ConfigSchema,
    fields: [{ key: 'operator', type: 'text', pattern: '[A-Za-z0-9._-]+', label: { zh: '提问人的名字', en: 'Name of the person who asks' },
      hint: { zh: '在这台机器上提问的人用这个名字，策略的名单要写它。', en: 'A person asking on this machine goes by this name, which the Policy\'s list must name.' } }],
    health: ['local'],
    scope: () => ({ listened: true, observed: false, row: 'terminal' }),
    channel: {
      send: async (_host, message) => {
        const conversation = message.channel.address.conversation ?? ''
        append(state(), conversation, { id: message.id, from: 'agent', at: new Date().toISOString(), text: message.text, agent: true, kind: message.kind,
          ...message.ticketId ? { ticketId: message.ticketId } : {} }, observe)
        return 'sent'
      },
      link: address => ({ url: '', label: { zh: `终端对话 ${address.conversation ?? ''}`, en: `Terminal conversation ${address.conversation ?? ''}` } }),
    },
    threadContext: {
      messageId: trigger => String(trigger.meta.messageId ?? ''),
      read: async (_commands, trigger) => {
        const log = messages(state(), String(trigger.meta.conversation ?? ''))
        const listed = log.map(item => ({ id: item.id, from: item.from, at: item.at, text: item.text, ...item.agent ? { bot: true as const } : {} }))
        return { messages: listed, body: { messages: listed } }
      },
    },
    find: query => {
      const id = /\b[a-z0-9]{8}-[a-z0-9-]{4,}\b/.exec(query)?.[0]
      return { threads: id ? [`${SOURCE}:${id}`] : [], terms: [] }
    },
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '能在终端发起工作的人', en: 'People who may originate work from the terminal' }, columns: [
        { key: 'id', type: 'text', label: { zh: '名字', en: 'Name' } }, { key: 'name', type: 'text', label: { zh: '备注', en: 'Note' }, optional: true }] }],
      explicit: { zh: '名单里的人用 claude-superagent ask 提问。', en: 'Someone on the list asks with claude-superagent ask.' },
      rows: () => [{ id: 'terminal', label: { zh: '终端', en: 'Terminal' }, note: { zh: '直接对话', en: 'Direct' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
    },
    environment: {
      variables: [{ key: 'DSH_SUPERAGENT_LOCAL_CONVERSATION', description: { zh: '接下工单的终端对话；工单不是从终端来的时为空',
        en: 'The terminal conversation that started the ticket; empty when it did not start in the terminal' } }],
      values: ({ trigger }) => ({ DSH_SUPERAGENT_LOCAL_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversation ?? '') : '' }),
    },
  }
  return {
    kind,
    attach(ctx) { context = ctx },
    async run(ctx, signal) {
      context = ctx
      ctx.report('local', { state: 'ready', detail: 'Takes requests from claude-superagent ask', at: new Date().toISOString() })
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
    },
    handler: () => localHandler(() => {
      if (!context) throw new Error('The local Source is not attached yet')
      return context
    }, observe),
  }
}

/** The Trigger of a person's message in a conversation. */
export function localTrigger(message: LocalMessage, conversation: string): Trigger {
  return { id: key(SOURCE, message.id), source: SOURCE, threads: [{ source: SOURCE, id: threadId(conversation) }], actor: { source: SOURCE, id: message.from },
    human: true, addressed: 'direct', at: message.at, text: message.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${conversation}`, address: { conversation, message: message.id } },
    meta: { conversation, messageId: message.id } }
}

type LocalHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, body: () => Promise<unknown>) => Promise<boolean>
const AskSchema = z.object({ text: z.string().trim().min(1).max(20000), conversation: ConversationId.optional() }).strict()
/**
 * The terminal's routes, under `/local/`: `POST /local/messages` asks (a new conversation unless one is named) and answers
 * the conversation and the Trigger; `GET /local/conversations` lists them; `GET /local/conversations/<id>` reads one, with its
 * messages after `?after=<n>`.
 */
export function localHandler(ctx: () => SourceContext, observe?: LocalObserver): LocalHandler {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value))
  }
  return async (req, res, pathname, body) => {
    if (!pathname.startsWith('/local/')) return false
    try {
      const source = ctx()
      const operator = source.config<LocalConfig>(SOURCE)?.operator
      if (req.method === 'POST' && pathname === '/local/messages') {
        if (!operator) { json(res, 409, { error: 'The terminal Source is off' }); return true }
        const ask = AskSchema.parse(await body())
        const conversation = ask.conversation ?? randomUUID().slice(0, 18)
        const message: LocalMessage = { id: randomUUID(), from: operator, at: new Date().toISOString(), text: ask.text }
        append(source.state, conversation, message, observe)
        const trigger = localTrigger(message, conversation)
        const received = await source.receive(trigger)
        source.threads.describe(`${SOURCE}:${conversation}`, { label: ask.text.replace(/\s+/g, ' ').slice(0, 60) })
        json(res, 200, { conversation, trigger_id: trigger.id, received }); return true
      }
      if (req.method === 'GET' && pathname === '/local/conversations') {
        const known = source.state.get(KV.local.conversations) ?? []
        json(res, 200, { conversations: known.map(id => { const log = messages(source.state, id); return { id, messages: log.length, first: log[0]?.text.slice(0, 80) ?? '', at: log.at(-1)?.at ?? '' } }) })
        return true
      }
      const match = /^\/local\/conversations\/([a-z0-9-]{1,64})$/.exec(pathname)
      if (req.method === 'GET' && match) {
        const after = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('after') ?? 0) || 0
        const log = messages(source.state, match[1]!)
        json(res, 200, { conversation: match[1], messages: log.slice(after), next: log.length }); return true
      }
      json(res, 404, { error: 'Unknown terminal route' }); return true
    } catch (error) {
      // A body the request got wrong (not JSON, too large, or not the shape asked for) is its fault, not the service's.
      const bad = error instanceof z.ZodError || (error as { status?: unknown } | null)?.status === 400
      json(res, bad ? 400 : 500, { error: error instanceof Error ? error.message : String(error) }); return true
    }
  }
}
