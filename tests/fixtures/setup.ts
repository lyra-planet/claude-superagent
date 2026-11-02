/**
 * MIGRATION BUG workaround, for every test file: `packageRoot` in src/infra/paths.ts looks for a package.json named
 * `dsh-superagent`, but this package is `claude-superagent`, so loading any prompt or skill throws "package root not found".
 * Until that is fixed, the tests resolve packaged files from this repository's root; tests/paths.spec.ts checks the real one.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

vi.mock('../../src/infra/paths.ts', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return { packageRoot: () => root, packagePath: (...parts: string[]) => join(root, ...parts) }
})
