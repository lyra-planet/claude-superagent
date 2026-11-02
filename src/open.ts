/**
 * Open a worker's Session in Claude Code's own terminal, as upstream's panel opened an Executor Session in DSH's UI: the
 * service hands the Session to the person (`POST /local/tickets/<id>/hold`), Claude Code resumes it in the ticket's directory
 * with the worker's git, and once the person leaves, the service takes it back. A fork leaves the worker alone.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

/** What the service answers for a hold. */
export interface Held { sessionId: string; cwd: string; claudeConfigDir: string; stopped: number; env: Record<string, string> }
/** The variables of a Claude Code session the terminal may run in, which the Claude Code it starts must not inherit. */
const SESSION_VARIABLES = /^(CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_PID$|CLAUDE_EFFORT$)/

/**
 * The Claude Code the service runs its Sessions with, bundled with the Agent SDK, so the Session's history is one it reads;
 * `CLAUDE_SUPERAGENT_CLAUDE` names another.
 */
export function claudeBinary(): string {
  if (process.env.CLAUDE_SUPERAGENT_CLAUDE) return process.env.CLAUDE_SUPERAGENT_CLAUDE
  const require = createRequire(import.meta.url)
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  for (const name of [base, `${base}-musl`]) {
    try {
      const binary = join(dirname(require.resolve(`${name}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude')
      if (existsSync(binary)) return binary
    } catch { /* Not installed for this platform. */ }
  }
  return 'claude'
}
/**
 * Claude Code's first start in the service's configuration directory walks a person through its onboarding; the directory is
 * the service's, so it counts as done. Whether to trust the ticket's folder, which loads the repository's own settings, stays
 * the person's to answer.
 */
export function skipOnboarding(claudeConfigDir: string): void {
  const file = join(claudeConfigDir, '.claude.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch { /* None yet. */ }
  if (config.hasCompletedOnboarding) return
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...config, hasCompletedOnboarding: true }, null, 2), { mode: 0o600 })
  renameSync(temporary, file)
}
/** Run Claude Code on a held Session in the foreground of this terminal until the person leaves it; resolves with its exit code. */
export function runClaude(held: Held, fork: boolean): Promise<number> {
  skipOnboarding(held.claudeConfigDir)
  const { PATH_PREFIX, ...env } = held.env
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.test(name)))
  const path = [PATH_PREFIX, inherited.PATH].filter(Boolean).join(delimiter)
  const child = spawn(claudeBinary(), ['--resume', held.sessionId, ...fork ? ['--fork-session'] : []], {
    cwd: existsSync(held.cwd) ? held.cwd : undefined, stdio: 'inherit',
    env: { ...inherited, ...env, PATH: path, CLAUDE_CONFIG_DIR: held.claudeConfigDir },
  })
  // Claude Code handles Ctrl-C itself while it runs; a closed terminal or a stop ends it too, and this process lives on until
  // then, to hand the Session back.
  const ignore = () => {}
  const signals = ['SIGINT', 'SIGHUP', 'SIGTERM'] as const
  for (const signal of signals) process.on(signal, ignore)
  const done = () => { for (const signal of signals) process.off(signal, ignore) }
  return new Promise((resolve, reject) => {
    child.once('error', error => { done(); reject(error) })
    child.once('exit', code => { done(); resolve(code ?? 1) })
  })
}
/**
 * Drop what the terminal still sends after Claude Code left, such as its answers to the queries Claude Code made of it, so the
 * next screen does not read them as typing.
 */
export async function drainInput(ms = 200): Promise<void> {
  if (!process.stdin.isTTY) return
  const drop = () => {}
  process.stdin.setRawMode(true)
  process.stdin.on('data', drop)
  process.stdin.resume()
  await new Promise(resolve => setTimeout(resolve, ms))
  process.stdin.off('data', drop)
  process.stdin.pause()
  process.stdin.setRawMode(false)
}
