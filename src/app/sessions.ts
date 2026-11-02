/**
 * The Claude Code Sessions of the router and the workers: what each starts with, the router's durable relays and notices,
 * the prompt revisions each Session worked under, and the model retries each waits on.
 */
import { createSdkMcpServer, tool as mcpTool, type HookCallbackMatcher, type HookEvent, type McpSdkServerConfigWithInstance, type Options,
  type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { UserError, key, type Ticket } from '../core/index.ts'
import { mandateInstructions, stableUuid, workerSessionId } from '../executor/common.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Logger } from '../infra/log.ts'
import type { RoleModel } from '../policy.ts'
import { KV } from '../kv.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import { ClaudeSession, type Delivery, type SessionEvents, type SessionStart } from './session.ts'
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
/** Tools a worker runs without a prompt; Bash is added when the sandbox is off, else the sandbox approves sandboxed commands. */
export const WORKER_ALLOWED = [`mcp__${MCP_SERVER}__*`, 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Agent', 'Skill']

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  readonly store: Pick<Store, 'settings' | 'get' | 'set' | 'keys' | 'tickets'>
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
 * Builds and runs the router's Session and builds every worker Session's start: prompts, tools, hooks, sandbox, skills and
 * environment. The router's relays and notices go through the durable `relay` and `notice` effects, in order, each at most
 * once per request id. Each start records the prompt revision it composed, so a worker may read the revisions it worked under.
 */
export class Sessions {
  readonly router: ClaudeSession
  private readonly retries = new Map<string, { attempts: number; since: string; lastAt: string; status: number | null }>()
  private skillsRevision?: number
  constructor(private readonly host: SessionsHost) {
    this.router = new ClaudeSession(host.masterId, host.routerDirectory, () => this.routerStart(), this.events('router'))
    host.effects.handle('relay', ({ text }, requestId) => this.toRouter(stableUuid('relay', requestId), text, 'next'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) =>
      this.toRouter(stableUuid('notice', name, key(JSON.stringify(value))), `Notice: ${summary}\n${JSON.stringify(value)}`, 'inject'), { ordered: true })
  }
  /** Events every Session reports to Sessions: model retries for health, and failures for the log. */
  events(label: string, more: SessionEvents = {}): SessionEvents {
    return {
      message: (session, message) => { this.observe(session.id, message); more.message?.(session, message) },
      turnEnded: (session, result, background) => { this.clearRetry(session.id); more.turnEnded?.(session, result, background) },
      ended: (session, error) => {
        this.clearRetry(session.id)
        if (error) this.host.logger.warn('claude-superagent: the %s Session %s ended: %s', label, session.id, String(error))
        more.ended?.(session, error)
      },
    }
  }
  /** Deliver to the router once per uuid, restarting its Session first when it is idle and its prompt or options changed. */
  private async toRouter(uuid: string, text: string, delivery: Delivery): Promise<void> {
    if (this.router.open && !this.router.busy && await this.router.stale()) await this.router.close()
    await this.router.send(uuid, text, delivery)
  }
  /** Deliver `text` to a Session: the router, or a worker whose Session the Executor passes. */
  async prompt(session: ClaudeSession, requestId: string, text: string, delivery: Delivery): Promise<void> {
    if (session === this.router) return this.toRouter(stableUuid('prompt', requestId), text, delivery)
    await session.send(this.promptedId(session.id, requestId), text, delivery)
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

  /** The router Session's start: its complete prompt, the host's tools only, no built-in tool, and no setting of the operator's. */
  private async routerStart(): Promise<SessionStart> {
    const version = this.host.prompts.current(), settings = this.host.store.settings()
    const prompt = this.host.prompts.compose(version.config, 'orchestrator', this.host.variables())
    this.bind(this.host.masterId, version.revision)
    const options: SessionStart['options'] = {
      ...modelOptions(settings.eval.model), systemPrompt: `[claude-superagent prompt revision ${version.revision}]\n${prompt}`,
      tools: [], mcpServers: { [MCP_SERVER]: mcpServer(this.host.tools()) }, allowedTools: [`mcp__${MCP_SERVER}__*`], permissionMode: 'dontAsk',
      settingSources: [], env: this.host.environment(), stderr: line => { this.host.logger.warn('router: %s', line.trimEnd()) },
    }
    return { options, fingerprint: key(JSON.stringify({ prompt, model: settings.eval.model })) }
  }
  /**
   * A worker Session's start: Claude Code's own prompt with the worker's appended, the host's worker tools beside the built-in
   * ones the worker may use, the host's hooks and sandbox, and the host's skills as a plugin.
   */
  async workerStart(ticket: Ticket): Promise<SessionStart> {
    const version = this.host.prompts.current(), settings = this.host.store.settings()
    const current = this.host.store.tickets.get(ticket.id) ?? ticket
    const prompt = `${this.host.prompts.compose(version.config, 'worker', this.host.variables(current))}\n${mandateInstructions(current.mandate)}`.trimEnd()
    const plugin = await this.writeSkills(version)
    this.bind(workerSessionId(ticket.id), version.revision)
    const { bash, env, ...sandbox } = this.host.shell()
    const options: SessionStart['options'] = {
      ...modelOptions(settings.executor.model),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: `[claude-superagent prompt revision ${version.revision}]\n${prompt}` },
      mcpServers: { [MCP_SERVER]: mcpServer(this.host.tools(current)) }, disallowedTools: WORKER_DENIED,
      allowedTools: bash ? [...WORKER_ALLOWED, 'Bash'] : WORKER_ALLOWED, permissionMode: 'dontAsk', ...sandbox,
      hooks: this.host.hooks(current), plugins: [{ type: 'local', path: plugin }], settingSources: [], env: { ...this.host.environment(), ...env },
      stderr: line => { this.host.logger.warn('worker %s: %s', ticket.id.slice(0, 12), line.trimEnd()) },
    }
    return { options, fingerprint: key(JSON.stringify({ prompt, model: settings.executor.model, revision: version.revision })) }
  }
  /**
   * Write the skills of a prompt version as a Claude Code plugin under the state directory, once per revision: the built-in
   * Source skills and the team's, each a `skills/<name>/SKILL.md`. Workers load it, so the GitHub skill reads as `superagent:github`.
   */
  private async writeSkills(version: PromptVersion): Promise<string> {
    const root = join(this.host.stateDir, 'plugin')
    if (this.skillsRevision === version.revision) return root
    await rm(join(root, 'skills'), { recursive: true, force: true })
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0',
      description: 'Skills claude-superagent gives its workers' }, null, 2))
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const description = bundled?.description ?? (content.replace(/\s+/g, ' ').slice(0, 200) || 'A claude-superagent team skill.')
      await mkdir(join(root, 'skills', name), { recursive: true })
      await writeFile(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}\n`)
    }
    this.skillsRevision = version.revision
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
  /** A Session's model retry, for its ticket's card while it waits on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retries.get(sessionId) : undefined
    return retry ? { model_retry: { attempts: retry.attempts, since: retry.since, status: retry.status } } : {}
  }
  private observe(sessionId: string, message: SDKMessage): void {
    const m = message as { type: string; subtype?: string; attempt?: number; error_status?: number | null }
    if (m.type !== 'system' || m.subtype !== 'api_retry') return
    const now = new Date().toISOString(), before = this.retries.get(sessionId)
    this.retries.set(sessionId, { attempts: m.attempt ?? (before?.attempts ?? 0) + 1, since: before?.since ?? now, lastAt: now, status: m.error_status ?? null })
    this.updateHealth()
  }
  private clearRetry(sessionId: string): void { if (this.retries.delete(sessionId)) this.updateHealth() }
  private updateHealth(): void {
    const waiting = [...this.retries].map(([sessionId, retry]) => `${sessionId}: retried ${retry.attempts} times since ${retry.since}${retry.status ? ` (HTTP ${retry.status})` : ''}`)
    this.host.health.set(waiting.length ? { state: 'error', detail: waiting.slice(0, 5).join('; '), at: new Date().toISOString() }
      : { state: 'ready', detail: 'No Session is waiting on a model retry' })
  }
  /** End the router's query; queued relays and notices stay in the effect queue. */
  async dispose(): Promise<void> { await this.router.close() }
}
