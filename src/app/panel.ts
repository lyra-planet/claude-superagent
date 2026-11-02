/** Serves the built panel (`npm run build:panel` writes it to `lib/panel`) beside the management API. */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

/** The files the build writes, by extension; anything else in the directory is not served. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * The panel as a request handler for a Node HTTP server: it answers GET and HEAD for `/` with `index.html` and for each built file
 * under `dir` by its path, and returns true; it returns false for any other request, which the server serves otherwise.
 * A path that leaves `dir` is refused with 403. `index.html` is never cached, so a new build reaches an open browser on reload;
 * the other files are revalidated each time, as their names do not change between builds.
 */
export function panelHandler(dir: string): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  const root = resolve(dir)
  return async (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    let name: string
    try { name = decodeURIComponent(pathname) } catch { return false }
    if (name === '/' || name === '') name = '/index.html'
    const file = resolve(root, `.${name.startsWith('/') ? '' : '/'}${name}`)
    if (name.includes('\0') || !file.startsWith(root + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden')
      return true
    }
    const type = TYPES[extname(file)]
    if (!type) return false
    let body: Buffer
    try { body = await readFile(file) } catch { return false }
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'x-content-type-options': 'nosniff',
      'cache-control': file === resolve(root, 'index.html') ? 'no-store' : 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }
}
