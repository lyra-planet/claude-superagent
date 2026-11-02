import { defineConfig } from 'vitest/config'

// Panel tests opt into jsdom per file with `// @vitest-environment jsdom`.
export default defineConfig({ test: { include: ['tests/**/*.spec.{ts,tsx}'] } })
