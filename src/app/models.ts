/** The models the router and the workers may run, as Claude Code lists them, in the shape the panel's model picker reads. */

/** One model a role may choose; `id` is what `query({ model })` takes. */
export interface CatalogModel { id: string; name: string; description?: string }
/**
 * The model catalog: one group, Claude Code's, whose models are the ones `supportedModels()` lists for the credentials in use.
 * `failures` says why a listing failed; the roles then keep whatever model they name.
 */
export interface ModelCatalog {
  default?: { provider: string; model: string }
  groups: { id: string; name: string; models: CatalogModel[] }[]
  failures: { provider: string; error: string }[]
}
/** The provider id every role model names: models come from Claude Code, whichever account or cloud it signs in to. */
export const PROVIDER = 'claude-code'

/** A catalog from what `supportedModels()` answered, or one that says why it could not be read. */
export function catalogOf(listed: readonly { value: string; displayName?: string; description?: string }[] | Error): ModelCatalog {
  if (listed instanceof Error) return { groups: [], failures: [{ provider: PROVIDER, error: listed.message }] }
  const models = listed.map(model => ({ id: model.value, name: model.displayName || model.value, ...model.description ? { description: model.description } : {} }))
  return { ...models[0] ? { default: { provider: PROVIDER, model: models[0].id } } : {}, groups: [{ id: PROVIDER, name: 'Claude Code', models }], failures: [] }
}
