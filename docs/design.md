# Host design

How claude-superagent runs dsh-superagent's domain core on Claude Code. The core (`src/core`, `src/policy.ts`) stays as upstream wrote it, apart from the follow-up change below; this document covers what replaces upstream's DSH-specific layer. It builds on [host-probes.md](host-probes.md). The numbered documents describe the whole system in more detail: [003 Execution](003-execution.md) the Executor, the sandbox and the hook, [006 Deployment](006-deployment.md) operating it, and [007 Architecture](007-architecture.md) the code, with a table of where each part of upstream's host went.

## Process

One Node process per state directory (`src/app/runtime.ts`), holding:

- **Store**: one SQLite file through `node:sqlite`, as upstream. It implements the core's `Repositories` and keeps the effect queue, outbox receipts and settings.
- **Engine**: upstream's. Ports: `Assessor` and `Executor` below, `Outbox` sending through the Sources.
- **Router session**: one long-lived `query()`.
- **Worker sessions**: one `query()` per ticket while it has work, closed when it is idle.
- **Sources**: GitHub and Feishu, ported from upstream behind its `SourceKind`, and the terminal (`src/sources/local.ts`), new.
- **Management server** on `127.0.0.1:<port>`: the panel's API, the terminal's routes, and the built panel.

Every Claude Code process it starts gets `CLAUDE_CONFIG_DIR=<stateDir>/claude` (or `claudeConfigDir`) and `settingSources: []`, so it reads no operator settings, hooks, skills or `CLAUDE.md`, and its sessions live with the deployment's state. The variables a Claude Code session gives its own children are removed, so a service started from inside a session is not part of it.

## Sessions

`ClaudeSession` (`src/app/session.ts`) wraps one `query()` in streaming input mode:

- Its id is fixed and derived from what it serves (`stableUuid('router', stateDir)`, `stableUuid('worker', ticketId)`). It opens with `sessionId` the first time and `resume` after, so a restart keeps the conversation.
- `send(uuid, text, delivery)` hands it a message once per uuid: the Session's history keeps the uuid of every message it took, so a delivery retried after a restart is skipped, and a ledger in the database (`session-inbox:<id>`) keeps what it was handed and did not take, which its next query is handed again.
- Its state follows two Claude Code options the host turns on: `replay-user-messages`, so a message a step takes is yielded back, which counts it taken, and `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, whose idle signal ends a turn. `background_tasks_changed` lists the background tasks that keep it busy. A finished job starts the next turn by itself.

| Delivery | `SDKUserMessage` | Used for |
|---|---|---|
| `next` | `priority: "next"`: seen after the running step, or starts a turn | a person's follow-up, a relay to the router, a retry |
| `later` | `priority: "later"`: after the running turn | a worker's Assignment |
| `inject` | `shouldQuery: false` | notices to the router that need no action |

`priority: "now"` is not used: it cuts off the running tool call, which may or may not have taken effect. How `inject` behaves on an idle Session is not probed yet.

## Router

| Option | Value | Why |
|---|---|---|
| `tools` | `['Skill']` | No built-in tool but `Skill`, which loads the host's and the team's skills, so the router cannot run commands or read code. Upstream keeps `bash` and asks in prose |
| `mcpServers` | the host's `superagent` server | upstream's main-session tools |
| `permissionMode` | `dontAsk`, with `mcp__superagent__*` and `Skill` in `allowedTools` | Anything else is denied without a prompt |
| `systemPrompt` | upstream's router prompt, assembled as upstream does | |

The router restarts, on the same Session, when it is idle and its assembled prompt changed (`stale`), so a prompt or Policy save applies at its next turn. It never waits: there is no shell to `sleep` in.

## Workers

| Option | Value |
|---|---|
| `cwd` | the ticket directory, prepared by the prepare command (`init --clone` writes one that runs `git worktree add`) |
| `tools` | Claude Code's preset; `disallowedTools` removes the interactive ones (questions, plan mode, worktrees, cron) |
| `mcpServers` | `superagent` with upstream's worker tools |
| `permissionMode` | `dontAsk`; `allowedTools` lists the superagent tools, file tools, web, todo, subagents and skills, and Bash only when the sandbox is off; with it on, `Bash(gh:*)` |
| `sandbox` | from the Execution settings, below |
| `hooks.PreToolUse` | the host's rules, below |
| `plugins` | the host's skills (`skills/`), as a local plugin written to `<stateDir>/plugin` |

The executor (`src/executor/claude.ts`) sends an Assignment with `later` and each Input with `next`, and stops a ticket with `interrupt()` and `close()` unless its last word was its result; the core holds automatic Inputs while the ticket waits for a person (`waitsForPerson`). It marks an Input read when Claude Code replays the message that carries it. A worker keeps its slot while background work from its turn runs, for at most 30 minutes from each turn's end; then its shell jobs are stopped and the ticket reports waiting. A worker that handed off to a person frees its slot at once. A transient model error retries the turn with backoff. A person can hold a worker's Session to work in it with `claude-superagent open`.

### Sandbox

| Setting | Bash |
|---|---|
| `on` | Claude Code's sandbox: writes to the ticket directory, the state directory and the clone's git directory (Claude Code allows a worktree's own); network to GitHub (`github.com`, `*.github.com`, `*.githubusercontent.com`) and `networkDomains`; the Claude Code credentials file unreadable |
| `weak` | the same, with `enableWeakerNestedSandbox`, for containers where bubblewrap cannot mount `/proc`: other processes' `/proc` is visible |
| `off` | runs as the service's OS user, approved outright |

`failIfUnavailable` makes a missing sandbox an error instead of unsandboxed Bash. Claude Code itself keeps a clone's `.git/hooks` read-only. The `worktree` and `text` probes and end-to-end runs showed three more things the host has to provide:

- Claude Code asks before `git -c …`, `VAR=… git …` and a command that changes directory and runs git; `dontAsk` denies them. So the worker's git gets the agent's identity through `GIT_CONFIG_COUNT` in the Session's environment, which outranks a clone's own config, and a worker commits with a plain `git commit` (`--author` for an author the Delivery requirements name). This holds in every sandbox mode.
- While a command runs, the sandbox mounts device files over shell, git, editor and Claude Code configuration in the working directory (`.bashrc`, `.gitmodules`, `.vscode`, `.claude/settings.json`, …), and `git add -A` fails on them. Sandboxed, git reads `<stateDir>/sandbox-gitignore` as `core.excludesFile`, which lists them at the repository root.
- Claude Code refuses a sandboxed command whose quoted text holds an `=`, and a `gh api` call that writes (the `text` probe). Sandboxed workers have `Bash(gh:*)` allowed, and hand a command its text in a file in their Ticket's drafts directory (`DSH_SUPERAGENT_DRAFTS`).

## Rules as hooks

Upstream states these only in prompt text and command shims. Here a `PreToolUse` hook (`src/app/hooks.ts`) denies them, with a reason the worker reads, in every sandbox mode:

- merging or enabling auto-merge as the agent account (`gh pr merge`, the GraphQL `mergePullRequest` and `enablePullRequestAutoMerge` mutations)
- deleting or reconfiguring anything on GitHub (`gh repo delete|archive|edit|rename`, secrets, variables, keys, rulesets, `gh api -X DELETE`), and `gh auth`
- reading credential files, by shell or by file tool
- posting to a chat directly: replies go through `reply`
- signalling processes (`kill`, `pkill`, `killall`, shutdown)
- the commands the panel blocks, by name or path
- any tool call once the ticket has ended

The prompt still explains each rule; the hook makes it hold when the prompt does not. A command line that builds a name another way gets past the name checks, so the hook is not a boundary against a determined program: run the service as an OS user that holds only the agent's credentials.

## Follow-ups from people outside the allowed list

Upstream delivers every person's message on a ticket's thread to its worker as a follow-up the worker owns, whoever sent it, and such a message resumes an ended ticket. On a public repository that lets anyone who can comment drive a worker that runs commands.

The core's one change from upstream: `Policy.owns(trigger)` (`src/policy.ts`) says whether a person may decide a ticket's follow-ups: someone on the Source's allowed list, or a sender the admission table makes explicit for that scope. `Intake.receive` (`src/core/intake.ts`) delivers anyone else's message to subscribed tickets as context: the worker reads it, does not own it, it resumes nothing, and it goes to Eval like any message no ticket owns. The upstream tests that assumed the old behaviour changed with it.

## The terminal Source

`claude-superagent ask` posts to `/local/messages`; each conversation is a Thread, and the operator named at `init` is on its allowed list, so a request is an explicit candidate. Replies are stored per conversation and read with `inbox` or `ask --wait`. A follow-up on the conversation goes to its ticket's worker like a GitHub comment does.

## Management server

It listens on 127.0.0.1 only. A request is answered when its Host is the loopback port or in `allowedHosts` (a gateway that serves the panel under a path); any other Host gets a 403 that names it, so a page that a DNS rebinding points at the port is refused. The API and the terminal's routes also need the panel's `x-orchestrator-request` header and a matching Origin, as upstream's did.

## End-to-end runs

On a private test repository, through the terminal Source and GitHub, with the sandbox off:

- a request is acknowledged, worked in a worktree, pushed and opened as a pull request, bound to the ticket, and answered in the conversation
- a follow-up reaches the same worker without a new Decision, which pushes a second commit
- a person merging the pull request ends the ticket, and the conversation hears so
- after a restart mid-Assignment, the worker is told it was interrupted, checks its state and finishes without repeating work
- asked to merge its own pull request, the worker declines and says a person must

With the weaker sandbox, in a container that cannot mount `/proc`, a follow-up on that pull request: the worker commits with a plain `git commit` as the agent account, pushes, and reads the pull request with `gh`, through the sandbox's proxy. Before the host set git's identity and the ignore file, the same follow-up failed at `git -c … commit`, and the worker asked a person for permission.
