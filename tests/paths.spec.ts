/** Where packaged prompts and skills are read from. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

it('finds the package root from the source tree, where the prompts and skills are', async () => {
  const { packageRoot } = await vi.importActual<typeof import('../src/infra/paths.ts')>('../src/infra/paths.ts')
  expect(existsSync(join(packageRoot(), 'prompts', 'shared.md'))).toBe(true)
})
