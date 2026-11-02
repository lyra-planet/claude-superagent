/**
 * Stand-in for `src/infra/paths.ts` in the panel tests. That module finds the package root by upstream's package name,
 * `dsh-superagent`, so in this package, `claude-superagent`, every module that reads a packaged prompt or skill fails to load.
 * The tests that read them mock it with this one, which takes the directory the tests run in as the root, until it names this package.
 */
import { join } from 'node:path'

const root = process.cwd()
export const packageRoot = (): string => root
export const packagePath = (...parts: string[]): string => join(root, ...parts)
