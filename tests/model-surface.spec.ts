/**
 * Model surface contract tests: verify the tools, system prompts, skills, and session inputs the orchestrator and worker roles
 * are offered against tool schemas, environment variables, glossary rules (`docs/001`), and size budgets.
 *
 * Ported from upstream's tests/model-surface.spec.ts onto the stand-in Claude Code (tests/fixtures/claude.ts). Upstream recorded
 * what the Runtime registered on a fake DSH host. What a Claude Code Session is offered is what its query starts with: the
 * system prompt (`options.systemPrompt`: the router's whole, a worker's appended to Claude Code's own), the tools its MCP server
 * lists (`options.mcpServers`, each named `mcp__superagent__<name>` to the model), the skills of the host's plugin
 * (`options.plugins`), and the messages the host pushes to it. Every case of upstream's file is here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { SKILL_PREFIX, promptParts } from '../src/app/prompts.ts'
import { RESOURCES } from '../src/app/resources.ts'
import { TICKET_STATES } from '../src/app/cards.ts'
import { MCP_SERVER } from '../src/app/sessions.ts'
import { inputMessage, workerSessionId } from '../src/executor/common.ts'
import { Commands } from '../src/infra/commands.ts'
import { IM_WORDS, NOTE_WORDS, checkedImText } from '../src/infra/text.ts'
import { CHAT, feishu, startRuntime } from './fixtures/host.ts'

type Role = 'orchestrator' | 'worker'
interface Surface { where: string; owner: string; role: Role | 'both'; text: string }
/** A tool as a Session's MCP server lists it: `name` as the text names it, `offered` as Claude Code names it to the model. */
interface Tool { name: string; offered: string; description: string; parameters: unknown }
interface Skill { name: string; description: string; content: string }

/**
 * Maximum combined character count of system prompt and tool definitions per role (~5% above baseline).
 * Lower this limit when shrinking model-facing text; raise it only intentionally and explain why in the commit message.
 */
const BUDGET: Record<Role, number> = { orchestrator: 59_000, worker: 40_500 }
const PROMPTS = 'prompts/, skills/', TOOLS = 'src/app/tools/', SESSIONS = 'src/app/sessions.ts'
const NOTICES = 'src/app/notices.ts', LINKS = 'src/app/links.ts', ASSESSMENT = 'src/app/assessment.ts'
const EXECUTOR = 'src/executor/claude.ts', ERRORS = 'src/core/errors.ts'
const TICKETS = 'src/core/tickets.ts', ASSIGNMENTS = 'src/core/assignments.ts'
/** Regex patterns compiled from `orchestrator_read` resource templates (`<…>` matches one path segment; `…` matches the rest). */
const RESOURCE_NAMES = RESOURCES.map(({ name }) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '[^/\\s]+').replace('…', '.+')}$`))
/** Report and assignment states, which text names as such; a ticket or a worker is in one of the card states (TICKET_STATES). */
const REPORT_WORDS = /^(ready|waiting|blocked|failed|progress|running|queued)$/
/** Retired terminology superseded by `docs/001`. */
const LEGACY: [word: string, pattern: RegExp][] = [['reopen', /reopen/i], ['event/', /(?<![\w-])event\//], ['task/', /(?<![\w-])task\//],
  ['member', /\bmembers?\b/i], ['topic', /\btopics?\b/i], ['admission_', /\badmission_/], ['guide/', /\bguide\//]]
/** Disallowed phrases in generated or static model-facing text. */
const BANNED: [rule: string, where: RegExp, phrase: RegExp][] = [
  ['An out-of-scope proactive ticket ends as dropped', /^worker (prompt from the runtime|input assignment \(inferred\))$/, /report blocked/i],
  ['A question goes back where the person who raised it wrote', /./, /always returns to the original|ask(?: promptly)? in the original ticket conversation/i],
  ['The main Session has no tool that messages a worker', /./, /request the answer through the worker/i],
  ['A stop goes through orchestrator_route, not through an assessment', /^assessment instructions$/, /decision=stop/i],
]
/** Known failures tolerated for now, by the file that owns the text; keep empty. */
const KNOWN_FAILURES: [owner: string, failure: string][] = []

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/)
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')

/**
 * Start a configured Runtime on the stand-in Claude Code (tests/fixtures/host.ts). Adapted: upstream started one on a fake DSH
 * host that recorded registered tools, prompt sections, skills and delivered messages per session; here they are read from the
 * queries each Session starts and the messages the host pushes (below).
 */
async function start() {
  const h = await startRuntime()
  /** The options the latest query of a Session started with. */
  const started = (sessionId: string): Record<string, any> => h.claude.queries.filter(query => query.session.id === sessionId).at(-1)!.options
  const clients = new WeakMap<object, Promise<Client>>()
  /** A client of the MCP server a Session's latest query was given, as Claude Code connects to it. */
  const client = (sessionId: string): Promise<Client> => {
    const server = (started(sessionId).mcpServers as Record<string, McpSdkServerConfigWithInstance>)[MCP_SERVER]!
    let connected = clients.get(server.instance)
    if (!connected) {
      connected = (async () => {
        const [ours, theirs] = InMemoryTransport.createLinkedPair()
        await server.instance.connect(ours)
        const model = new Client({ name: 'model', version: '1.0.0' })
        await model.connect(theirs)
        return model
      })()
      clients.set(server.instance, connected)
    }
    return connected
  }
  /** The tools a Session's MCP server lists, by the name the text uses. */
  const tools = async (sessionId: string): Promise<Map<string, Tool>> => {
    const { tools: listed } = await (await client(sessionId)).listTools()
    return new Map(listed.map(tool => [tool.name, { name: tool.name, offered: `mcp__${MCP_SERVER}__${tool.name}`, description: tool.description ?? '',
      parameters: tool.inputSchema }]))
  }
  /** The system prompt of a Session's latest query: the router's whole, a worker's appended to Claude Code's. */
  const prompt = (sessionId: string): string => { const value = started(sessionId).systemPrompt; return typeof value === 'string' ? value : value.append }
  /** The skills of the plugin a Session's latest query loads, each `superagent:<name>`: its description and the text it loads. */
  const skills = (sessionId: string): Skill[] => (started(sessionId).plugins as { path: string }[]).flatMap(({ path }) =>
    readdirSync(join(path, 'skills')).map(name => {
      const file = readFileSync(join(path, 'skills', name, 'SKILL.md'), 'utf8')
      const description = JSON.parse(/^description: (.*)$/m.exec(file)![1]!) as string
      return { name: `${SKILL_PREFIX}${name}`, description, content: file.slice(file.indexOf('\n---\n') + 5).trim() }
    }))
  /** The messages the host pushed to a Session, each once: a query that starts again hands over again what was not taken. */
  const inputs = (sessionId: string): string[] => [...new Map(h.claude.to(sessionId).map(message => [message.uuid, message.text])).values()]
  const stop = async () => { await h.stop() }
  return { ...h, started, client, tools, prompt, skills, inputs, stop }
}
type Host = Awaited<ReturnType<typeof start>>

/** Exercise the orchestrator and worker workflows so all runtime-generated prompt sections, cards, notices, and errors are emitted. */
async function drive(host: Host) {
  const { runtime } = host
  const run = (ticketId: string | undefined, name: string, args: unknown) => host.runTool(ticketId, name, args)
  const master = runtime.masterId
  // Candidates wait, which the main Session decides in one call: a request it accepts, thanks it ignores, and plain chat in the
  // channel, a proactive candidate whose card shows it touches no rule, which it ignores from its card.
  const request = feishu('1', '@bot 修一下回归'), thanks = feishu('3', '@bot 谢谢'), chat = feishu('4', '中午吃什么', { mentions: [] })
  // Adapted: receive returns once the Trigger is recorded; the pass that relays its candidate runs before idle resolves.
  runtime.receive(request); runtime.receive(thanks); runtime.receive(chat)
  await runtime.idle()
  const routed = await run(undefined, 'orchestrator_route', { decisions: [
    { kind: 'accept', trigger_id: request.id, title: '修复回归', worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' },
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' }, { kind: 'ignore', trigger_id: chat.id, reason: 'Lunch chat.' }] }) as
    { results: { decision?: string; reason?: string; ticket?: { ticket_id: string } }[] }
  expect(routed.results.map(result => result.decision)).toEqual(['accept', 'ignore', 'ignore'])
  expect(routed.results[2]!.reason).toMatch(/^Ignored from its card/)
  const a = routed.results[0]!.ticket!.ticket_id
  const answer = { trigger_id: request.id, purpose: 'answer', text: '是配置。' }
  // Adapted: the refusal as the model reads it, the error result of the router's MCP server, where upstream took the error DSH's tool threw.
  const called = await (await host.client(master)).callTool({ name: 'orchestrator_reply', arguments: answer }) as { isError?: boolean; content: { text: string }[] }
  const refusal = called.isError ? called.content.map(block => block.text).join('') : ''
  const proposal = feishu('5', '把副标题改成“浏览网页”', { mentions: [] })
  runtime.receive(proposal); await runtime.idle()
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_5', chat_id: CHAT }] })
  await run(undefined, 'orchestrator_eval', { trigger_id: proposal.id })
  const proactive = (await run(undefined, 'orchestrator_eval_decide', { trigger_id: proposal.id, decision: 'accept', title: '文案修订', worktree_name: 'copy-fix',
    scope: '改副标题', reason: 'explicit copy change', intent_evidence: 'quoted', acknowledgement: '收到，把副标题改成“浏览网页”。',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy change' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'it names the text' } })).ticket as { ticket_id: string }
  const b = proactive.ticket_id
  await runtime.idle()
  const [workerA, workerB] = [a, b].map(workerSessionId) as [string, string]
  await run(a, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  await run(a, 'orchestrator_report', { state: 'progress', summary: 'It reads the config.', human_action: null, reply_to_trigger_id: request.id })
  const other = feishu('9', '@bot 顺便看看这个')
  runtime.receive(other); await runtime.idle()
  await run(undefined, 'orchestrator_route', { decisions: [{ kind: 'attach', ticket_id: a, trigger_id: other.id }] })
  await run(a, 'orchestrator_thread_unrelated', { thread: `feishu:${CHAT}:om_9`, reason: 'It asks for something else.' })
  await run(a, 'orchestrator_thread_follow', { thread: `feishu:${CHAT}:om_7`, reason: 'The same settings page.' })
  runtime.receive(feishu('7', '@bot 这个页面的按钮也改一下'))
  const beyond = feishu('8', '另外把导出也做了', { mentions: [], root_id: 'om_1' })
  runtime.receive(beyond)
  await runtime.idle()
  await run(a, 'orchestrator_trigger_handback', { trigger_id: beyond.id, reason: 'It asks for an export feature.' })
  await run(undefined, 'orchestrator_ticket_note', { ticket_id: a, text: 'Ticket B changes the same settings page.' })
  await runtime.pump()
  await runtime.idle()
  await run(a, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  runtime.receive(feishu('2', '再加一个按钮', { mentions: [], root_id: 'om_1' }))
  await vi.waitFor(async () => {
    await runtime.pump()
    expect(runtime.store.tickets.get(a)!.inputs.some(input => input.kind === 'resumed')).toBe(true)
  })
  const policy = runtime.store.settings().policy
  // The rule ticket b was accepted under changes, so its worker is told how; the one it was not is disabled, which tells no one.
  const rules = policy.rules.map(rule => rule.id === 'visual' ? { ...rule, enabled: false }
    : rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep the wording short.` } : rule)
  await runtime.settings.save('policy', { ...policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  await runtime.idle()
  // Worker b's turn ends: it is idle. Adapted: the test plays worker b's model, which ends its turn and each one a message
  // queued meanwhile starts, where upstream set the DSH agent idle and emitted DSH's agent/status.
  const sessionB = host.claude.session(workerB)
  for (let turns = 0; sessionB.status === 'running'; turns++) {
    if (turns === 10) throw new Error(`The Session ${workerB} keeps running`)
    sessionB.end(); await runtime.idle()
  }
  await vi.waitFor(() => expect(latestAssignment(runtime.store.tickets.get(b)!)?.report?.state).toBe('waiting'))
  runtime.engine.requestStatus(b)
  // Resume runs once the status request reached the worker (whose Assignment is then busy rather than settled), so it gets the recovery note.
  await runtime.idle()
  expect(runtime.store.tickets.get(b)!.undelivered).toEqual([])
  runtime.executor.resume()
  await runtime.pump()
  await runtime.idle()
  // Adapted: a Session reads its system prompt, tools and skills as its query starts, where upstream's DSH read its prompt
  // section at each model request. Each Session's query starts again, as the router's does once it is idle, so what it is
  // offered is what its next turn reads.
  for (const session of [runtime.sessions.router, runtime.sessions.worker(a)!, runtime.sessions.worker(b)!]) {
    await session.close(); await session.openSession()
  }
  await runtime.idle()
  return { a, b, workerA, workerB, refusal }
}

function walk(node: unknown, visit: (node: Record<string, unknown>, property?: string) => void, property?: string): void {
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, property); return }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  visit(record, property)
  for (const [name, value] of Object.entries(record)) {
    const properties = name === 'properties' && value && typeof value === 'object' ? Object.entries(value) : undefined
    if (properties) for (const [child, schema] of properties) walk(schema, visit, child)
    else walk(value, visit, ['anyOf', 'oneOf', 'allOf', 'items'].includes(name) ? property : undefined)
  }
}

/** Collect all model-visible text surfaces (prompt sections, tool schemas, skills, errors, and session inputs) with their owning module. */
function collect(host: Host, { a, b, workerA, workerB, refusal }: Awaited<ReturnType<typeof drive>>): Surface[] {
  const { runtime } = host
  const surfaces: Surface[] = []
  const config = runtime.prompts.current().config
  const shared = new Set(['runtime/shared', 'communication', 'scope', 'delivery', 'runtime/subscriptions', 'runtime/replies'])
  for (const [role, sessionId] of [['orchestrator', runtime.masterId], ['worker', workerA], ['worker', workerB]] as const) {
    const parts = promptParts(config, role)
    for (const { name, text } of parts) {
      surfaces.push({ where: `${role} prompt ${name}`, owner: PROMPTS, role: shared.has(name) ? 'both' : role, text })
    }
    // The revision line, the execution environment and the note on a proactive ticket come from the runtime.
    const generated = parts.reduce((text, part) => text.replace(part.text, ''), host.prompt(sessionId))
    surfaces.push({ where: `${role} prompt from the runtime`, owner: SESSIONS, role, text: generated })
  }
  for (const [role, tools] of [['orchestrator', offered.orchestrator], ['worker', offered.worker]] as const) {
    for (const tool of tools.values()) {
      const descriptions = [tool.description]
      walk(tool.parameters, node => { if (typeof node.description === 'string') descriptions.push(node.description) })
      surfaces.push({ where: `${role} tool ${tool.name}`, owner: TOOLS, role, text: descriptions.join('\n') })
    }
  }
  for (const { name, description, content } of host.skills(runtime.masterId)) {
    surfaces.push({ where: `skill ${name}`, owner: PROMPTS, role: 'both', text: `${description}\n${content}` })
  }
  surfaces.push({ where: 'orchestrator tool orchestrator_reply error', owner: ERRORS, role: 'orchestrator', text: refusal })
  for (const text of host.inputs(runtime.masterId)) {
    // Adapted: a notice reaches the router as `Notice: <summary>` and then its JSON, which it reads whole.
    const value = JSON.parse(text.startsWith('Notice: ') ? text.slice(text.lastIndexOf('\n') + 1) : text) as Record<string, unknown>
    const kind = String(value.kind ?? Object.keys(value)[0])
    const owner = kind === 'candidate' ? LINKS : kind === 'worker_attention' ? TOOLS : kind === 'worker_report' ? EXECUTOR : NOTICES
    surfaces.push({ where: `orchestrator input ${kind}`, owner, role: 'orchestrator', text })
  }
  for (const [id, sessionId] of [[a, workerA], [b, workerB]] as const) {
    const ticket = runtime.store.tickets.get(id)!
    const assignment = ticket.execution!.assignment
    surfaces.push({ where: `worker input assignment (${ticket.mandate.strength})`, owner: EXECUTOR, role: 'worker', text: assignment })
    const card = (text: string) => { try { return JSON.parse(text) as Record<string, unknown> } catch { return undefined } }
    for (const text of host.inputs(sessionId)) {
      const input = ticket.inputs.find(item => item.kind === 'trigger' ? card(text)?.trigger_id === item.triggerId
        : inputMessage(item) === text)
      if (!input) continue
      // Text inputs are named by their id prefix; the restart note's id is a content hash, so it is named by its text.
      const kind = input.kind === 'trigger' ? input.context ? 'trigger (context)' : 'trigger' : input.kind !== 'text' ? input.kind
        : input.id.includes(':') ? input.id.split(':')[0]! : /host restarted/i.test(input.text) ? 'recovery' : 'text'
      const owner = kind === 'status' ? TICKETS : kind === 'recovery' ? ASSIGNMENTS : EXECUTOR
      surfaces.push({ where: `worker input ${kind}`, owner, role: 'worker', text })
    }
  }
  return surfaces
}

let host: Host
let sessions: Awaited<ReturnType<typeof drive>>
let surfaces: Surface[]
/** The tools each role is offered: the main Session's, and worker A's. */
let offered: Record<Role, Map<string, Tool>>
beforeAll(async () => {
  host = await start()
  sessions = await drive(host)
  offered = { orchestrator: await host.tools(host.runtime.masterId), worker: await host.tools(sessions.workerA) }
  surfaces = collect(host, sessions)
})
afterAll(async () => { await host?.stop() })
const toolsOf = (role: Role) => offered[role]

/** Check collected surfaces for unregistered tools, invalid enum options, legacy terms, banned phrases, and cross-role tool references. */
function failures(): Map<string, string> {
  const found = new Map<string, string>()
  const options = new Map<string, Set<string>>()
  const schemas = [...toolsOf('orchestrator').values(), ...toolsOf('worker').values()].map(tool => tool.parameters)
  walk(schemas, (node, property) => {
    if (property && Array.isArray(node.enum)) options.set(property, new Set([...options.get(property) ?? [], ...node.enum.map(String)]))
  })
  for (const name of ['decision', 'purpose', 'state']) expect(options.has(name), `${name} has options`).toBe(true)
  const tools = { orchestrator: new Set(toolsOf('orchestrator').keys()), worker: new Set(toolsOf('worker').keys()) }
  const registered = (token: string) => tools.orchestrator.has(token) || tools.worker.has(token)
  const variables = new Set(host.runtime.ticketEnvironment(host.runtime.store.tickets.get(sessions.a)!).map(variable => variable.key))
  for (const { where, owner, role, text } of surfaces) {
    const fail = (problem: string) => found.set(`${where}: ${problem}`, owner)
    for (const [token] of text.matchAll(/\borchestrator_[a-z_]+/g)) if (!registered(token)) fail(`${token} is not a tool`)
    for (const [, name, values] of text.matchAll(/\b([a-z_]+)[=:] ?([a-z][a-z/-]*)/g)) {
      for (const value of options.has(name!) ? values!.split('/') : []) {
        if (!options.get(name!)!.has(value)) fail(`${name}=${value} is not an option`)
      }
    }
    for (const [word, pattern] of LEGACY) if (pattern.test(text)) fail(`legacy word "${word}"`)
    for (const [rule, scope, phrase] of BANNED) if (scope.test(where) && phrase.test(text)) fail(`breaks "${rule}"`)
    for (const [name] of text.matchAll(/\bDSH_SUPERAGENT_[A-Z][A-Z_]*[A-Z]\b/g)) if (!variables.has(name)) fail(`${name} is not a variable`)
    // A ticket's or worker's state is a card state; a report state is named with the word report.
    const states = [...text.matchAll(/\b([a-z]+(?:\/[a-z]+)*) (?:tickets?|workers?)\b/g), ...text.matchAll(/\b(?:tickets?|workers?) (?:is|are)(?: still)? ([a-z]+)\b/g)]
    for (const [phrase, word] of states) {
      if (word!.split('/').some(part => REPORT_WORDS.test(part)) && !(TICKET_STATES as readonly string[]).includes(word!)) fail(`"${phrase}" is not a card state`)
    }
    for (const [phrase] of text.matchAll(/\bwait(?:ing)? for (?:ready|waiting|blocked|failed)\b(?! report)/g)) fail(`"${phrase}" names a report state without report`)
    for (const [found] of text.matchAll(/\b(?:ticket|trigger|decision|prompts|prompt-preview|models|feishu|github)\/[^\s"'`,;)\]]*/g)) {
      const name = found.replace(/[.:]+$/, '')
      if (!RESOURCE_NAMES.some(pattern => pattern.test(name))) fail(`${name} is not a resource orchestrator_read reads`)
    }
    // Text only one role reads names the other role's tools only in a sentence that says the other role uses them.
    const other = role === 'orchestrator' ? 'worker' : role === 'worker' ? 'orchestrator' : undefined
    const names = other === 'worker' ? /\b(workers?|executors?)\b/i : /\b(orchestrator|main session)\b/i
    for (const sentence of sentences(text)) {
      for (const [, count] of sentence.matchAll(/\b(\d+)[- ]words?\b/g)) {
        const limit = /routing/i.test(sentence) ? NOTE_WORDS : IM_WORDS
        if (Number(count) !== limit) fail(`"${count} words" is not ${limit}`)
      }
      for (const [token] of other && !names.test(sentence) ? sentence.matchAll(/\borchestrator_[a-z_]+/g) : []) {
        if (!registered(token) || tools[role as Role].has(token)) continue
        fail(`tells the ${role} to use ${token}, which only the ${other} has`)
      }
    }
  }
  return found
}

it('collects both roles\' tools, prompts, skills and inputs', () => {
  // Adapted: the tools as Claude Code names them to the model, mcp__superagent__<name>.
  expect([...toolsOf('worker').values()].map(tool => tool.offered).sort()).toEqual(['orchestrator_ack', 'orchestrator_read', 'orchestrator_report',
    'orchestrator_thread_follow',
    'orchestrator_thread_unrelated', 'orchestrator_trigger_handback'].map(name => `mcp__${MCP_SERVER}__${name}`))
  expect([...toolsOf('orchestrator').keys()]).toEqual(expect.arrayContaining(['orchestrator_route', 'orchestrator_eval_decide', 'orchestrator_reply']))
  // The one routing tool takes the place of four.
  for (const name of ['orchestrator_ticket_accept', 'orchestrator_ticket_attach', 'orchestrator_ticket_stop', 'orchestrator_trigger_ignore']) {
    expect(toolsOf('orchestrator').has(name)).toBe(false)
  }
  const wheres = new Set(surfaces.map(surface => surface.where))
  // Adapted: the host's skills load under its plugin's prefix (SKILL_PREFIX), where upstream's under dsh-superagent-.
  for (const where of ['orchestrator prompt runtime/dispatch', 'worker prompt runtime/work', `skill ${SKILL_PREFIX}github`, `skill ${SKILL_PREFIX}feishu`,
    'orchestrator prompt runtime/admission', 'orchestrator input candidate', 'orchestrator input worker_attention', 'orchestrator input worker_report',
    'orchestrator input thread_unrelated', 'orchestrator input ticket_ended', 'orchestrator input settings_saved', 'worker input assignment (explicit)',
    'worker input assignment (inferred)', 'worker input policy-changed', 'worker input resumed', 'worker input status',
    'worker input recovery', 'worker input note', 'worker input trigger (context)', 'orchestrator input follow_up',
    'orchestrator input thread_followed', 'orchestrator tool orchestrator_reply error']) expect(wheres).toContain(where)
  expect(sessions.refusal).not.toBe('')
})

it('names only registered tools, schema options, environment variables and glossary words, with the enforced word limits', () => {
  const found = failures(), known = new Map(KNOWN_FAILURES.map(([owner, failure]) => [failure, owner]))
  const drift = [...found].filter(([failure]) => !known.has(failure)).map(([failure, owner]) => `${owner}: ${failure}`)
  const fixed = [...known].filter(([failure]) => !found.has(failure))
    .map(([failure, owner]) => `${owner}: ${failure} (fixed: drop it from KNOWN_FAILURES)`)
  expect([...drift, ...fixed], 'model-facing text differs from KNOWN_FAILURES; each line starts with the owner of the text').toEqual([])
})

it('enforces the word limits the text states', async () => {
  expect(checkedImText(words(IM_WORDS))).toBe(words(IM_WORDS))
  expect(() => checkedImText(words(IM_WORDS + 1))).toThrow(`maximum is ${IM_WORDS}`)
  const attach = (note: string) =>
    host.runTool(undefined, 'orchestrator_route', { decisions: [{ kind: 'attach', ticket_id: 'unknown', trigger_id: 'unknown', note }] })
  // A note over the limit refuses its item alone; one at the limit goes on to the Engine, which knows no such ticket.
  expect(await attach(words(NOTE_WORDS + 1))).toEqual({ results: [expect.objectContaining({ refused: expect.stringContaining(`${NOTE_WORDS} words`) })] })
  expect(await attach(words(NOTE_WORDS))).toEqual({ results: [expect.objectContaining({ refused: expect.stringMatching(/Unknown (ticket|trigger)/) })] })
})

/** The enabled rules' lines of the main Session's Policy section, as the settings hold them now. */
const ruleLines = () => host.runtime.store.settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`)
it.each(['orchestrator', 'worker'] as const)('keeps the %s within its character budget', role => {
  const ids = role === 'orchestrator' ? [host.runtime.masterId] : [sessions.workerA, sessions.workerB]
  // Strip machine-dependent variable values (such as directory paths), and the team's rules, before measuring prompt length.
  const builtIn = (text: string) => ruleLines().reduce((rest, line) => rest.replace(line, ''), text).replace(/ = "[^"\n]*"/g, ' = ""')
  // Adapted: a worker's prompt is the part the host appends to Claude Code's own, as upstream measured its DSH prompt section.
  const prompt = Math.max(...ids.map(id => builtIn(host.prompt(id)).length))
  // Adapted: each tool as the model is offered it, its MCP name, description and input schema.
  const definitions = [...toolsOf(role).values()].map(({ offered: name, description, parameters }) => ({ name, description, input_schema: parameters }))
  const tools = JSON.stringify(definitions).length
  expect(prompt + tools, `${prompt} characters of prompt and ${tools} of tools`).toBeLessThanOrEqual(BUDGET[role])
})

it('keeps the routing rules in dispatch, which says the main Session may accept the rest of a stop message as new work', () => {
  const route = toolsOf('orchestrator').get('orchestrator_route')!.description
  const dispatch = surfaces.find(surface => surface.where === 'orchestrator prompt runtime/dispatch')!.text
  expect(dispatch).toContain('you may accept the rest of the message as new work')
  expect(dispatch).toContain('decide those whose card already settles them in one orchestrator_route call')
  expect(route).not.toMatch(/needs a new ticket on another explicit instruction/)
})

it('lists in the main Session\'s Policy section exactly the enabled rules, as the drive\'s save left them', () => {
  const text = host.prompt(host.runtime.masterId), at = text.indexOf('## Policy')
  // Adapted: the router's prompt ends with the Policy section, where upstream's section had a line after it (the worker's
  // mandate, empty for the router), so the section runs to the end of the text when no blank line follows it.
  const end = text.indexOf('\n\n', at)
  const listed = text.slice(at, end < 0 ? undefined : end).split('\n').filter(line => line.startsWith('- '))
  expect(listed).toEqual(ruleLines())
  // The drive disabled the visual rule and changed the copy rule's instruction.
  expect(listed).toEqual([expect.stringMatching(/^- .* \(copy\): .*Keep the wording short\.$/)])
})
