// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { initialLocation, parseRoute, remember, setupPage } from '../src/client/route.ts'
it('reopens the page this tab showed last, and the overview for a route that no longer exists', () => {
  remember({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  // The Eval tab was previously named Policy; a route saved under the old name falls back to overview.
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'policy' }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' }, stack: [{ page: 'policy' }, { page: 'trigger' }] }))
  expect(initialLocation().stack).toEqual([{ page: 'trigger' }])
  sessionStorage.setItem('dsh-superagent/route', '{')
  expect(initialLocation().route).toEqual({ page: 'overview' })
})
it('reads each page a tab remembered with the parameters it takes, and leaves out what it does not know', () => {
  expect(parseRoute({ page: 'trigger', query: { filter: 'nope', trigger: 'e1' } })).toEqual({ page: 'trigger' })
  expect(parseRoute({ page: 'trigger', id: 'github:1', query: { trigger: 'e1', filter: 'recent' } }))
    .toEqual({ page: 'trigger', id: 'github:1', query: { trigger: 'e1' } })
  expect(parseRoute({ page: 'eval', query: { filter: 'stop', window: '7d' } })).toEqual({ page: 'eval', query: { filter: 'stop' } })
  expect(parseRoute({ page: 'execution', id: 5, query: { filter: 'idle' } })).toEqual({ page: 'execution', query: { filter: 'idle' } })
  expect(parseRoute({ page: 'settings', query: { group: 'policy', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'source', source: 'feishu' } })
  expect([parseRoute('overview'), parseRoute(null)]).toEqual([undefined, undefined])
})
it('opens the settings that fix each setup problem: the Deployment group, or the card of the Source it names', () => {
  expect(setupPage('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  for (const place of ['github', 'feishu'] as const) expect(setupPage(place)).toEqual({ page: 'settings', query: { group: 'source', source: place } })
})
