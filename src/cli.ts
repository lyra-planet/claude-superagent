/**
 * The `claude-superagent` command: set up a state directory, run the service in the foreground or the background, check on
 * it, hand it work, and open a worker's Session in Claude Code. Without a command, in a terminal, it opens the interactive
 * terminal. `--state <dir>` (or `CLAUDE_SUPERAGENT_STATE`) names the state directory, `~/.claude-superagent` by default.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ConfigSchema, configFile, machineOf, type DeploymentConfig } from './deployment.ts'
import { consoleLogger } from './infra/log.ts'
import { runClaude, type Held } from './open.ts'
import { SettingsSchema } from './policy.ts'
import { ServiceClient, type TerminalTicket } from './remote.ts'
import { latestLog, ownPidFile, runningPid, startDetached, stopService, stoppedByPerson } from './service.ts'
import { Store } from './app/store.ts'
import { Runtime, type Route } from './app/runtime.ts'

const USAGE = `claude-superagent [command] [--state <dir>]

  (none)  Open the interactive terminal: talk to the agent, follow its tickets, open a worker's Session
  init    Create a state directory with its settings
            --repo <owner/name>   GitHub repository the agent works on
            --gh <cli>            gh, or a gh wrapper, signed in as the agent account
            --clone <path>        local clone of the repository each ticket checks out from
            --operator <name>     your name for requests from this terminal (default: operator)
            --port <n>            port of the panel and API (default: 3082)
            --allow-host <host>   a Host a gateway forwards the panel from, such as gw.example.com; repeatable
            --sandbox on|weak|off the workers' Bash sandbox (default: on)
            --mode off|observe|auto   proactive work (default: observe)
  start   Run the service in the foreground (Ctrl-C stops it); --detach runs it in the background with a log
  stop    Stop the service in the background and wait for it; a scheduled check with --respect-stop leaves it stopped
  restart Stop the service and start it in the background
  status  Print the service's state; exits 0 ok, 1 not running, 2 a part reports an error, 3 setup waits
  check   Start the service in the background unless it runs (for cron); --respect-stop leaves a stopped one stopped
  logs    Print the latest log; -f follows it
  ask <text>    Hand the agent a request; --thread <id> continues a conversation, --wait follows the replies
  inbox [<id>]  List conversations, or print one
  tickets       List the tickets
  open <ticket> Open the ticket's worker Session in Claude Code; --now cuts its turn short, --fork opens a copy
`
const { values: flags, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
  state: { type: 'string' }, repo: { type: 'string' }, gh: { type: 'string' }, clone: { type: 'string' }, operator: { type: 'string' },
  port: { type: 'string' }, 'allow-host': { type: 'string', multiple: true }, sandbox: { type: 'string' }, mode: { type: 'string' },
  thread: { type: 'string' }, wait: { type: 'boolean' }, detach: { type: 'boolean', short: 'd' }, follow: { type: 'boolean', short: 'f' },
  'respect-stop': { type: 'boolean' }, now: { type: 'boolean' }, fork: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} })
const stateDir = resolve(flags.state ?? process.env.CLAUDE_SUPERAGENT_STATE ?? join(homedir(), '.claude-superagent'))
const fail = (message: string): never => { process.stderr.write(`${message}\n`); process.exit(1) }
const say = (message: string) => { process.stdout.write(`${message}\n`) }

function readConfig(): DeploymentConfig {
  if (!existsSync(configFile(stateDir))) fail(`No state directory at ${stateDir}: run claude-superagent init first`)
  return ConfigSchema.parse(JSON.parse(readFileSync(configFile(stateDir), 'utf8')))
}
const service = () => new ServiceClient(readConfig().port)
/** The command that runs the service in the foreground on this state directory, as this process was started. */
const foreground = () => [process.execPath, ...process.execArgv, fileURLToPath(new URL('../bin/claude-superagent.mjs', import.meta.url)), 'start', '--state', stateDir]

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
  writeFileSync(configFile(stateDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
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
  say(`Set up ${stateDir}
  repository  ${repository}, as the account ${cli} signs in to
  terminal    requests from "${operator}" become tickets
  checkout    ${clone ? `a worktree of ${clone} per ticket` : 'none: each ticket starts in an empty directory (set a prepare command in the panel)'}
Next: claude-superagent start --detach --state ${stateDir}, then claude-superagent --state ${stateDir}`)
}

async function start(): Promise<void> {
  const config = readConfig()
  const running = runningPid(stateDir)
  if (running !== undefined) fail(`claude-superagent runs already on ${stateDir} (pid ${running})`)
  if (flags.detach) {
    const { pid, log } = await startDetached(stateDir, foreground(), () => service().running()).catch((error: unknown) => fail(String(error instanceof Error ? error.message : error)))
    say(`claude-superagent runs in the background (pid ${pid}); panel at http://127.0.0.1:${config.port}/; log ${log}`)
    return
  }
  const machine = machineOf(stateDir, config)
  // The panel is optional: a checkout without its build serves the API alone.
  const panelModule = './app/panel.ts'
  const built = existsSync(new URL('../lib/panel/index.html', import.meta.url))
  const panel = built ? await import(panelModule).then(module => (module as { panelHandler(dir: string): Route }).panelHandler(new URL('../lib/panel/', import.meta.url).pathname))
    .catch(() => undefined) : undefined
  const release = ownPidFile(stateDir)
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
    void (runtime?.stop() ?? Promise.resolve()).finally(() => { release(); process.exit(0) })
  }
  process.once('SIGINT', () => { stop('SIGINT') })
  process.once('SIGTERM', () => { stop('SIGTERM') })
  await run()
  consoleLogger.info('panel and API at http://127.0.0.1:%s/', machine.port)
}
async function stop(mark = true): Promise<boolean> {
  const stopped = await stopService(stateDir, mark, () => { say('Waiting for the workers to stop…') })
  say(stopped ? 'claude-superagent stopped' : 'claude-superagent is not running')
  return stopped
}

async function status(): Promise<number> {
  const state = await service().call('GET', '/orchestrator/api/state').catch(() => undefined)
  if (!state || state.status !== 200) { say(`claude-superagent is not running${stoppedByPerson(stateDir) ? ' (a person stopped it)' : ''}`); return 1 }
  const { setup, health, load, paused } = state.body
  const errors = Object.entries(health as Record<string, { state: string; detail: string }>).filter(([, entry]) => entry.state === 'error')
  say(JSON.stringify({ pid: runningPid(stateDir) ?? null, setup: setup.problem, accounts: setup.accounts, paused, load,
    errors: Object.fromEntries(errors.map(([name, entry]) => [name, entry.detail])) }, null, 2))
  if (health.runtime?.state === 'error') return 1
  if (setup.problem) return 3
  return errors.length ? 2 : 0
}
/** For cron, as upstream's hourly check: start the service unless it runs, or unless a person stopped it and `--respect-stop`. */
async function check(): Promise<number> {
  if (await service().running()) return status()
  if (flags['respect-stop'] && stoppedByPerson(stateDir)) { say('claude-superagent is stopped by a person; leaving it stopped'); return 1 }
  flags.detach = true
  await start()
  return status()
}
async function logs(): Promise<void> {
  const log = latestLog(stateDir) ?? fail(`No log yet in ${join(stateDir, 'logs')}: the service logs there when it runs with --detach`)
  let offset = 0
  const print = () => {
    const text = readFileSync(log, 'utf8')
    process.stdout.write(text.slice(offset)); offset = text.length
  }
  print()
  if (!flags.follow) return
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (statSync(log).size !== offset) print()
  }
}

async function ask(text: string): Promise<void> {
  const client = service()
  const { conversation } = await client.ask(text, flags.thread).catch((error: unknown) => fail(`The request was refused: ${String(error instanceof Error ? error.message : error)}`))
  say(`conversation ${conversation}`)
  if (!flags.wait) { say(`Read the replies with: claude-superagent inbox ${conversation}`); return }
  let seen = 0
  const deadline = Date.now() + 60 * 60_000
  while (Date.now() < deadline) {
    const { messages, next } = await client.conversation(conversation, seen)
    for (const message of messages) {
      say(`${message.agent ? `agent (${message.kind})` : message.from}: ${message.text}`)
      if (message.agent && message.kind !== 'acknowledgement') return
    }
    seen = next
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}
async function inbox(id?: string): Promise<void> {
  const client = service()
  if (!id) {
    for (const item of (await client.conversations()).conversations) say(`${item.id}  ${item.at}  ${item.messages} messages  ${item.first}`)
    return
  }
  const { messages } = await client.conversation(id).catch((error: unknown) => fail(String(error instanceof Error ? error.message : error)))
  for (const message of messages) say(`[${message.at}] ${message.agent ? `agent (${message.kind})` : message.from}: ${message.text}`)
}
/** A ticket by its id or the start of it. */
async function ticketNamed(ref: string): Promise<TerminalTicket> {
  const { tickets } = await service().tickets()
  const found = tickets.filter(ticket => ticket.id.startsWith(ref))
  if (found.length !== 1) fail(found.length ? `${ref} names ${found.length} tickets; give more of its id` : `No ticket ${ref}`)
  return found[0]!
}
async function tickets(): Promise<void> {
  for (const ticket of (await service().tickets()).tickets) {
    const pr = ticket.threads.find(thread => thread.source === 'github' && thread.url)?.url
    say(`${ticket.id.slice(0, 8)}  ${ticket.stage.padEnd(7)} ${ticket.title}${pr ? `  ${pr}` : ''}${ticket.held ? '  (a person holds its Session)' : ''}`)
  }
}
/** Open a worker's Session in Claude Code: hand it to the person, run Claude Code, take it back; a fork takes nothing. */
async function open(ref: string): Promise<number> {
  const client = service()
  const ticket = await ticketNamed(ref)
  if (flags.fork) return runClaude({ ...await client.ok<Held>('GET', `/local/tickets/${ticket.id}/session`), stopped: 0 }, true)
  const before = await client.ok<Held & { working: boolean }>('GET', `/local/tickets/${ticket.id}/session`)
  if (before.working && !flags.now) say('The worker is in a turn; its Session opens once that turn ends (--now cuts it short)…')
  const held = await client.ok<Held>('POST', `/local/tickets/${ticket.id}/hold`, { now: !!flags.now })
  if (held.stopped) say(`Stopped ${held.stopped} background task(s) the worker left running.`)
  say(`Opening the worker's Session of "${ticket.title}" in Claude Code; the worker waits until you leave it.`)
  try { return await runClaude(held, false) }
  finally {
    await client.ok('POST', `/local/tickets/${ticket.id}/release`).catch((error: unknown) => {
      process.stderr.write(`The service did not take the Session back (${String(error)}); run: claude-superagent open ${ticket.id.slice(0, 8)} again, then leave it.\n`)
    })
    say('The worker has its Session back.')
  }
}
/** The interactive terminal, built into lib/tui.mjs by `npm run build`. */
async function terminal(): Promise<void> {
  const built = new URL('../lib/tui.mjs', import.meta.url)
  if (!existsSync(built)) fail('The terminal is not built: run npm run build in the claude-superagent checkout')
  readConfig()
  const tui = await import(built.href) as { main(options: { stateDir: string; port: number; foreground: string[] }): Promise<void> }
  await tui.main({ stateDir, port: readConfig().port, foreground: foreground() })
}

const [command, ...rest] = positionals
if (flags.help) { process.stdout.write(USAGE); process.exit(0) }
switch (command) {
  case undefined:
    if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write(USAGE); process.exit(2) }
    await terminal(); break
  case 'init': init(); break
  case 'start': await start(); break
  case 'stop': await stop(); break
  case 'restart': await stop(false); flags.detach = true; await start(); break
  case 'status': process.exit(await status())
  case 'check': process.exit(await check())
  case 'logs': await logs(); break
  case 'ask': await ask(rest.join(' ') || fail('ask needs the request text')); break
  case 'inbox': await inbox(rest[0]); break
  case 'tickets': await tickets(); break
  case 'open': process.exit(await open(rest[0] ?? fail('open needs a ticket id')))
  default: process.stderr.write(USAGE); process.exit(2)
}
