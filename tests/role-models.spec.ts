/**
 * Ported from upstream's tests/role-models.spec.ts. Upstream seeds a role's model onto a new DSH Session
 * (src/app/role-models.ts); here a Session takes its role's model when the host first starts it and keeps it for its life
 * (Sessions.sessionModel, src/app/sessions.ts:187), which each start passes to the query as `model`. The cases run a worker on
 * the Runtime and the stand-in Claude Code: a start is a query the stand-in saw, with the options it was given.
 *
 * Left out, as DSH-only:
 * - 'lets a later explicit selection win without changing the in-flight assembled step': the host offers no way to choose a
 *   Session's model by hand; a person who opens a worker's Session in Claude Code (`claude-superagent open`) chooses for that
 *   process alone.
 * - The prompt variables and the persistence flush of 'keeps prompt variables and initial routing on the role model without
 *   saving the host default': the host's prompts take no model variable, and it records the model in its store.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PROVIDER } from '../src/app/models.ts'
import { KV } from '../src/kv.ts'
import type { RoleModel } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const model = (name: string): RoleModel => ({ provider: PROVIDER, model: name })
/** The workers' model, saved as a setting, as one the panel checked when it was saved. */
function workerModel(value: RoleModel | null) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: value } })
}
/** The options of each start of a Session, oldest first. */
const starts = (sessionId: string) => h.claude.queries.filter(query => query.session.id === sessionId).map(query => query.options)
/**
 * The worker's turn ends without a report, so it reports waiting and its query closes; a person's follow-up on its thread
 * starts the Session again.
 */
async function startsAgain(one: { sessionId: string }, id: string) {
  h.claude.session(one.sessionId).end()
  await h.runtime.idle()
  await new Promise(resolve => setImmediate(resolve))
  expect(h.claude.session(one.sessionId).query).toBeUndefined()
  h.runtime.receive(feishu(id, '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  expect(h.claude.session(one.sessionId).query).toBeDefined()
}

it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  workerModel(model('worker-model'))
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  expect(starts(one.sessionId).map(options => options.model)).toEqual(['worker-model'])
  expect(h.runtime.store.get(KV.sessions.model(one.sessionId))).toEqual(model('worker-model'))
  // The worker's model is its own: the router, which the host's default runs, does not take it.
  expect(starts(h.runtime.masterId).map(options => options.model)).not.toContain('worker-model')
  expect(h.runtime.store.get(KV.sessions.model(h.runtime.masterId))).toBeNull()
  // Adapted: a later start of the same Session, once its model is recorded, keeps it, where upstream retried a step.
  await startsAgain(one, '2')
  expect(starts(one.sessionId).map(options => options.model)).toEqual(['worker-model', 'worker-model'])
})

/**
 * `selection`: the host recorded the model the Session was made with. `header`: the Session ran in Claude Code, and the host
 * recorded no model for it, as for a Session from before it recorded one. A role model saved since applies to neither.
 */
async function preserves(kind: string) {
  h.claude.models.push('existing', 'new')
  workerModel(model('existing'))
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.claude.session(one.sessionId).assistant({ type: 'text', text: 'Looking.' })
  if (kind === 'header') h.runtime.store.delete(KV.sessions.model(one.sessionId))
  workerModel(model('new'))
  await startsAgain(one, '2')
  expect(starts(one.sessionId)).toHaveLength(2)
  expect(starts(one.sessionId).at(-1)!.model).not.toBe('new')
}
it.each(['selection'])('preserves a resumed Session with existing %s', preserves)
it.each(['header'])('preserves a resumed Session with existing %s', preserves)

it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  workerModel(null)
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  // Unset, the worker runs Claude Code's default model, whichever the credentials in use give.
  expect(starts(one.sessionId)[0]).not.toHaveProperty('model')
  // A model Claude Code does not list fails the start before the Session records it.
  workerModel(model('x'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(starts(two.sessionId).map(options => options.model)).not.toContain('x')
  expect(h.runtime.store.get(KV.sessions.model(two.sessionId))).toBeUndefined()
})
