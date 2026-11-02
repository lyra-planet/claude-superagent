/**
 * Ported from upstream's tests/service-script.spec.ts, which ran scripts/dsh-superagent with stubbed ps, tmux and dsh. Here the
 * service in the background is src/service.ts behind src/cli.ts: one state directory per service (upstream's profile), a pid
 * file the service writes, one log per run in `<stateDir>/logs`, and a mark a person's stop leaves. The CLI runs as a child
 * process against temporary state directories whose paths have spaces; a case that would start the service runs src/service.ts
 * with a stand-in service process instead, as `start --detach` and `restart` would start the real one. Upstream's `start` of
 * a running service reports its health, which is `check` here (`start` refuses a running one, src/cli.ts:97).
 *
 * Left out, as this host does not have the behaviour:
 * - 'refuses to stop when two processes serve the profile, before it writes the stop marker', 'takes no `dsh plugin` command
 *   of the profile for its service': upstream found its service by scanning processes; this host knows it by its pid file
 *   alone (tests/service.spec.ts covers a pid file that names another process).
 * - 'refuses a second control operation while one holds the profile's lock': the CLI takes no lock of its own; a second service
 *   on the state directory fails at the Runtime's lock of it (src/app/runtime.ts:126).
 * - 'refuses to start a service while no process runs it but something answers at its URL': `start` asks nothing at the
 *   service's URL before it runs the service, which these tests may not start.
 * - 'starts the service in a new window of the profile's tmux session when the session exists': no tmux; `start --detach` runs
 *   the service as a detached process.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { configFile } from '../src/deployment.ts'
import { logsDir, pidFile, runningPid, startDetached, stopMark, stopService, stoppedByPerson } from '../src/service.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'claude-superagent.mjs')
let root: string
let servers: Server[] = []
let sleepers: ChildProcess[] = []
/** Stand-in services the case started, by pid. */
let started = new Set<number>()
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'claude-superagent-stand-in.mjs'), STAND_IN)
})
/** Whether `pid` runs one of this case's stand-ins, by its command line. */
const standsIn = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(join(root, 'bin')) } catch { return false } }
afterEach(() => {
  for (const server of servers) server.close()
  servers = []
  for (const child of sleepers) child.kill()
  sleepers = []
  // Each state directory's pid file names its latest stand-in, such as one that took over from a stopped one.
  for (const entry of readdirSync(root)) {
    const file = pidFile(join(root, entry))
    if (existsSync(file)) started.add(Number(readFileSync(file, 'utf8').trim()))
  }
  for (const pid of started) if (Number.isInteger(pid) && pid > 1 && standsIn(pid)) process.kill(pid, 'SIGKILL')
  started = new Set()
  rmSync(root, { recursive: true, force: true })
})

/**
 * A stand-in for `claude-superagent start`: it writes its pid file as the service does, says so in its log, answers on `--port`
 * and exits on SIGTERM; with `--ignore-term` it does not stop, and with `--successor` another instance takes over its pid file
 * before it exits. It exits by itself after a minute.
 */
const STAND_IN = `import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
const flag = name => process.argv.indexOf(name)
const pidFile = process.argv[flag('--pid-file') + 1]
const port = flag('--port') > 0 ? Number(process.argv[flag('--port') + 1]) : 0
writeFileSync(pidFile, process.pid + '\\n')
console.log('started')
const server = port ? createServer((req, res) => res.end('{}')).listen(port, '127.0.0.1') : undefined
setTimeout(() => process.exit(0), 60_000)
process.on('SIGTERM', () => {
  if (flag('--ignore-term') > 0) return
  console.log('stopping')
  server?.close()
  if (flag('--successor') < 0) { rmSync(pidFile, { force: true }); process.exit(0) }
  spawn(process.execPath, [process.argv[1], 'start', '--pid-file', pidFile], { detached: true, stdio: 'ignore' }).unref()
  const wait = () => { if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) setTimeout(wait, 20); else process.exit(0) }
  wait()
})
`
/** The command that runs a stand-in on `stateDir`. */
const standIn = (stateDir: string, options: { port?: number; ignoreTerm?: boolean; successor?: boolean } = {}) =>
  [process.execPath, join(root, 'bin', 'claude-superagent-stand-in.mjs'), 'start', '--pid-file', pidFile(stateDir),
    ...options.port ? ['--port', String(options.port)] : [], ...options.ignoreTerm ? ['--ignore-term'] : [], ...options.successor ? ['--successor'] : []]
const answers = (port: number) => () => fetch(`http://127.0.0.1:${port}/`).then(response => response.ok, () => false)
const freePort = () => new Promise<number>(resolve => { const server = createNetServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as AddressInfo; server.close(() => resolve(port)) }) })
/**
 * A state directory named `name` whose service answers on `port`. Its database path is a directory, so a service started on it
 * by mistake fails as it opens it, before it starts any Claude Code Session.
 */
function state(name: string, port: number): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'orchestrator.sqlite'), { recursive: true })
  writeFileSync(configFile(dir), JSON.stringify({ port }))
  return dir
}
/** Run the CLI with no Claude Code or Anthropic credentials in its environment. */
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC|CLAUDE)/.test(name))), HOME: root }
  return new Promise(resolve => execFile(process.execPath, ['--experimental-transform-types', '--no-warnings', BIN, ...args], { env, timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** A stand-in management API that answers every request with `body`; its port. */
async function answering(body: unknown): Promise<number> {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}
/** Stop the service on `stateDir`, which does not stop, past the stop's five minutes on a faked clock: why it gave up. */
async function timedOut(stateDir: string, mark: boolean): Promise<string> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    const outcome = stopService(stateDir, mark).then(() => 'stopped', (error: unknown) => String(error))
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000)
    return await outcome
  } finally { vi.useRealTimers() }
}

it('keeps a stop per profile', async () => {
  // Adapted: a profile is a state directory; `--respect-stop start` is `check --respect-stop`. The stop prints whether it
  // stopped a service, where upstream's said recovery pauses: the mark is what pauses it.
  const port = await freePort()
  const one = state('one', port), two = state('two', port)
  expect(await run('stop', '--state', one)).toMatchObject({ code: 0, stdout: expect.stringContaining('claude-superagent is not running') })
  expect(stoppedByPerson(one)).toBe(true)
  expect(await run('status', '--state', one)).toMatchObject({ code: 1, stdout: expect.stringContaining('(a person stopped it)') })
  expect((await run('status', '--state', two)).stdout).not.toContain('(a person stopped it)')
  expect(stoppedByPerson(two)).toBe(false)
  // The check leaves the service stopped: it starts nothing (and the mark guards that it would not start the real service).
  expect(stoppedByPerson(one)).toBe(true)
  const skipped = await run('check', '--respect-stop', '--state', one)
  expect(runningPid(one)).toBeUndefined()
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('stopped by a person') })
}, 30_000)

it('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  // Adapted: the stand-in writes the pid file as the service does (src/service.ts ownPidFile); its log is the run's own in the
  // state directory, whose path has a space; the second instance is a second `start`, which the pid file refuses.
  const port = await freePort()
  const dir = state('state dir', port)
  const { pid, log } = await startDetached(dir, standIn(dir, { port }), answers(port))
  started.add(pid)
  expect(readFileSync(pidFile(dir), 'utf8')).toBe(`${pid}\n`)
  expect(runningPid(dir)).toBe(pid)
  expect([log.slice(0, logsDir(dir).length), basename(log)]).toEqual([logsDir(dir), expect.stringMatching(/^service-[\d-]+T[\d-]+Z\.log$/)])
  expect(readFileSync(log, 'utf8')).toContain('started')
  expect(runningPid(dir)).toBe(pid)
  expect(await run('start', '--state', dir)).toMatchObject({ code: 1, stderr: expect.stringContaining(`claude-superagent runs already on ${dir} (pid ${pid})`) })
  expect(runningPid(dir)).toBe(pid)
}, 30_000)

it('waits only for the process it stopped', async () => {
  // Adapted: another instance takes over the pid file as the stopped one ends.
  const port = await freePort()
  const dir = state('state', port)
  const { pid } = await startDetached(dir, standIn(dir, { port, successor: true }), answers(port))
  started.add(pid)
  expect(await run('stop', '--state', dir)).toMatchObject({ code: 0, stdout: expect.stringContaining('claude-superagent stopped') })
  const next = runningPid(dir)
  expect(next).toEqual(expect.any(Number))
  expect(next).not.toBe(pid)
}, 30_000)

it('keeps only the newest logs it wrote for the profile', async () => {
  // Adapted: another profile's logs are another state directory's; a log of another name is one the service did not write,
  // such as a person's redirect of a foreground run, where upstream's were an earlier version's.
  const port = await freePort()
  const dir = state('state', port), other = state('other', port)
  for (const target of [dir, other]) {
    mkdirSync(logsDir(target), { recursive: true })
    for (let index = 0; index < 25; index++) {
      const log = join(logsDir(target), `service-2026-09-01T00-00-${String(index).padStart(2, '0')}-000Z.log`)
      writeFileSync(log, '')
      utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
    }
  }
  writeFileSync(join(logsDir(dir), 'claude-superagent.log'), '')
  const { pid, log } = await startDetached(dir, standIn(dir, { port }), answers(port))
  started.add(pid)
  const logs = readdirSync(logsDir(dir))
  const own = logs.filter(name => name.startsWith('service-')).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  expect(own).not.toContain('service-2026-09-01T00-00-00-000Z.log')
  expect(own.filter(name => !name.startsWith('service-2026-09-01T'))).toEqual([basename(log)])
  expect(readdirSync(logsDir(other))).toHaveLength(25)
  expect(logs).toContain('claude-superagent.log')
}, 30_000)

/** `status` of a state directory whose service answers with `body`. */
const statusOf = async (body: unknown) => run('status', '--state', state(`state ${servers.length}`, await answering(body)))

it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await statusOf(feishu)).toMatchObject({ code: 0 })
  expect(await statusOf({ health: { runtime: { state: 'ready' } } })).toMatchObject({ code: 0 })
  expect(await statusOf({ health: { runtime: { state: 'error' } } })).toMatchObject({ code: 1 })
}, 30_000)

it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  // Adapted: the CLI prints the state as JSON, where upstream's script wrote a sentence.
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const dir = state('state', await answering(github))
  const checked = await run('status', '--state', dir)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  // The service answers, so the check starts nothing.
  const again = await run('check', '--state', dir)
  expect(again).toMatchObject({ code: 2 })
  expect(JSON.parse(again.stdout)).toMatchObject({ errors: { github: 'bad token' } })
}, 30_000)

it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const dir = state('state', await answering(waiting))
  expect(await run('status', '--state', dir)).toMatchObject({ code: 3 })
  expect(await run('check', '--state', dir))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('The GitHub Source names no repository.') })
}, 30_000)

it('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  // Adapted: `restart` is a stop without the mark and a start (src/cli.ts:245), here on the stand-in; the stop gives up after
  // five minutes, on a faked clock.
  const port = await freePort()
  const dir = state('state', port)
  started.add((await startDetached(dir, standIn(dir, { port }), answers(port))).pid)
  expect(await stopService(dir, false)).toBe(true)
  const next = await startDetached(dir, standIn(dir, { port }), answers(port))
  started.add(next.pid)
  expect(stoppedByPerson(dir)).toBe(false)
  expect(readFileSync(pidFile(dir), 'utf8')).toBe(`${next.pid}\n`)
  // A service that does not stop in time is left running, and the next check may restart it.
  await stopService(dir, false)
  const stuck = await startDetached(dir, standIn(dir, { port, ignoreTerm: true }), answers(port))
  started.add(stuck.pid)
  expect(await timedOut(dir, false)).toMatch(/did not stop within 5 minutes/)
  expect(stoppedByPerson(dir)).toBe(false)
  expect(runningPid(dir)).toBe(stuck.pid)
}, 30_000)

it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  // Adapted: the wait is startDetached's, which `start --detach` fails with (src/cli.ts:99); the stand-in answers nothing.
  const dir = state('state', await freePort())
  await expect(startDetached(dir, standIn(dir), async () => false, 2000)).rejects.toThrow('claude-superagent did not answer within 2 seconds')
  const pid = runningPid(dir)
  expect(pid).toEqual(expect.any(Number))
  started.add(pid!)
  expect(() => process.kill(pid!, 0)).not.toThrow()
}, 30_000)

it('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  const port = await freePort()
  const dir = state('state', port)
  const other = spawn('sleep', ['60'], { stdio: 'ignore' })
  sleepers.push(other)
  writeFileSync(pidFile(dir), `${other.pid}\n`)
  expect(await run('stop', '--state', dir)).toMatchObject({ code: 0 })
  expect(() => process.kill(other.pid!, 0)).not.toThrow()
  // A service that does not stop in time keeps the stop, so recovery does not start it again. Adapted: on the stand-in, as above.
  rmSync(stopMark(dir))
  started.add((await startDetached(dir, standIn(dir, { port, ignoreTerm: true }), answers(port))).pid)
  expect(await timedOut(dir, true)).toMatch(/did not stop within 5 minutes/)
  expect(stoppedByPerson(dir)).toBe(true)
}, 30_000)

it('starts nothing in the place of another program that answers on the port, and writes nothing for an init it refuses', async () => {
  // Adapted: what this host's command adds to upstream's script.
  const dir = state('state', await answering(READY))
  rmSync(join(dir, 'orchestrator.sqlite'), { recursive: true })
  expect(await run('start', '--detach', '--state', dir)).toMatchObject({ code: 1, stderr: expect.stringContaining('Something else answers on port') })
  const fresh = join(root, 'fresh')
  const refused = await run('init', '--state', fresh, '--repo', 'acme/widgets', '--gh', 'gh', '--sandbox', 'sometimes')
  expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('executor.sandbox') })
  expect(existsSync(join(fresh, 'orchestrator.sqlite')) || existsSync(configFile(fresh))).toBe(false)
  expect(await run('init', '--state', fresh, '--repo', 'acme/widgets', '--gh', 'gh', '--sandbox', 'weak')).toMatchObject({ code: 0 })
}, 60_000)
