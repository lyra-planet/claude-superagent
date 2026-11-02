/**
 * Ported from upstream's tests/index.spec.ts, which tested the DSH plugin entry (src/index.ts `apply`). This host's entry is
 * `claude-superagent start` (src/cli.ts:94), which builds its Machine from `<stateDir>/config.json` with `machineOf`
 * (src/deployment.ts); the case runs on that.
 *
 * Left out, as DSH-only:
 * - 'asks DSH to read its settings entry again once a restart it started finished': DSH's settings service and its entry; the
 *   panel is the only settings page here.
 * - 'refuses keys of the previous configuration before registering anything': upstream's DSH plugin configuration before its
 *   Sources; config.json never had those keys (tests/deployment.spec.ts covers the keys it refuses).
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ConfigSchema, configFile, machineOf } from '../src/deployment.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'index-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', () => {
  // Adapted: a person or the panel writes config.json where DSH's loader committed a value in place; a Machine reads the
  // file again on its next use once it changed. Upstream's settings page part is DSH's.
  // A save replaces the file, as the panel's does (src/deployment.ts saveMachineLimits).
  const write = (config: Record<string, unknown>) => { writeFileSync(join(dir, 'next.json'), JSON.stringify(config)); renameSync(join(dir, 'next.json'), configFile(dir)) }
  write({ promptMaxChars: 5000 })
  const machine = machineOf(dir, ConfigSchema.parse({ promptMaxChars: 5000 }))
  expect(machine.promptMaxChars.get()).toBe(5000)
  write({ promptMaxChars: 8000 })
  expect(machine.promptMaxChars.get()).toBe(8000)
})
