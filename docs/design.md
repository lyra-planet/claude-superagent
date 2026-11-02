# Host design

How claude-superagent runs dsh-superagent's domain core on Claude Code. The core (`src/core`, `src/policy.ts`) stays as upstream wrote it, apart from the follow-up change below; this document covers what replaces upstream's DSH-specific layer. It builds on [host-probes.md](host-probes.md).

## Process

One Node process per deployment, started by a service script, holding:

- **Store**: one SQLite file through `node:sqlite`, as upstream. It implements the core's `Repositories` and keeps the effect queue, outbox receipts and settings.
- **Engine**: upstream's, unchanged. Ports: `Assessor` and `Executor` below, `Outbox` sending through the Sources.
- **Router session**: one long-lived `query()`.
- **Worker sessions**: one `query()` per running Assignment.
- **Sources**: GitHub first, as plugins behind upstream's `SourceKind`.

Every Claude Code process it starts gets `CLAUDE_CONFIG_DIR=<stateDir>/claude` and `settingSources: []`, so it reads no operator settings, hooks, skills or `CLAUDE.md`, and its sessions live with the deployment's state. Credentials come from `ANTHROPIC_API_KEY` or a cloud provider.

## Router

| Option | Value | Why |
|---|---|---|
| `tools` | `[]` | No built-in tool at all, so the router cannot run commands or read code. Upstream keeps `bash` and asks in prose |
| `mcpServers` | the host's `superagent` server | `route`, `eval`, `eval_read`, `eval_decide`, `reply`, `read`, `ticket_retry`, `ticket_status`, `ticket_note`, `thread_unsubscribe` |
| `permissionMode` | `dontAsk`, with those tools in `allowedTools` | Anything else is denied without a prompt |
| `systemPrompt` | upstream's router prompt, assembled as upstream does | |
| `resume` | the stored router session id | Survives restarts |

Input reaches the router through its streaming input:

| Message | `SDKUserMessage` |
|---|---|
| A candidate, a worker's report or question, a person's follow-up | `priority: "next"`: seen after the router's running step |
| A notice that needs no action (ticket ended, settings saved) | `shouldQuery: false`, to be confirmed on an idle session before relying on it |

The router never waits: there is no shell to `sleep` in.

## Workers

| Option | Value |
|---|---|
| `cwd` | the ticket directory, prepared as upstream does (`git worktree add`) |
| `tools` | Claude Code's preset |
| `mcpServers` | `superagent` with `ack`, `report`, `thread_unrelated`, `thread_follow`, `trigger_handback`, `read` |
| `permissionMode` | `dontAsk`; `allowedTools` lists the superagent tools and file edits inside `cwd` |
| `sandbox` | `enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`; `enableWeakerNestedSandbox` only where the default cannot start; `filesystem.denyRead` and `credentials.files` cover the operator's credential files |
| `hooks.PreToolUse` | the host's rules, below |
| `resume` | the ticket's worker session id, so a retry or a restart keeps the session |

Delivery of a ticket's Inputs, by the core's kinds:

| Input | `SDKUserMessage` |
|---|---|
| A person's message, a resume, a status request | `priority: "next"` |
| CI, a bot, a Policy change, a router note | `priority: "next"` while the worker runs; held while it waits for a person, as upstream's `waitsForPerson` does |
| Stopping the ticket | not a message: `interrupt()`, then `close()` |

`priority: "now"` is not used for input: it cuts off the running tool call, which may or may not have taken effect.

Turn and background state come from the SDK's messages: a `result` message is `Engine.turnEnded`; `task_started`, `task_notification` and `background_tasks_changed` keep the worker's slot while a background job runs. A finished job starts the worker's next turn by itself.

## Rules as hooks

Upstream states these only in prompt text. Here a `PreToolUse` hook denies them, with a reason the worker sees:

- merging or enabling auto-merge as the agent account (`gh pr merge`, the GraphQL `mergePullRequest` and `enablePullRequestAutoMerge` mutations), unless Delivery requirements names another account's CLI for it
- `gh auth`, and reading the operator's credential files
- posting to a chat directly: replies go through `reply`
- any tool call once the ticket has ended

The prompt still explains each rule; the hook makes it hold when the prompt does not.

## Follow-ups from people outside the allowed list

Upstream delivers every person's message on a ticket's thread to its worker as a follow-up the worker owns, whoever sent it, and such a message resumes an ended ticket. On a public repository that lets anyone who can comment drive a worker that runs commands.

Change in `Intake.receive` (`src/core/intake.ts`), the core's one change from upstream:

- A message from a sender the Source's Policy part does not list reaches subscribed tickets as context (`context: true`), as messages on a context-only thread do: the worker reads it, does not own it, and it resumes nothing.
- It goes to Eval like any message no ticket owns, where the gate already treats it as an inferred candidate in `observe` and `auto` mode.
- A sender the admission table makes explicit for that scope keeps today's behaviour.

The upstream tests that assume today's behaviour change with it, each named in the commit.

## Build order

1. Store and effect queue on `node:sqlite`, with upstream's store tests
2. Worker executor on the SDK: launch, deliver, stop, resume, slots; tested with a stub `query`
3. Router session and the `superagent` tools
4. GitHub Source, ported from upstream
5. Follow-up admission change
6. Hooks
7. Service script and a first end-to-end run on a test repository
