/** Commands a worker always needs, which `blockedCommands` cannot block. Upstream kept this in `src/infra/environment.ts` beside its DSH shims. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
