/**
 * The `claude-superagent` command: set up a state directory, run the service in the foreground, check on it, and hand it work
 * from the terminal. `--state <dir>` (or `CLAUDE_SUPERAGENT_STATE`) names the state directory, `~/.claude-superagent` by default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigSchema, machineOf, type DeploymentConfig } from './deployment.ts'
import { consoleLogger } from './infra/log.ts'
import { SettingsSchema } from './policy.ts'
import { Store } from './app/store.ts'
import { Runtime, type Route } from './app/runtime.ts'

const USAGE = `claude-superagent <command> [--state <dir>]

  init    Create a state directory with its settings
            --repo <owner/name>   GitHub repository the agent works on
            --gh <cli>            gh, or a gh wrapper, signed in as the agent account
            --clone <path>        local clone of the repository each ticket checks out from
            --operator <name>     your name for requests from this terminal (default: operator)
            --port <n>            port of the panel and API (default: 3082)
            --allow-host <host>   a Host a gateway forwards the panel from, such as gw.example.com; repeatable
            --sandbox on|weak|off the workers' Bash sandbox (default: on)
            --mode off|observe|auto   proactive work (default: observe)
  start   Run the service in the foreground (Ctrl-C stops it)
  status  Print the service's state; exits 0 ok, 1 not running, 2 a part reports an error, 3 setup waits
  ask <text>  Hand the agent a request; --thread <id> continues a conversation, --wait follows the replies
  inbox [<id>]  List conversations, or print one
`
const { values: flags, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
  state: { type: 'string' }, repo: { type: 'string' }, gh: { type: 'string' }, clone: { type: 'string' }, operator: { type: 'string' },
  port: { type: 'string' }, 'allow-host': { type: 'string', multiple: true }, sandbox: { type: 'string' }, mode: { type: 'string' },
  thread: { type: 'string' }, wait: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} })
const stateDir = resolve(flags.state ?? process.env.CLAUDE_SUPERAGENT_STATE ?? join(homedir(), '.claude-superagent'))
const configPath = join(stateDir, 'config.json')
const fail = (message: string): never => { process.stderr.write(`${message}\n`); process.exit(1) }

function readConfig(): DeploymentConfig {
  if (!existsSync(configPath)) fail(`No state directory at ${stateDir}: run claude-superagent init first`)
  return ConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')))
}
const api = (port: number) => `http://127.0.0.1:${port}`
async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const { port } = readConfig()
  const response = await fetch(`${api(port)}${path}`, { method: init.method ?? 'GET', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    ...init.body === undefined ? {} : { body: JSON.stringify(init.body) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

/** The prepare command that gives each ticket a worktree of `clone`, on a branch named after the ticket. */
function prepareCommand(clone: string): string {
  const quoted = `'${clone.replaceAll("'", "'\\''")}'`
  return [`git -C ${quoted} fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "\${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/superagent/$DSH_SUPERAGENT_TICKET"`,
    `git -C ${quoted} worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/superagent/$DSH_SUPERAGENT_TICKET"`].join(' &&\n')
}
function init(): void {
  if (existsSync(join(stateDir, 'orchestrator.sqlite'))) fail(`${stateDir} is set up already; change its settings in the panel`)
  const repository = flags.repo ?? fail('init needs --repo <owner/name>')
  const cli = flags.gh ?? fail('init needs --gh <cli signed in as the agent account>')
  const clone = flags.clone ? resolve(flags.clone) : undefined
  if (clone && !existsSync(join(clone, '.git'))) fail(`${clone} is not a git clone`)
  const operator = flags.operator ?? 'operator'
  const config = ConfigSchema.parse({ port: flags.port ? Number(flags.port) : undefined, allowedHosts: flags['allow-host'] })
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  try {
    store.saveSettings(SettingsSchema.parse({
      // A Source the settings leave out counts as on, so Feishu, which needs a bot set up first, is written off.
      sources: { github: { enabled: true, config: { repository, cli } }, local: { enabled: true, config: { operator } }, feishu: { enabled: false } },
      policy: { sources: { local: { allowed: [{ id: operator }] }, github: { allowed: [] } } },
      eval: { mode: flags.mode ?? 'observe' },
      executor: { sandbox: flags.sandbox ?? 'on', ...clone ? { prepare: prepareCommand(clone) } : {} },
    }), { source: 'internal', policyVersion: '', policyChanged: false, notified: [] })
  } finally { store.close() }
  process.stdout.write(`Set up ${stateDir}
  repository  ${repository}, as the account ${cli} signs in to
  terminal    requests from "${operator}" become tickets
  checkout    ${clone ? `a worktree of ${clone} per ticket` : 'none: each ticket starts in an empty directory (set a prepare command in the panel)'}
Next: claude-superagent start --state ${stateDir}
`)
}

async function start(): Promise<void> {
  const machine = machineOf(stateDir, readConfig())
  // The panel is optional: a checkout without its build serves the API alone.
  const panelModule = './app/panel.ts'
  const built = existsSync(new URL('../lib/panel/index.html', import.meta.url))
  const panel = built ? await import(panelModule).then(module => (module as { panelHandler(dir: string): Route }).panelHandler(new URL('../lib/panel/', import.meta.url).pathname))
    .catch(() => undefined) : undefined
  let runtime: Runtime | undefined
  let restarting = false
  const run = async () => {
    runtime = new Runtime(machine, { logger: consoleLogger, ...panel ? { panel } : {}, restart: () => {
      if (restarting) return
      restarting = true
      consoleLogger.info('claude-superagent restarts to run setup again')
      void runtime!.stop().then(run).finally(() => { restarting = false })
    } })
    await runtime.start()
  }
  const stop = (signal: string) => {
    consoleLogger.info('claude-superagent stops (%s)', signal)
    void (runtime?.stop() ?? Promise.resolve()).then(() => process.exit(0))
  }
  process.once('SIGINT', () => { stop('SIGINT') })
  process.once('SIGTERM', () => { stop('SIGTERM') })
  await run()
  consoleLogger.info('panel and API at http://127.0.0.1:%s/', machine.port)
}

async function status(): Promise<number> {
  const state = await call('/orchestrator/api/state').catch(() => undefined)
  if (!state || state.status !== 200) { process.stdout.write('claude-superagent is not running\n'); return 1 }
  const { setup, health, load, paused } = state.body
  const errors = Object.entries(health as Record<string, { state: string; detail: string }>).filter(([, entry]) => entry.state === 'error')
  process.stdout.write(`${JSON.stringify({ setup: setup.problem, accounts: setup.accounts, paused, load, errors: Object.fromEntries(errors.map(([name, entry]) => [name, entry.detail])) }, null, 2)}\n`)
  if (health.runtime?.state === 'error') return 1
  if (setup.problem) return 3
  return errors.length ? 2 : 0
}

async function ask(text: string): Promise<void> {
  const asked = await call('/local/messages', { method: 'POST', body: { text, ...flags.thread ? { conversation: flags.thread } : {} } })
  if (asked.status !== 200) fail(`The request was refused: ${asked.body.error ?? asked.status}`)
  const { conversation } = asked.body as { conversation: string }
  process.stdout.write(`conversation ${conversation}\n`)
  if (!flags.wait) { process.stdout.write(`Read the replies with: claude-superagent inbox ${conversation}\n`); return }
  let seen = 0
  const deadline = Date.now() + 60 * 60_000
  while (Date.now() < deadline) {
    const { body } = await call(`/local/conversations/${conversation}?after=${seen}`)
    for (const message of body.messages as { from: string; text: string; agent?: boolean; kind?: string }[]) {
      process.stdout.write(`${message.agent ? `agent (${message.kind})` : message.from}: ${message.text}\n`)
      if (message.agent && message.kind !== 'acknowledgement') return
    }
    seen = body.next
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}
async function inbox(id?: string): Promise<void> {
  if (!id) {
    const { body } = await call('/local/conversations')
    for (const item of body.conversations as { id: string; messages: number; first: string; at: string }[]) process.stdout.write(`${item.id}  ${item.at}  ${item.messages} messages  ${item.first}\n`)
    return
  }
  const { status: code, body } = await call(`/local/conversations/${id}`)
  if (code !== 200) fail(body.error ?? `HTTP ${code}`)
  for (const message of body.messages as { from: string; at: string; text: string; agent?: boolean; kind?: string }[]) {
    process.stdout.write(`[${message.at}] ${message.agent ? `agent (${message.kind})` : message.from}: ${message.text}\n`)
  }
}

const [command, ...rest] = positionals
if (flags.help || !command) { process.stdout.write(USAGE); process.exit(command ? 0 : 2) }
switch (command) {
  case 'init': init(); break
  case 'start': await start(); break
  case 'status': process.exit(await status())
  case 'ask': await ask(rest.join(' ') || fail('ask needs the request text')); break
  case 'inbox': await inbox(rest[0]); break
  default: process.stderr.write(USAGE); process.exit(2)
}
