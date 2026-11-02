/**
 * Effect queue notice deduplication on the Runtime. Ported from upstream's tests/queue.spec.ts on the stand-in Claude Code
 * (tests/fixtures/claude.ts): upstream's `inject` into the main Session is a message the host pushes to the router with the
 * delivery 'inject', whose text is `Notice: <summary>\n<json>`.
 *
 * Left out, as DSH-only:
 * - 'delivers the relays, subscription changes and notifications that a version before the effect queue kept, once the
 *   migration queued them': a schema 10 database of upstream's; this host's first schema is 11, and it opens no other
 *   (src/app/store.ts:9).
 */
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeSession } from '../src/app/session.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const notices = (host: Host) => host.claude.to(host.runtime.masterId).filter(message => message.delivery === 'inject')
  .map(message => JSON.parse(message.text.slice(message.text.indexOf('\n') + 1)) as Record<string, unknown>)

it('keeps only the latest settings notice while the main Session cannot take one', async () => {
  h = await startRuntime()
  // Adapted: the router's Session refuses every injection, where upstream's main Session's `inject` threw.
  const send = ClaudeSession.prototype.send, router = h.runtime.masterId
  const inject = vi.spyOn(ClaudeSession.prototype, 'send').mockImplementation(function (this: ClaudeSession, ...args: Parameters<ClaudeSession['send']>) {
    if (this.id === router && args[2] === 'inject') return Promise.reject(new Error('session busy'))
    return send.apply(this, args)
  })
  expect(await h.runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  await h.runtime.settings.pause(false, 'panel')
  expect(h.runtime.effects.pending('notice', 'settings:pause')).toBe(true)
  inject.mockRestore()
  h.claude.pushed.mockClear()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(notices(h)).toEqual([{ settings_saved: 'pause', changed: ['paused'], read: 'settings/pause' }])
})
