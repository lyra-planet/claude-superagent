/** The service in the background: pid file, start, stop, the stop mark and logs, against a stand-in service process. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { latestLog, logsDir, pidFile, runningPid, startDetached, stopService, stoppedByPerson } from '../src/service.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'service-')) })
afterEach(() => { const pid = runningPid(dir); if (pid) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }) })
const freePort = () => new Promise<number>(resolve => { const server = createServer().listen(0, () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)) }) })
/** A stand-in for `claude-superagent start`: it writes its pid file, answers on its port, and exits a moment after SIGTERM. */
function standIn(port: number): string[] {
  const script = join(dir, 'claude-superagent-stand-in.mjs')
  writeFileSync(script, `import { writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
writeFileSync(${JSON.stringify(pidFile(dir))}, String(process.pid))
const server = createServer((req, res) => res.end('{}')).listen(${port}, '127.0.0.1', () => console.log('ready on ${port}'))
process.on('SIGTERM', () => { console.log('stopping'); server.close(); setTimeout(() => { rmSync(${JSON.stringify(pidFile(dir))}, { force: true }); process.exit(0) }, 200) })
`)
  return [process.execPath, script, 'start']
}

it('starts the service in the background with a log, knows its pid by its command line, and stops it with a mark', async () => {
  const port = await freePort()
  const ready = () => fetch(`http://127.0.0.1:${port}/`).then(response => response.ok, () => false)
  expect(runningPid(dir)).toBeUndefined()
  const { pid, log } = await startDetached(dir, standIn(port), ready)
  expect(runningPid(dir)).toBe(pid)
  expect(latestLog(dir)).toBe(log)
  expect(await stopService(dir, true)).toBe(true)
  expect(runningPid(dir)).toBeUndefined()
  expect(stoppedByPerson(dir)).toBe(true)
  expect(readFileSync(log, 'utf8')).toMatch(/ready on \d+\nstopping/)
  // Starting again clears the mark; nothing running is no stop.
  await startDetached(dir, standIn(port), ready)
  expect(stoppedByPerson(dir)).toBe(false)
  await stopService(dir, false)
  expect(await stopService(dir, false)).toBe(false)
})

it('signals no process its pid file names unless its command line is the service\'s', () => {
  writeFileSync(pidFile(dir), String(process.pid))
  expect(runningPid(dir)).toBeUndefined()
  writeFileSync(pidFile(dir), '1')
  expect(runningPid(dir)).toBeUndefined()
  writeFileSync(pidFile(dir), 'not a pid')
  expect(runningPid(dir)).toBeUndefined()
})

it('keeps the latest twenty logs, and says when one does not start', async () => {
  mkdirSync(logsDir(dir), { recursive: true })
  for (let index = 0; index < 25; index++) writeFileSync(join(logsDir(dir), `service-2026-01-${String(index + 1).padStart(2, '0')}.log`), '')
  const failing = [process.execPath, '-e', 'console.error("no config"); process.exit(3)']
  await expect(startDetached(dir, failing, async () => false)).rejects.toThrow(/exited with 3 as it started/)
  expect(readdirSync(logsDir(dir))).toHaveLength(20)
  expect(readFileSync(latestLog(dir)!, 'utf8')).toContain('no config')
})
