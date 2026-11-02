/**
 * Open a worker's Session in Claude Code's own terminal, as upstream's panel opened an Executor Session in DSH's UI: the
 * service hands the Session to the person (`POST /local/tickets/<id>/hold`), Claude Code resumes it in the ticket's directory
 * with the worker's git, and once the person leaves, the service takes it back. A fork leaves the worker alone.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
/** Run Claude Code on a held Session in the foreground of this terminal until the person leaves it; resolves with its exit code. */
export function runClaude(held: Held, fork: boolean): Promise<number> {
  const { PATH_PREFIX, ...env } = held.env
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.test(name)))
  const path = [PATH_PREFIX, inherited.PATH].filter(Boolean).join(delimiter)
  const child = spawn(claudeBinary(), ['--resume', held.sessionId, ...fork ? ['--fork-session'] : []], {
    cwd: existsSync(held.cwd) ? held.cwd : undefined, stdio: 'inherit',
    env: { ...inherited, ...env, PATH: path, CLAUDE_CONFIG_DIR: held.claudeConfigDir },
  })
  // Claude Code handles Ctrl-C itself while it runs.
  const ignore = () => {}
  process.on('SIGINT', ignore)
  return new Promise((resolve, reject) => {
    child.once('error', error => { process.off('SIGINT', ignore); reject(error) })
    child.once('exit', code => { process.off('SIGINT', ignore); resolve(code ?? 1) })
  })
}
