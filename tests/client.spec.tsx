// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { Standalone, initialLanguage, translator } from '../src/client/host.tsx'
import { en, zh } from '../src/client/locales.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const requests: { url: string; headers: Record<string, string> }[] = []
const serve = () => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  requests.push({ url, headers: init?.headers as Record<string, string> })
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), paused: false, health: {}, load: { running: 0, queued: 0, maxWorkers: 3 },
    setup: { machine: { stateDir: '/srv/state', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
const languages = (tags: string[]) => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(tags)
async function render() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Standalone />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const tabs = (container: HTMLElement) => [...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); requests.length = 0 })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('opens in the first of the browser\'s languages the panel has, and in English for any other', () => {
  languages(['ja-JP', 'zh-TW', 'en'])
  expect(initialLanguage()).toBe('zh')
  languages(['en-GB', 'zh-CN'])
  expect(initialLanguage()).toBe('en')
  languages(['fr-FR'])
  expect(initialLanguage()).toBe('en')
})

it('renders the panel in the browser\'s language, switches it from the header, and keeps the choice for the next visit', async () => {
  serve()
  languages(['zh-CN'])
  let view = await render()
  expect(tabs(view.container)).toEqual(['概览', '来源', '触发', '评估', '执行', '设置'])
  expect([document.documentElement.lang, document.title]).toEqual(['zh-CN', 'Superagent'])
  const toggle = [...view.container.querySelectorAll('button')].find(button => button.textContent === zh.otherLanguage)!
  expect(toggle.title).toBe(zh.switchLanguage)
  await act(async () => { toggle.click() })
  expect(tabs(view.container)).toEqual(['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  expect(document.documentElement.lang).toBe('en')
  expect([...view.container.querySelectorAll('button')].some(button => button.textContent === en.otherLanguage)).toBe(true)
  view.dispose()
  view = await render()
  expect(tabs(view.container)).toEqual(['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  view.dispose()
})

it('calls the management API relative to the page with the panel\'s header, so a gateway\'s path prefix carries it', async () => {
  serve()
  const view = await render()
  expect(requests.map(request => request.url)).toEqual(expect.arrayContaining(['orchestrator/api/state', 'orchestrator/api/overview']))
  expect(requests.every(request => request.url.startsWith('orchestrator/api/') && request.headers['x-orchestrator-request'] === '1')).toBe(true)
  view.dispose()
})

it('fills each placeholder a translation names, keeps one without a value, and reads an unknown key as itself', () => {
  const t = translator(zh)
  expect(t('searchFound', { tickets: 1, threads: 2, items: 3 })).toBe('找到 1 个工单、2 个线程、3 条触发')
  expect(t('requestFailed')).toBe('请求失败（{status}）。')
  expect(t('valueOf.missing' as never)).toBe('valueOf.missing')
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a claude-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // A server without the management routes, such as a gateway's or one that is starting, answers an empty 404.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})
