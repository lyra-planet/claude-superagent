/** The composition root of claude-superagent: one process, one state directory, its Sessions, Sources and management server. */
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { ClaudeExecutor } from '../executor/claude.ts'
import { stableUuid, sourceTrigger, workerSessionId } from '../executor/common.ts'
import { Commands } from '../infra/commands.ts'
import { nodeSubprocess, workerBin, workerGitConfig, workerGitVariables, type SubprocessRuntime } from '../infra/environment.ts'
import { HealthBoard } from '../infra/health.ts'
import type { Logger } from '../infra/log.ts'
import { KV } from '../kv.ts'
import { settingsPolicy, type RoleModel } from '../policy.ts'
import type { SetupProblem } from '../setup.ts'
import { feishuSettings, feishuSource } from '../sources/feishu.ts'
import { githubSource } from '../sources/github.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import type { SourcePlugin } from '../sources/kind.ts'
import { localSource, SOURCE as LOCAL, type LocalMessage } from '../sources/local.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { activityOf, type ActivityLine } from './activity.ts'
import { MasterAssessor } from './assessment.ts'
import { TextCache } from './cache.ts'
import type { SessionRecord } from './context.ts'
import { Effects } from './effects.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import { workerHooks } from './hooks.ts'
import { allowedHost, managementHandler, sameOrigin, type HttpHost } from './http.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { catalogOf, type ModelCatalog } from './models.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Prompts } from './prompts.ts'
import type { ResourceHost } from './resources.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { Setup } from './setup.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import { Store } from './store.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import type { Tool } from './tools/tool.ts'
import { AGENT_SDK, type Sdk } from './session.ts'
import { evalsHealth } from './views/overview.ts'
import { snapshot, type LinkTarget } from './views/records.ts'
import { ticketRow } from './views/tickets.ts'

/** A ticket as the terminal lists it: its row in the panel, the terminal conversation it started in, and whether a person holds its Session. */
export type TerminalTicket = ReturnType<typeof ticketRow> & { conversation?: string; held: boolean; sessionId: string }
/** What happens, as the terminal follows it live (`GET /local/events`). */
export type LiveEvent = { type: 'message'; conversation: string; message: LocalMessage }
  | { type: 'ticket'; ticket: TerminalTicket }
  | { type: 'activity'; ticketId?: string; lines: ActivityLine[] }
/** A handler a Source or the panel adds to the management server: true when it answered the request. */
export type Route = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>
export interface RuntimeOptions {
  logger: Logger
  /** Ask for a restart: the process stops this Runtime and starts a fresh one, which runs setup again. */
  restart(): void
  /** Serves the panel; without one, `/` answers with a short page pointing at the API. */
  panel?: Route
  subprocess?: SubprocessRuntime
  /** The Agent SDK every Session calls; tests pass a stand-in. */
  sdk?: Sdk
  /** The Sources it runs, GitHub, Feishu and the terminal by default; tests pass them without their loops. */
  plugins?: (local: SourcePlugin) => SourcePlugin[]
  /** Whether it listens on its port; without, `handle` answers requests, as tests make them. */
  listen?: boolean
}
const now = (): string => new Date().toISOString()
/** What git and gh reach: the site and its API, and the hosts gh downloads CI logs and artifacts from. */
export const GITHUB_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com']
/** The variables of a Claude Code session the host runs inside, which a Session it starts must not inherit. */
const SESSION_VARIABLES = /^(CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_PID$|CLAUDE_EFFORT$)/

/**
 * Builds every part, starts them in order, and stops them in reverse. It locks the state directory before opening the
 * database; setup resolves the accounts before any Source reads or any Session starts, and until then the management server
 * answers, so the panel can show what setup still needs.
 */
export class Runtime implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: ClaudeExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly masterId: string
  /** What happens, for the terminal: messages of terminal conversations, ticket changes, what Sessions do. */
  readonly bus = new EventEmitter<{ event: [LiveEvent] }>()
  readonly local = localSource((conversation, message) => { this.bus.emit('event', { type: 'message', conversation, message }) })
  readonly plugins: readonly SourcePlugin[]
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly releaseLock: () => void
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  private server?: Server
  private loops: Promise<void>[] = []
  private closingFlag = false
  private stopping?: Promise<void>
  /** Non-zero while a router tool runs an Engine command, which then sends the router no notice of what it did itself. */
  private quiet = 0
  ready: Promise<void> = Promise.resolve()

  constructor(readonly machine: Machine, private readonly options: RuntimeOptions) {
    const runtime = this
    const { logger } = options
    const subprocess = options.subprocess ?? nodeSubprocess
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    mkdirSync(machine.claudeConfigDir, { recursive: true, mode: 0o700 })
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: error => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() } })
    this.releaseLock = release
    let opened: Store | undefined
    try {
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), error => { logger.warn('claude-superagent: %s', String(error)) })
      const setup = this.setup = new Setup({ subprocess, logger, machine, lifetime: this.lifetime, restart: options.restart })
      const deployed = () => setup.configured() ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, () => setup.configured() && !!setup.deployment.feishu)
      // The terminal hears of every change of a ticket once it is committed.
      store.ticketSaved = id => {
        if (!this.bus.listenerCount('event')) return
        const row = this.terminalTicket(id)
        if (row) this.bus.emit('event', { type: 'ticket', ticket: row })
      }
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? stableUuid('router', machine.stateDir)
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        if (kind.policy?.sync) void this.ready.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined).catch(() => {})
        return () => {}
      })
      this.plugins = options.plugins?.(this.local as SourcePlugin) ?? [githubSource as SourcePlugin, feishuSource as SourcePlugin, this.local as SourcePlugin]
      for (const plugin of this.plugins) sources.register(plugin.kind)
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const sessions = this.sessions = new Sessions({ store, prompts, effects, health: board.claim('models'), logger, masterId, stateDir: machine.stateDir,
        routerDirectory: join(machine.stateDir, 'router'), environment: () => this.claudeEnvironment(),
        variables: ticket => setup.configured() ? (ticket ? this.ticketEnvironment(ticket) : deployed()) : undefined,
        tools: ticket => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, masterId),
        hooks: ticket => workerHooks(ticket.id, { ticket: id => store.tickets.get(id), blocked: () => store.settings().executor.blockedCommands }),
        shell: writable => this.shell(writable), sdk: this.sdk, checkModel: model => this.checkModel(model), activity: (sessionId, message) => {
          const lines = activityOf(message)
          if (lines.length) this.bus.emit('event', { type: 'activity', ...this.sessions.ticketOf(sessionId) ? { ticketId: this.sessions.ticketOf(sessionId) } : {}, lines })
        } })
      mkdirSync(join(machine.stateDir, 'router'), { recursive: true })
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId,
        transcript: sessionId => this.sdk.getSessionMessages(sessionId).then(messages => messages as SessionRecord[], () => []),
        models: () => this.models(), promptVersion: id => sessions.promptVersion(id), mayRead: (id, revision) => sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, checkModel: model => this.checkModel(model),
        lifetime: this.lifetime, sessions, sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new ClaudeExecutor({ get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), logger, machine, subprocess,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment: ticket => this.ticketEnvironment(ticket),
        sourceLink: link, repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(sessions.router, id, text, 'next'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, outbox,
        prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // The router hears of what it did not do itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects, health: this.runtimeHealth,
        lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready }, get deployment() { return setup.deployment },
        configured: () => setup.configured(), get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
        receive: trigger => passes.receive(trigger) }
      this.local.attach(this.context(this.local.kind))
      this.toolHost = { logger, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
    } catch (error) {
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  private get sdk(): Sdk { return this.options.sdk ?? AGENT_SDK }
  /** A ticket as the terminal shows it. */
  terminalTicket(id: string): TerminalTicket | undefined {
    const ticket = this.store.tickets.get(id)
    if (!ticket) return undefined
    const origin = this.store.triggers.get(ticket.origin.triggerId)
    const conversation = origin?.source === LOCAL ? String(origin.meta.conversation ?? '') : ''
    return { ...ticketRow(snapshot({ store: this.store, sources: this.sources, links: this.links() }), ticket), ...conversation ? { conversation } : {},
      held: this.executor.held(id), sessionId: workerSessionId(id) }
  }
  /** Resolves once the Passes and the effects that can run are done. */
  idle(): Promise<void> { return this.passes.idle() }
  /** Run a pass now. */
  pump(): Promise<void> { return this.passes.pump() }
  /** The tools of the router, or of a ticket's worker, as its Session gets them. */
  toolsOf(ticket?: Ticket): Tool[] { return ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, this.masterId) }
  /** Aborted when the Runtime stops or loses its state directory lock. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    return ticketEnvironment({ deployment: this.setup.deployment, sources: this.sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  private closing(): boolean { return this.closingFlag }
  /** Processing holds while it is paused or setup waits; Sources still record Triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  /**
   * The environment of every Claude Code process: the host's (which setup gave the command shims and the agent's git), without
   * the variables of a Claude Code session the host may run inside, with the deployment's Claude Code configuration directory.
   */
  private claudeEnvironment(): Record<string, string | undefined> {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.test(name)))
    return { ...inherited, CLAUDE_CONFIG_DIR: this.machine.claudeConfigDir }
  }
  /**
   * How workers' Bash runs. The sandbox follows the Execution settings: `on`, `weak` for containers that cannot mount /proc, or
   * `off` with Bash approved outright; sandboxed Bash reaches GitHub, for git and gh, and the settings' other domains, nothing else.
   * It writes the worker's directory and `writable` (its drafts), nothing else of the state directory, whose database,
   * configuration and shims the host runs from outside the sandbox. git gets the agent's identity, and sandboxed the placeholders to ignore,
   * through the environment (`workerGitVariables`).
   */
  private shell(writable: readonly string[] = []): { sandbox?: import('@anthropic-ai/claude-agent-sdk').Options['sandbox']; bash: boolean; env: Record<string, string> } {
    const { sandbox: mode, networkDomains } = this.store.settings().executor
    const env = workerGitVariables(this.machine.stateDir, this.setup.deployment?.github, mode !== 'off')
    if (mode === 'off') return { bash: true, env }
    return { bash: false, env, sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      ...mode === 'weak' ? { enableWeakerNestedSandbox: true } : {},
      network: { allowedDomains: [...GITHUB_DOMAINS, ...networkDomains] },
      filesystem: { allowWrite: [...writable], denyRead: this.credentialPaths() } } }
  }
  /** Where Claude Code keeps the credentials it signs in with, which sandboxed Bash may not read. */
  private credentialPaths(): string[] {
    const store = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    return [join(this.machine.claudeConfigDir, '.credentials.json'), ...store ? [store] : []]
  }
  /** The models Claude Code lists for the credentials in use, read through a short query that sends no prompt. */
  private async models(): Promise<ModelCatalog> {
    const ask = this.sdk.query({ prompt: (async function* () { /* No message: only the control requests run. */ })(),
      options: { settingSources: [], tools: [], env: this.claudeEnvironment(), cwd: join(this.machine.stateDir, 'router'), persistSession: false } })
    try { return catalogOf(await ask.supportedModels()) }
    catch (error) { return catalogOf(error instanceof Error ? error : new Error(String(error))) }
    finally { ask.close() }
  }
  private async checkModel(model: RoleModel): Promise<void> {
    const catalog = await this.models()
    if (catalog.failures.length) return
    const known = catalog.groups.flatMap(group => group.models.map(item => item.id))
    if (!known.includes(model.model) && !/^claude-/.test(model.model)) throw new Error(`Claude Code lists no model ${model.model}: ${known.join(', ')}`)
  }

  /** Start: the management server, then setup, then Sources, Sessions, Passes and effects. Resolves once running or waiting for setup. */
  async start(): Promise<void> {
    this.ready = this.initialize()
    return this.ready
  }
  private async initialize(): Promise<void> {
    await this.listen()
    // Claude Code's in-process session reads (transcripts) look in the deployment's configuration directory.
    process.env.CLAUDE_CONFIG_DIR = this.machine.claudeConfigDir
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      this.options.logger.warn('claude-superagent waits for setup: %s', this.setup.problem?.detail ?? '')
      this.startSources()
      return
    }
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    if (this.closing()) return
    this.startSources()
    this.executor.resume()
    // What the router was handed and did not take before a stop (a relay queued behind its last turn) goes in now, not with
    // whatever reaches it next.
    if (this.sessions.router.pendingIds().length) {
      this.sessions.router.openSession().catch((error: unknown) => { this.options.logger.warn('claude-superagent: the router did not open: %s', String(error)) })
    }
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'claude-superagent is ready', at: now() })
    this.options.logger.info('claude-superagent is ready at http://127.0.0.1:%s/', this.machine.port)
  }
  private startSources(): void {
    for (const plugin of this.plugins) {
      const ctx = this.context(plugin.kind)
      this.loops.push(plugin.run(ctx, this.lifetime).catch((error: unknown) => {
        const entry = plugin.kind.health[0]
        if (entry) ctx.report(entry, { state: 'error', detail: String(error) })
      }))
    }
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, sourceLinks,
      get health() { return runtime.health }, get ready() { return runtime.ready },
      get deployment() { return setup.deployment }, get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => runtime.models() }
  }
  /** Answer one request to the management server: the API, the terminal's routes, and the panel. */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async () => { throw new Error('claude-superagent has not started') }
  /** The management server on the loopback port. */
  private listen(): Promise<void> {
    const api = managementHandler(this.httpHost())
    const local = this.local.handler()
    const { port, allowedHosts, stateDir } = this.machine
    // A gateway forwards the browser's Host, which only the person running the service can name: say which one to allow.
    const refused = new Set<string>()
    this.handle = (req, res) => (async () => {
        const host = req.headers.host ?? ''
        if (!allowedHost(host, port, allowedHosts)) {
          if (!refused.has(host)) { refused.add(host); this.options.logger.warn('claude-superagent refused a request for Host "%s": if a gateway forwards the panel from there, add it to allowedHosts in %s and restart', host, join(stateDir, 'config.json')) }
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
          res.end(`claude-superagent does not answer for Host "${host}". If this is your gateway, add it to allowedHosts in config.json in the state directory and restart.\n`)
          return
        }
        // The API decodes its path a segment at a time, so an escaped slash stays inside its segment.
        const raw = new URL(req.url ?? '/', 'http://localhost').pathname
        if (await api(req, res, raw)) return
        let pathname: string
        try { pathname = decodeURIComponent(raw) } catch {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('A path segment has a malformed escape\n'); return
        }
        if (pathname.startsWith('/local/')) {
          if (!sameOrigin(req, port, allowedHosts)) { res.writeHead(403); res.end(); return }
          if (await this.terminal(req, res, pathname)) return
          await local(req, res, pathname, () => readJson(req)); return
        }
        if (this.options.panel && await this.options.panel(req, res, pathname)) return
        res.writeHead(pathname === '/' ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(pathname === '/' ? 'claude-superagent: the panel is not built; the management API is at orchestrator/api/state\n' : 'Not found\n')
      })().catch(error => { if (!res.headersSent) { res.writeHead(500); res.end(String(error)) } })
    if (this.options.listen === false) return Promise.resolve()
    const server = this.server = createServer((req, res) => { void this.handle(req, res) })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.machine.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  }
  /**
   * The terminal's routes beside the terminal Source's: `GET /local/events` streams what happens (server-sent events);
   * `GET /local/tickets` lists the tickets; `GET /local/tickets/<id>/activity` reads what its worker did; `POST
   * /local/tickets/<id>/hold` hands its worker's Session to a person (`{ now }` cuts its turn short) and answers where it is;
   * `POST /local/tickets/<id>/release` hands it back.
   */
  private async terminal(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && pathname === '/local/events') {
      // A stream opened while the service stops would keep the server from closing: the terminal tries again later.
      if (this.lifetime.aborted) { json(503, { error: 'claude-superagent is stopping' }); return true }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': claude-superagent\n\n')
      const send = (event: LiveEvent) => { res.write(`data: ${JSON.stringify(event)}\n\n`) }
      const beat = setInterval(() => { res.write(': beat\n\n') }, 15_000)
      beat.unref?.()
      const stopping = () => { end(); res.end() }
      const end = () => { clearInterval(beat); this.bus.off('event', send); this.lifetime.removeEventListener('abort', stopping) }
      this.bus.on('event', send)
      req.on('close', end); this.lifetime.addEventListener('abort', stopping, { once: true })
      return true
    }
    if (req.method === 'GET' && pathname === '/local/tickets') {
      json(200, { tickets: this.store.tickets.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).flatMap(ticket => this.terminalTicket(ticket.id) ?? []) })
      return true
    }
    const route = /^\/local\/tickets\/([a-f0-9]{8,64})\/(activity|session|hold|release)$/.exec(pathname)
    const ticket = route ? this.store.tickets.get(route[1]!) : undefined
    if (!route) return false
    if (!ticket) { json(404, { error: 'Ticket not found' }); return true }
    if (req.method === 'GET' && route[2] === 'activity') {
      const limit = Math.min(500, Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit') ?? 60) || 60)
      const history = await this.sdk.getSessionMessages(workerSessionId(ticket.id), { dir: ticket.execution?.directory ?? '' }).catch(() => [])
      json(200, { lines: history.flatMap(message => activityOf(message)).slice(-limit) }); return true
    }
    // Where the worker's Session is, to open it in Claude Code; the person works with the worker's git and gh there, acting as
    // the agent account in its Session, as in upstream's.
    const session = () => ({ sessionId: workerSessionId(ticket.id), cwd: ticket.execution?.directory ?? '', claudeConfigDir: this.machine.claudeConfigDir,
      working: !!this.sessions.worker(ticket.id)?.working, held: this.executor.held(ticket.id),
      env: { GIT_CONFIG_GLOBAL: workerGitConfig(this.machine.stateDir), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', PATH_PREFIX: workerBin(this.machine.stateDir),
        ...workerGitVariables(this.machine.stateDir, this.setup.configured() ? this.setup.deployment.github : undefined, false) } })
    if (req.method === 'GET' && route[2] === 'session') { json(200, session()); return true }
    if (req.method === 'POST' && route[2] === 'hold') {
      const body = await readJson(req).catch(() => ({})) as { now?: unknown }
      // The hold waits for the worker's turn to end; a person who leaves meanwhile (Ctrl-C, a closed terminal) never opens the
      // Session, and no one would hand it back, so it goes back to the worker at once.
      let left = false
      const leaving = () => { if (!res.writableFinished) left = true }
      res.on('close', leaving)
      const { stopped } = await this.executor.hold(ticket.id, body?.now === true)
      res.off('close', leaving)
      if (left || res.destroyed) { this.executor.release(ticket.id, false); return true }
      json(200, { ...session(), stopped }); return true
    }
    if (req.method === 'POST' && route[2] === 'release') { this.executor.release(ticket.id); json(200, { released: true }); return true }
    return false
  }
  /** Idempotent stop: concurrent or repeated calls share one shutdown. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true
    const passes = this.passes.stop()
    this.stopped.abort()
    try {
      this.assessor.stop()
      // Every worker's turn stops first, keeping what its Session was handed and did not take in its ledger, as upstream cancels
      // its agents keeping their inboxes; then the effects drain, the workers' background work stops, and the queries end. The
      // router's turn is not interrupted: an interrupt would start its next turn with what waits, which the close then cuts,
      // while a close leaves what waits in its ledger for the next start.
      const sessions = this.store.tickets.list().flatMap(ticket => this.sessions.worker(ticket.id) ?? [])
      await Promise.allSettled(sessions.filter(session => session.working).map(session => session.interrupt()))
      await Promise.allSettled([passes, this.effects.drain(), ...this.loops])
      await this.executor.shutdown()
      await this.sessions.dispose()
      await new Promise<void>(resolve => { if (this.server) { this.server.close(() => resolve()); this.server.closeAllConnections() } else resolve() })
    } finally {
      this.setup.restore()
      try { this.store.close() } finally { try { this.releaseLock() } catch { /* A compromised lock is released already. */ } }
    }
  }
}
/** A request body that is not JSON, or is too large: the request's fault, answered with a 400. */
class BadRequest extends Error { readonly status = 400 }
async function readJson(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new BadRequest(`Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown }
  catch (error) { throw new BadRequest(`The request body is not JSON: ${error instanceof Error ? error.message : String(error)}`) }
}
