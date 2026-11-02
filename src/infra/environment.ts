/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because worker commands never inherit credential-shaped variables (`CREDENTIAL_NAME`).
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by claude-superagent on every start; edits are lost.'
/** Markers of files upstream's dsh-superagent and its earlier names wrote, which this host owns and replaces too. */
const LEGACY_MARKERS = ['dsh-superagent', 'dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
import { WORKER_COMMANDS } from './worker-commands.ts'
export { WORKER_COMMANDS }
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
export const sandboxIgnore = (stateDir: string): string => join(stateDir, 'sandbox-gitignore')
/**
 * What Claude Code 2.1's Bash sandbox mounts over in the working directory while a command runs, so that a command cannot write
 * the shell, git, editor or Claude Code configuration it would be run with. They are device files git cannot add.
 */
export const SANDBOX_PLACEHOLDERS = ['.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea', '.mcp.json', '.profile', '.ripgreprc', '.vscode',
  '.zprofile', '.zshrc', ...['.cc-writes', 'agents', 'commands', 'hooks', 'launch.json', 'loop.md', 'output-styles', 'routines', 'scheduled_tasks.json',
    'settings.json', 'settings.local.json', 'skills', 'workflows'].map(name => `.claude/${name}`)]
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/**
 * git configuration a worker Session's commands get through the environment, which outranks a clone's own config: the agent's
 * identity, since Claude Code denies `git -c` and `VAR=… git` without asking, so a worker commits with a plain `git commit`
 * (`--author` for another author); and, sandboxed, `sandboxIgnore`, since `git add -A` fails on the sandbox's placeholders.
 */
export function workerGitVariables(stateDir: string, agent: { login: string; noreply: string } | undefined, sandboxed: boolean): Record<string, string> {
  const config = [...agent ? [['user.name', agent.login], ['user.email', agent.noreply]] : [], ...sandboxed ? [['core.excludesFile', sandboxIgnore(stateDir)]] : []]
  return { GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([name, value], index) => [[`GIT_CONFIG_KEY_${index}`, name!], [`GIT_CONFIG_VALUE_${index}`, value!]])) }
}

/** True when a regular file starts with this host's marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by claude-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
  // Sandboxed workers' git reads it as core.excludesFile; anchored at the repository root, so a nested file of the name still counts.
  await own(sandboxIgnore(stateDir), [MARKER, ...SANDBOX_PLACEHOLDERS.map(path => `/${path}`)].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** How a command ran: its exit code (null when a signal stopped it) and what it printed. */
export interface SubprocessResult { exitCode: number | null; stdout: string; stderr: string }
/** Runs a command the way worker shells run it; the host passes `nodeSubprocess`, tests a stand-in. */
export interface SubprocessRuntime {
  run(argv: string[], options: { cwd: string; signal: AbortSignal; env?: Record<string, string> }): Promise<SubprocessResult>
}
/** Environment variables a worker command never inherits: credential-shaped names, as upstream's DSH subprocess service strips them. */
export const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/
/**
 * Runs commands as child processes of the host, with the host's environment minus credential-shaped variables, plus `env`;
 * output beyond 1 MiB (stdout) or 64 KiB (stderr) is cut, and an abort sends SIGTERM, then SIGKILL after two seconds.
 */
export const nodeSubprocess: SubprocessRuntime = {
  run: (argv, { cwd, signal, env }) => new Promise((resolve, reject) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL_NAME.test(name)))
    let child: ReturnType<typeof spawn>
    try { child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { reject(error); return }
    // Bytes are kept up to the limit and decoded once at the end, so a character the pipe splits across chunks stays whole.
    const take = (limit: number) => {
      const chunks: Buffer[] = []; let size = 0
      return { add: (chunk: Buffer) => { if (size < limit) { const part = chunk.subarray(0, limit - size); chunks.push(part); size += part.length } },
        get: () => new TextDecoder('utf-8').decode(Buffer.concat(chunks)) }
    }
    const stdout = take(1 << 20), stderr = take(1 << 16)
    child.stdout!.on('data', stdout.add); child.stderr!.on('data', stderr.add)
    let kill: ReturnType<typeof setTimeout> | undefined
    const abort = () => { child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 2000) }
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    child.on('error', error => { signal.removeEventListener('abort', abort); clearTimeout(kill); reject(error) })
    child.on('close', code => { signal.removeEventListener('abort', abort); clearTimeout(kill); resolve({ exitCode: code, stdout: stdout.get(), stderr: stderr.get() }) })
  }),
}
/** Runs a command through `subprocess` and answers its standard output, or throws a `CliError` with what it printed to standard error. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const { exitCode, stdout, stderr } = await subprocess.run(argv, { cwd, signal, ...env ? { env } : {} })
  if (exitCode === 0) return stdout
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(stderr.trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
