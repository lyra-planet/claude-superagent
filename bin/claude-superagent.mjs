#!/usr/bin/env -S node --experimental-transform-types --no-warnings
// The source runs as it is: Node strips its types, so there is no build step for the service.
await import('../src/cli.ts')
