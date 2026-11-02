/**
 * The service in the background, as upstream's service script ran it: a pid file the service writes itself, one log per run
 * (the latest 20 kept), a stop that signals only a process whose command line is the service's and waits for it, and a mark a
 * person's stop leaves so a scheduled check (`check --respect-stop`) does not start it again.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const pidFile = (stateDir: string): string => join(stateDir, 'service.pid')
export const stopMark = (stateDir: string): string => join(stateDir, 'stopped')
export const logsDir = (stateDir: string): string => join(stateDir, 'logs')
const KEPT_LOGS = 20
/** How long a stop waits for the service, which lets each worker finish within its own limit first. */
const STOP_WAIT_MS = 5 * 60_000

/** The command line of a process, or '' when it does not run or cannot be read. */
function commandOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') } catch { /* No procfs, as on macOS. */ }
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return ps.status === 0 ? ps.stdout.trim() : ''
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
/** The pid of the service that runs on `stateDir`: the one its pid file names, when it runs and its command line is the service's. */
export function runningPid(stateDir: string): number | undefined {
  if (!existsSync(pidFile(stateDir))) return undefined
  const pid = Number(readFileSync(pidFile(stateDir), 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return undefined
  const command = commandOf(pid)
  return command.includes('claude-superagent') && / start\b/.test(command) ? pid : undefined
}
/** The service writes its own pid file and removes it as it exits. */
export function ownPidFile(stateDir: string): () => void {
  writeFileSync(pidFile(stateDir), `${process.pid}\n`)
  return () => {
    const named = existsSync(pidFile(stateDir)) ? readFileSync(pidFile(stateDir), 'utf8').trim() : ''
    if (named === String(process.pid)) rmSync(pidFile(stateDir), { force: true })
  }
}
/** The newest log, if any. */
export function latestLog(stateDir: string): string | undefined {
  const logs = existsSync(logsDir(stateDir)) ? readdirSync(logsDir(stateDir)).filter(name => /^service-.*\.log$/.test(name)).sort() : []
  return logs.length ? join(logsDir(stateDir), logs.at(-1)!) : undefined
}
/**
 * Start the service in the background with `argv` (the command that runs it in the foreground), its output in a new log, and
 * wait until `ready` says it answers. Clears a person's stop mark.
 */
export async function startDetached(stateDir: string, argv: string[], ready: () => Promise<boolean>, waitMs = 60_000): Promise<{ pid: number; log: string }> {
  mkdirSync(logsDir(stateDir), { recursive: true })
  // Only the service's own logs go; anything else a person keeps there stays.
  const logs = readdirSync(logsDir(stateDir)).filter(name => /^service-.*\.log$/.test(name)).sort()
  for (const old of logs.slice(0, Math.max(0, logs.length - KEPT_LOGS + 1))) rmSync(join(logsDir(stateDir), old), { force: true })
  const log = join(logsDir(stateDir), `service-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const out = openSync(log, 'a')
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ['ignore', out, out], env: process.env })
  closeSync(out)
  child.unref()
  rmSync(stopMark(stateDir), { force: true })
  let exited: number | null | undefined
  child.once('exit', code => { exited = code })
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) return { pid: child.pid!, log }
    if (exited !== undefined) throw new Error(`claude-superagent exited with ${exited} as it started; see ${log}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`claude-superagent did not answer within ${waitMs / 1000} seconds; see ${log}`)
}
/**
 * Stop the service that runs on `stateDir` and wait for it to exit; `mark` records that a person stopped it. Answers false
 * when none runs.
 */
export async function stopService(stateDir: string, mark: boolean, waiting?: () => void): Promise<boolean> {
  if (mark) writeFileSync(stopMark(stateDir), `${new Date().toISOString()}\n`)
  const pid = runningPid(stateDir)
  if (pid === undefined) return false
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + STOP_WAIT_MS
  let told = false
  while (alive(pid) && Date.now() < deadline) {
    if (!told && Date.now() > deadline - STOP_WAIT_MS + 3000) { told = true; waiting?.() }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  if (alive(pid)) throw new Error(`claude-superagent (pid ${pid}) did not stop within ${STOP_WAIT_MS / 60_000} minutes`)
  return true
}
/** A start, in the foreground or the background, lifts a person's stop. */
export const clearStopMark = (stateDir: string): void => { rmSync(stopMark(stateDir), { force: true }) }
/** Whether a person stopped the service, which a scheduled check with `--respect-stop` leaves stopped. */
export const stoppedByPerson = (stateDir: string): boolean => existsSync(stopMark(stateDir))
