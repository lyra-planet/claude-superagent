import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { panelHandler } from '../src/app/panel.ts'

// A built panel in `<base>/panel`, and a file beside it that must stay out of reach.
const base = mkdtempSync(join(tmpdir(), 'panel-handler-'))
const dir = join(base, 'panel')
mkdirSync(join(dir, 'assets'), { recursive: true })
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Superagent</title>')
writeFileSync(join(dir, 'panel.js'), 'export {}')
writeFileSync(join(dir, 'panel.css'), ':root{}')
writeFileSync(join(dir, 'assets', 'icon.svg'), '<svg/>')
writeFileSync(join(dir, 'notes.txt'), 'not built')
writeFileSync(join(base, 'secret.css'), 'secret')
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

async function get(pathname: string, method = 'GET') {
  const sent: { status?: number; headers?: Record<string, unknown>; body?: string } = {}
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) { Object.assign(sent, { status, headers }); return res },
    end(body?: Buffer | string) { if (body !== undefined) sent.body = String(body); return res },
  }
  const served = await panelHandler(dir)({ method } as IncomingMessage, res as unknown as ServerResponse, pathname)
  return { served, ...sent }
}

it('serves index.html for the root, never cached, and each built file by its type', async () => {
  expect(await get('/')).toMatchObject({ served: true, status: 200, body: '<!doctype html><title>Superagent</title>',
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  expect(await get('/index.html')).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' } })
  expect(await get('/panel.js')).toMatchObject({ served: true, status: 200, body: 'export {}',
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } })
  expect(await get('/panel.css')).toMatchObject({ headers: { 'content-type': 'text/css; charset=utf-8', 'content-length': 7 } })
  expect(await get('/assets/icon.svg')).toMatchObject({ status: 200, headers: { 'content-type': 'image/svg+xml' } })
  // HEAD answers with the headers only.
  expect(await get('/panel.js', 'HEAD')).toEqual({ served: true, status: 200, headers: expect.objectContaining({ 'content-length': 9 }) })
})

it('leaves every other request to the server: the API, missing files, files the build does not write, directories, other methods', async () => {
  for (const pathname of ['/orchestrator/api/state', '/missing.js', '/notes.txt', '/assets', '/assets/', '/%E0%A4%A']) {
    expect(await get(pathname)).toEqual({ served: false })
  }
  expect(await get('/panel.js', 'POST')).toEqual({ served: false })
})

it('refuses a path that leaves the panel directory, however it is written, or that carries a NUL', async () => {
  for (const pathname of ['/../secret.css', '/assets/../../secret.css', '/..%2Fsecret.css', '/%2e%2e/secret.css', '/panel.js%00.css']) {
    expect(await get(pathname)).toMatchObject({ served: true, status: 403 })
  }
})
