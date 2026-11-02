/**
 * The Claude Code Sessions of the router and the workers: what each starts with, the router's durable relays and notices,
 * the prompt revisions each Session worked under, and the model retries each waits on.
 */
import { createSdkMcpServer, tool as mcpTool, type HookCallbackMatcher, type HookEvent, type McpSdkServerConfigWithInstance, type Options,
  type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { UserError, key, type Ticket } from '../core/index.ts'
import { mandateInstructions, stableUuid, workerSessionId } from '../executor/common.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Logger } from '../infra/log.ts'
import type { RoleModel } from '../policy.ts'
import { workerSessionEnvironment } from '../infra/environment.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import { AGENT_SDK, ClaudeSession, type Delivery, type Sdk, type SessionEvents, type SessionLedger, type SessionStart } from './session.ts'
import { PROVIDER } from './models.ts'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'

/** The MCP server name of the host's tools, so a tool `orchestrator_route` is `mcp__superagent__orchestrator_route` to the model. */
export const MCP_SERVER = 'superagent'
/** The plugin name the host's skills load under, so the GitHub skill is `superagent:github`. */
export const PLUGIN = 'superagent'
/**
 * Built-in tools no worker gets: they ask or show a person something, change the configuration, or start work outside the
 * worker's slot. Everything else Claude Code offers stays, as upstream's worker preset kept its work tools.
 */
export const WORKER_DENIED = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete',
  'CronList', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage', 'Workflow', 'Artifact', 'NotebookEdit']
/** How many prompt revisions keep their skills directory on disk. */
const KEPT_SKILL_REVISIONS = 5
/** Tools a worker runs without a prompt; Bash is added when the sandbox is off, else the sandbox approves sandboxed commands. */
export const WORKER_ALLOWED = [`mcp__${MCP_SERVER}__*`, 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Agent', 'Skill']
/**
 * With the sandbox on, Claude Code still refuses a sandboxed gh call that writes through `gh api` or carries quoted text
 * with an `=`, such as a pull request body describing a setting (docs/host-probes.md, `text`). Writing to GitHub is a
 * worker's work and the hook stops what it may not do there, so gh is allowed outright; it still runs in the sandbox.
 */
export const SANDBOXED_ALLOWED = [...WORKER_ALLOWED, 'Bash(gh:*)']

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  readonly store: Pick<Store, 'settings' | 'get' | 'set' | 'delete' | 'keys' | 'tickets'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry: Sessions waiting on a model retry. */
  readonly health: HealthEntry
  readonly logger: Logger
  readonly masterId: string
  readonly stateDir: string
  /** The working directory of the router's Session. */
  readonly routerDirectory: string
  /** The environment of every Claude Code process the host starts. */
  environment(): Record<string, string | undefined>
  /** Execution environment variables: deployment-wide for the router, the ticket's for its worker. */
  variables(ticket?: Ticket): Variable[] | undefined
  /** The tools of the router (`ticket` undefined) or of `ticket`'s worker. */
  tools(ticket?: Ticket): Tool[]
  /** The hooks of `ticket`'s worker. */
  hooks(ticket: Ticket): Partial<Record<HookEvent, HookCallbackMatcher[]>>
  /** How workers' Bash runs: the sandbox, whether Bash is approved outright, and the variables it adds to the environment. */
  shell(): Pick<Options, 'sandbox'> & { bash: boolean; env: Record<string, string> }
  /** The Agent SDK the Sessions call; tests pass a stand-in. */
  readonly sdk?: Sdk
  /** Throws when Claude Code does not list `model` for the credentials in use. */
  checkModel?(model: RoleModel): Promise<void>
  /** Every message a Session's query yields, for the terminal's view of what Sessions do. */
  activity?(sessionId: string, message: SDKMessage): void
}

/** A tool's result as MCP content: its value as JSON, and an image it carries as image content. */
function rendered(value: unknown) {
  const image = value && typeof value === 'object' && 'image' in value ? (value as { image?: { data?: unknown; mediaType?: unknown } }).image : undefined
  if (image && typeof image.data === 'string' && typeof image.mediaType === 'string') {
    const { image: _image, ...rest } = value as Record<string, unknown>
    return { content: [{ type: 'text' as const, text: JSON.stringify(rest) }, { type: 'image' as const, data: image.data, mimeType: image.mediaType }] }
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(value ?? null) }] }
}
/**
 * An in-process MCP server of the host's tools. The SDK checks each call's arguments against the schema's shape; the tool's own
 * schema then parses them in full, refinements and strictness included, and a refusal comes back as an error the model reads.
 */
export function mcpServer(tools: readonly Tool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools: tools.map(definition => {
    const shape = definition.schema instanceof z.ZodObject ? (definition.schema as z.ZodObject).shape : {}
    return mcpTool(definition.name, definition.description, shape, async (args: unknown, extra: unknown) => {
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal
      try { return rendered(await definition.execute(definition.schema.parse(args), signal)) }
      catch (error) {
        const text = error instanceof z.ZodError ? `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`
          : error instanceof UserError ? error.message : `Failed: ${error instanceof Error ? error.message : String(error)}`
        return { isError: true, content: [{ type: 'text' as const, text }] }
      }
    })
  }) })
}
/** The SDK model options of a role's model: its id, and its effort when it names one Claude Code takes. */
function modelOptions(model: RoleModel | null): Pick<Options, 'model' | 'effort'> {
  if (!model) return {}
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(model.reasoningEffort ?? '') ? { effort: model.reasoningEffort as Options['effort'] } : {}
  return { model: model.model, ...effort }
}

/**
 * Builds and runs the router's Session and every worker's: what each starts with (prompts, tools, hooks, sandbox, skills,
 * environment, model), and the ledger of what each was handed and has not taken. The router's relays and notices go through
 * the durable `relay` and `notice` effects, in order, each at most once per request id. Each start records the prompt revision
 * it composed, so a Session may read the revisions it worked under.
 */
export class Sessions {
  readonly router: ClaudeSession
  private readonly workers = new Map<string, ClaudeSession>()
  /** The ticket of each worker Session made, by Session id. */
  private readonly tickets = new Map<string, string>()
  /** Sessions waiting on a model's budget, by Session id. */
  private readonly retries = new Map<string, { attempts: number; since: string; lastAt: string; status: number | null; error: string }>()
  private readonly skillDirs = new Map<number, Promise<string>>()
  constructor(private readonly host: SessionsHost) {
    this.router = new ClaudeSession(host.masterId, host.routerDirectory, () => this.routerStart(), this.events('router', {
      // An idle router whose prompt or options changed starts again, so its next turn reads them.
      idle: session => { void session.stale().then(stale => stale && !session.busy ? session.close() : undefined).catch(() => {}) },
    }), host.sdk, this.ledger(host.masterId))
    host.effects.handle('relay', ({ text }, requestId) => this.toRouter(stableUuid('relay', requestId), text, 'next'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) =>
      this.toRouter(stableUuid('notice', name, key(JSON.stringify(value))), `Notice: ${summary}\n${JSON.stringify(value)}`, 'inject'), { ordered: true })
  }
  /**
   * The worker Session of a ticket: the one made earlier, or with `ticket` and `events`, a new one whose start reads the ticket
   * as it is then. Without them, undefined when none was made.
   */
  worker(ticketId: string): ClaudeSession | undefined
  worker(ticketId: string, ticket: () => Ticket, events: SessionEvents): ClaudeSession
  worker(ticketId: string, ticket?: () => Ticket, events?: SessionEvents): ClaudeSession | undefined {
    let session = this.workers.get(ticketId)
    if (!session && ticket && events) {
      const id = workerSessionId(ticketId)
      session = new ClaudeSession(id, ticket().execution?.directory ?? '', () => this.workerStart(ticket()), this.events(`worker ${ticketId.slice(0, 12)}`, events),
        this.host.sdk, this.ledger(id))
      this.workers.set(ticketId, session); this.tickets.set(id, ticketId)
    }
    return session
  }
  /** A Session's ledger in the store, so what it was handed and did not take outlives the process. */
  private ledger(sessionId: string): SessionLedger {
    const name = KV.sessions.inbox(sessionId)
    return { pending: () => this.host.store.get(name) ?? [],
      save: pending => { if (pending.length) this.host.store.set(name, pending); else this.host.store.delete(name) } }
  }
  /** Events every Session reports to Sessions, around those of its owner: model retries for health, and failures for the log. */
  private events(label: string, more: SessionEvents): SessionEvents {
    return { ...more,
      message: (session, message) => { this.observe(session.id, message); this.host.activity?.(session.id, message); more.message?.(session, message) },
      idle: (session, result) => { this.clearRetry(session.id); more.idle?.(session, result) },
      ended: (session, error) => {
        this.clearRetry(session.id)
        if (error) this.host.logger.warn('claude-superagent: the %s Session %s ended: %s', label, session.id, String(error))
        more.ended?.(session, error)
      },
    }
  }
  /** The ticket whose worker a Session is, or undefined for the router. */
  ticketOf(sessionId: string): string | undefined { return this.tickets.get(sessionId) }
  /** Deliver to the router once per uuid, restarting its Session first when it is idle and its prompt or options changed. */
  private async toRouter(uuid: string, text: string, delivery: Delivery, authorize?: () => void): Promise<void> {
    if (this.router.open && !this.router.busy && await this.router.stale()) await this.router.close()
    await this.router.send(uuid, text, delivery, authorize)
  }
  /** Deliver `text` to a Session, the router or a worker, once per `requestId`; `authorize` runs last before it is handed over. */
  async prompt(session: ClaudeSession, requestId: string, text: string, delivery: Delivery, authorize?: () => void): Promise<void> {
    if (session === this.router) return this.toRouter(stableUuid('prompt', requestId), text, delivery, authorize)
    await session.send(this.promptedId(session.id, requestId), text, delivery, authorize)
  }
  /** The uuid of the message `prompt` delivers to a Session under `requestId`, the same on every retry. */
  promptedId(sessionId: string, requestId: string): string { return stableUuid('prompt', sessionId, requestId) }
  /** Queue a relay for the router: a candidate, a worker's report or question, a person's follow-up. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Queue a notice for the router, which reaches its history without starting a turn; a newer notice of `name` replaces a waiting one. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for the runnable notices, then says whether notice `name` reached the router (`injected`) or still waits (`pending`). */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }

  /**
   * The model a Session works with, as upstream seeds a new Session only: the role's model when the Session was made, which a
   * model Claude Code does not list fails before it is recorded; a Session made before the host recorded models keeps the one
   * its history last used. A change applies to Sessions made after it.
   */
  private async sessionModel(sessionId: string, cwd: string, model: RoleModel | null): Promise<RoleModel | null> {
    const name = KV.sessions.model(sessionId), kept = this.host.store.get(name)
    if (kept !== undefined) return kept
    const sdk = this.host.sdk ?? AGENT_SDK
    if (await sdk.getSessionInfo(sessionId, { dir: cwd }).catch(() => undefined)) {
      const used = (await sdk.getSessionMessages(sessionId, { dir: cwd }).catch(() => [])).flatMap(message =>
        message.type === 'assistant' && typeof (message.message as { model?: unknown })?.model === 'string' ? [(message.message as { model: string }).model] : []).at(-1)
      const resumed = used ? { provider: PROVIDER, model: used } : null
      this.host.store.set(name, resumed)
      return resumed
    }
    if (model) await this.host.checkModel?.(model)
    this.host.store.set(name, model)
    return model
  }
  /**
   * The router Session's start: its complete prompt, the host's tools, no built-in tool but Skill, which loads the team's
   * skills, and no setting of the operator's.
   */
  private async routerStart(): Promise<SessionStart> {
    const version = this.host.prompts.current(), settings = this.host.store.settings()
    const prompt = this.host.prompts.compose(version.config, 'orchestrator', this.host.variables())
    const plugin = await this.skills(version)
    this.bind(this.host.masterId, version.revision)
    const model = await this.sessionModel(this.host.masterId, this.host.routerDirectory, settings.eval.model)
    const options: SessionStart['options'] = {
      ...modelOptions(model), systemPrompt: `[claude-superagent prompt revision ${version.revision}]\n${prompt}`,
      tools: ['Skill'], mcpServers: { [MCP_SERVER]: mcpServer(this.host.tools()) }, allowedTools: [`mcp__${MCP_SERVER}__*`, 'Skill'],
      permissionMode: 'dontAsk', plugins: [{ type: 'local', path: plugin }], settingSources: [], env: this.host.environment(),
      stderr: line => { this.host.logger.warn('router: %s', line.trimEnd()) },
    }
    return { options, fingerprint: key(JSON.stringify({ prompt, model, revision: version.revision })) }
  }
  /**
   * A worker Session's start: Claude Code's own prompt with the worker's appended, the host's worker tools beside the built-in
   * ones the worker may use, the host's hooks and sandbox, and the host's skills as a plugin.
   */
  async workerStart(ticket: Ticket): Promise<SessionStart> {
    const version = this.host.prompts.current(), settings = this.host.store.settings()
    const current = this.host.store.tickets.get(ticket.id) ?? ticket
    const prompt = `${this.host.prompts.compose(version.config, 'worker', this.host.variables(current))}\n${mandateInstructions(current.mandate)}`.trimEnd()
    const plugin = await this.skills(version)
    const id = workerSessionId(ticket.id)
    this.bind(id, version.revision)
    const model = await this.sessionModel(id, current.execution?.directory ?? '', settings.executor.model)
    const { bash, env, ...sandbox } = this.host.shell()
    const options: SessionStart['options'] = {
      ...modelOptions(model),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: `[claude-superagent prompt revision ${version.revision}]\n${prompt}` },
      mcpServers: { [MCP_SERVER]: mcpServer(this.host.tools(current)) }, disallowedTools: WORKER_DENIED,
      allowedTools: bash ? [...WORKER_ALLOWED, 'Bash'] : SANDBOXED_ALLOWED, permissionMode: 'dontAsk', ...sandbox,
      hooks: this.host.hooks(current), plugins: [{ type: 'local', path: plugin }], settingSources: [], env: { ...workerSessionEnvironment(this.host.environment()), ...env },
      stderr: line => { this.host.logger.warn('worker %s: %s', ticket.id.slice(0, 12), line.trimEnd()) },
    }
    return { options, fingerprint: key(JSON.stringify({ prompt, model, revision: version.revision })) }
  }
  /**
   * The skills of a prompt version as a Claude Code plugin under the state directory, one directory per revision, so a
   * Session started under an earlier revision keeps reading its own: the built-in Source skills and the team's, each a
   * `skills/<name>/SKILL.md`, which a Session loads as `superagent:<name>`. The latest few revisions stay on disk.
   */
  private skills(version: PromptVersion): Promise<string> {
    let dir = this.skillDirs.get(version.revision)
    if (!dir) {
      dir = this.writeSkills(version)
      this.skillDirs.set(version.revision, dir)
      dir.catch(() => { this.skillDirs.delete(version.revision) })
    }
    return dir
  }
  private async writeSkills(version: PromptVersion): Promise<string> {
    const base = join(this.host.stateDir, 'plugin'), root = join(base, `r${version.revision}`)
    await rm(root, { recursive: true, force: true })
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0',
      description: 'Skills claude-superagent gives its Sessions' }, null, 2))
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const description = bundled?.description ?? (content.replace(/\s+/g, ' ').slice(0, 200) || 'A claude-superagent team skill.')
      await mkdir(join(root, 'skills', name), { recursive: true })
      await writeFile(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}\n`)
    }
    // Revisions older than the latest few go: a Session still started under one starts again under the current revision.
    const kept = (await readdir(base).catch(() => [] as string[])).flatMap(entry => /^r\d+$/.test(entry) ? [Number(entry.slice(1))] : [])
    for (const revision of kept.sort((a, b) => b - a).slice(KEPT_SKILL_REVISIONS)) {
      if (revision !== version.revision) await rm(join(base, `r${revision}`), { recursive: true, force: true })
    }
    return root
  }

  /** Record that a Session works under `revision` from now on. */
  private bind(sessionId: string, revision: number): void {
    const revisions = this.host.store.get(KV.sessions.prompts(sessionId)) ?? []
    if (revisions.at(-1) !== revision) this.host.store.set(KV.sessions.prompts(sessionId), [...revisions.filter(item => item !== revision), revision])
  }
  /** The current prompt revision, the revision each Session works under, and whether a prompt notice still waits for the router. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return revision === undefined ? [] : [{ sessionId, revision }]
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** The prompt version a Session works under: the one its latest start composed, or the current one. */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session may read `revision`: one it works or worked under. */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** A Session's wait on a model usage limit, for its ticket's card while it waits. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retries.get(sessionId) : undefined
    return retry ? { model_retry: { attempts: retry.attempts, since: retry.since, status: retry.status, error: retry.error } } : {}
  }
  /**
   * Follow a Session's model retries, as upstream follows its budget retries: a retry for billing (`billing_error`, the account
   * out of credit) is a wait on the model's budget; a passing failure is not, a rate limit (HTTP 429, which Claude Code also
   * reports for a passing throttle) included. A step that answers, or a turn that ends, ends the wait; an attempt count that is
   * not a whole number from 1 is no retry.
   */
  private observe(sessionId: string, message: SDKMessage): void {
    const m = message as { type: string; subtype?: string; attempt?: unknown; error_status?: number | null; error?: string }
    if (m.type === 'assistant' || m.type === 'result') { this.clearRetry(sessionId); return }
    if (m.type !== 'system' || m.subtype !== 'api_retry') return
    if (m.error !== 'billing_error') { this.clearRetry(sessionId); return }
    if (typeof m.attempt !== 'number' || !Number.isInteger(m.attempt) || m.attempt < 1) return
    const now = new Date().toISOString(), before = this.retries.get(sessionId)
    const attempts = Math.min(m.attempt, Number.MAX_SAFE_INTEGER)
    if (before && attempts <= before.attempts) return
    this.retries.set(sessionId, { attempts, since: before?.since ?? now, lastAt: now, status: typeof m.error_status === 'number' ? m.error_status : null, error: m.error })
    this.updateHealth()
  }
  private clearRetry(sessionId: string): void { if (this.retries.delete(sessionId)) this.updateHealth() }
  private updateHealth(): void {
    const waiting = [...this.retries].map(([sessionId, retry]) =>
      `${sessionId}: waits on the model's budget (${retry.error}${retry.status ? `, HTTP ${retry.status}` : ''}); retried ${retry.attempts} times since ${retry.since}; the model and retry policy are unchanged`)
    this.host.health.set(waiting.length ? { state: 'error', detail: waiting.slice(0, 5).join('; ') + (waiting.length > 5 ? `; ${waiting.length - 5} more Sessions` : ''),
      at: new Date().toISOString() } : { state: 'ready', detail: 'No Session is waiting on a model budget' })
  }
  /** End every Session's query; what they were handed and did not take stays in their ledgers. */
  async dispose(): Promise<void> { await Promise.allSettled([this.router.close(), ...[...this.workers.values()].map(session => session.close())]) }
}
