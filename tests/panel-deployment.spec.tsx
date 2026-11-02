// @vitest-environment jsdom
// The Deployment settings.
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, find, tab, click, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf } from './fixtures/panel-server.ts'

usePanel()
it('shows this machine\'s settings in the Deployment settings read-only, where they are kept, and no accounts', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('/srv/claude-superagent')
  // Accounts are on the Source settings.
  expect(text()).not.toContain('@agent-bot')
  for (const moved of ['仓库克隆', '工单 worktree 目录', '禁用的命令']) expect(text()).not.toContain(moved)
  expect(text()).toContain(zh.deploymentIntro)
  // The management API does not write config.json, so the limits show as the host read them, with where to change them.
  expect(text()).toContain(zh.deploymentReadOnly)
  for (const [label, value] of [[zh.deploymentPromptMaxChars, '100000'], [zh.deploymentContextPages, '10'], [zh.deploymentContextTimeout, '15000']]) {
    expect(field<HTMLInputElement>(label!)).toMatchObject({ disabled: true, value })
  }
  expect(all('button').some(button => button.textContent === zh.save)).toBe(false)
  expect(document.querySelector('.dt-savebar')).toBeNull()
})

it('names a setup problem on the Deployment settings, beside the check that runs setup again', async () => {
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const problem = document.querySelector('.dt-main .dt-row-buttons')!
  expect(problem.textContent).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(problem.querySelector('button')?.textContent).toBe(zh.setupCheck)
})

it('reads the state every second after a setup check, until claude-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})
