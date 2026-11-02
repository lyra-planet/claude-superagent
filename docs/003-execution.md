# 003 Execution

This document follows an accepted Ticket through execution, delivery and recovery. It builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

The domain side of execution is upstream's and unchanged: stages, Reports, retries, restarts, stored work. The Executor is this project's own: it runs each Ticket in a Claude Code Session through the Claude Agent SDK (`src/executor/claude.ts`, `src/app/session.ts`, `src/app/sessions.ts`). `docs/host-probes.md` records how Claude Code behaved where the Executor depends on it, and `docs/design.md` summarizes the host design.

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first matching row wins.

| Stage | Condition | Panel label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a success, a new Assignment or the Ticket's end clears it | Input undelivered |
| person / answer | It has an Attention | Awaiting answer |
| person / review | The latest Report is `ready` | Awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | Blocked · Failed |
| working / queued | No Assignment, or a pending one | Queued |
| idle | The latest Report is `waiting`, or the Assignment ended | Waiting for a Trigger |
| working | Everything else | Working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or `failed` Ticket to its Executor, so it moves to the next matching stage, usually `working`.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

Each Ticket gets one Claude Code Session, the worker, and one directory. The Session's id is a UUID derived from the Ticket's id (`workerSessionId` in `src/executor/common.ts`), so the same Ticket always resumes the same Session. The directory is named after the Ticket's short name: the name the main Session gave it when it accepted, in lowercase kebab-case, followed by the first 12 characters of the Ticket's id. Directories are created under the configured execution root, which defaults to `<stateDir>/work`.

The Session is a `query()` of the Agent SDK in streaming input mode. It opens when the Ticket first needs it, with `sessionId` the first time and `resume` after, and closes whenever a turn ends with nothing left running for it; the next Input opens it again. Each start builds its options afresh (`Sessions.workerStart`):

| Option | Value |
| --- | --- |
| `cwd` | The Ticket's directory |
| `systemPrompt` | Claude Code's own prompt (the `claude_code` preset), with the worker's prompt appended, as 004 Prompts describes |
| `tools` | Claude Code's, less `disallowedTools`: those that ask or show a person something, change the configuration, or start work outside the worker's slot (`WORKER_DENIED` in `src/app/sessions.ts`: questions, plan mode, worktrees, cron and scheduled wake-ups, remote triggers, messages to other Sessions, workflows, artifacts, notebook edits) |
| `mcpServers` | The host's tools, as an in-process MCP server named `superagent`, so the model calls `orchestrator_report` as `mcp__superagent__orchestrator_report` |
| `permissionMode` | `dontAsk`: what is not allowed is denied, never asked. `allowedTools` (`WORKER_ALLOWED`) lists the host's tools, the file tools, web search and fetch, the todo list, subagents and skills, and Bash only when the sandbox is off; with the sandbox on, the sandbox approves sandboxed Bash |
| `sandbox` | From the Execution settings, below |
| `hooks` | One `PreToolUse` hook, below |
| `plugins` | The host's skills as a local plugin under `<stateDir>/plugin`, one directory per prompt revision |
| `settingSources` | `[]`: no settings, hooks, skills or `CLAUDE.md` of the operator's or the repository's are loaded |
| `env` | The service's environment without credential-shaped variables except those Claude Code signs in with, plus the agent's git identity (below) |
| `model` | The Executor model when the Session was made, kept for its life. A model Claude Code does not list, other than a `claude-` id, fails the Session's first start before it is recorded; a Session made before the host recorded models keeps the one its history last used |

The main Session, the router, is one long-lived Session in `<stateDir>/router` (`Sessions.routerStart`). Its only built-in tool is `Skill`; it has the host's main-Session tools, `dontAsk`, no settings of the operator's, and the assembled router prompt as its whole system prompt. It cannot run commands or read code. Its query restarts on the same Session when it is idle and its assembled prompt changed, such as after a prompt or Policy save, so the change applies at its next turn.

### Delivering messages

The host pushes each message into the Session's prompt stream with one of three deliveries (`Delivery` in `src/app/session.ts`):

| Delivery | Agent SDK message | Claude Code takes it | Used for |
| --- | --- | --- | --- |
| `next` | `priority: "next"` | After the running tool call returns, in the same turn, or as a new turn | A worker's Inputs, such as a person's follow-up; the router's candidates and relays |
| `later` | `priority: "later"` | After the running turn ends, as a turn of its own | A worker's Assignment; the message that tells a worker to go on after a passing failure |
| `inject` | `shouldQuery: false` | With the running turn's next step; it starts no turn of its own | The router's notices; the note that tells a worker its background jobs were stopped |

The host never uses `priority: "now"`: it cuts off the running tool call, which may or may not have taken effect. How an `inject` behaves while the Session is idle has not been probed: the host expects it to wait for the next message that starts a turn.

A Session hands over each message once per uuid, which the host derives from what it delivers, and records it in the Session's ledger before it pushes it. The ledger (`session-inbox:<session id>` in the database) keeps what the Session was handed and has not taken, and hands it over again, first and in order, when the query next opens, also after a restart.

**Reads come from replays.** The host starts Claude Code with `replay-user-messages`: when a step takes a pushed message into the Session's history, the query yields it back. The Session then counts it taken and drops it from its ledger, and the Executor marks the Trigger Inputs it carries read (`inputsRead`). Before it sends or starts, the Session also reads the uuids its history already holds (`getSessionMessages`), and reads them again after each query ends, so a message a step took just before a restart counts as taken and is not sent again. A history that cannot be read fails the send, which its effect tries again, unless the Session does not exist yet; replays that arrive while it is read count too.

**A turn ends when Claude Code says the Session is idle.** The host sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, and Claude Code reports each change between running, waiting for an action and idle. Idle with no pushed message waiting is the end of a turn; a message pushed as a turn ends starts the next one instead. The last `result` message says whether the turn succeeded.

### Background work and worker slots

A worker's background tasks are what Claude Code reports in `background_tasks_changed`: shell jobs (`local_bash`, `monitor`) and subagents (`local_agent`).

When a turn ends with background tasks still running, the Ticket keeps its worker slot and stays working. It is not reported as waiting, and the main Session receives no waiting report. A task that finishes wakes the worker: Claude Code starts a new turn by itself, in which the worker reads the task's result, in the same slot. Once a turn ends with nothing running in the background, the Executor reports waiting normally and closes the query.

After each turn, background work has at most 30 minutes to finish (`BACKGROUND_LIMIT_MS`), counted from that turn's end. At that limit, its shell jobs are stopped, the worker is told so with an `inject` message, and the Ticket is reported waiting. The report includes the worker's last words and which jobs were stopped, or that only subagents still run. Subagents are allowed to continue.

A handoff to a person frees the slot immediately and leaves the Report in effect. This applies after a `ready` Report or a question, unless another Input arrived since, and after any `blocked` or `failed` Report.

At handoff, subagents stop; the host waits at most 10 seconds for them, and a delivery waits for that stop. Shell jobs, such as a server offered for review, may continue until the Assignment ends. They hold no slot and are exempt from the 30-minute limit, including after later turns. Unlike on DeepSeek Harness, a job that ends wakes the worker even then: Claude Code starts a turn by itself, which ends as a handoff again unless something new reached the worker.

When an Assignment ends, after its end is committed, the Executor stops all of its background tasks, those left to a person too, and lets go of the messages its Session was handed and did not take. It cuts the running turn short and closes the query, unless the worker's last word was a `ready` or `dropped` Report with nothing delivered since: that worker finishes its own turn. The replacement Assignment and its waiting Inputs start after that stop finishes.

A stop of the service, and the restart that runs setup again after an account change, take the same path for every worker at once: running turns are cut short, keeping what each Session was handed and did not take in its ledger; the effect queue drains; each worker's background tasks stop and its query closes, within 10 seconds (`SHUTDOWN_STOP_MS`). An Assignment interrupted while busy restarts with a recovery note.

Subagents are those the worker starts with Claude Code's `Agent` tool, inside its Session. When they run in the background they count as the worker's background work, as above.

### A person in the worker's Session

A person can take a worker's Session to work in it directly, in Claude Code's own terminal: `claude-superagent open <ticket>`, or `/open` in the interactive terminal (006 Deployment shows both). Two processes may not write one Session, so the Executor holds it first (`ClaudeExecutor.hold`):

1. The worker's turn ends: the hold waits for it, or, with `--now`, cuts it short.
2. The query closes, and its background tasks stop with it.
3. Nothing reaches the worker until the person leaves: launches and deliveries wait, a worker due to go on after a passing failure waits, and the Ticket holds no slot. The hold is stored (`executor-held`), so it outlives a restart.
4. When the person leaves Claude Code, `release` hands the Session back and delivers what waited. The turns the person ran count as their work, not as the worker handing off with the Report it made before.

While the person holds it, Claude Code resumes the Session in the Ticket's directory with the worker's git and `gh`, so the person acts as the agent account there. The host's MCP tools, its hook and its sandbox are options of the service's query and are absent from that Claude Code. `--fork` opens a copy of the Session (`--fork-session`) and holds nothing.

### Preparing a Ticket directory

Before the first Assignment, if the Ticket directory does not exist, the prepare command runs once with `sh -c` in the execution root. It has ten minutes to finish. Without a prepare command, the worker starts in an empty directory. `claude-superagent init --clone <path>` writes a prepare command that adds a `git worktree` of that clone on a branch `agent/<short name>`.

A failed command fails the Ticket and records its output, and the directory it left, if empty, is removed. A retry or a person's message on one of the Ticket's Threads tries preparation again. A pull request belongs to the Ticket when its branch's last path segment matches the Ticket's short name.

After preparation the Executor checks that the directory's own git configuration adds no credential helper or `http.*.extraheader`, which the agent's git would read; a directory that does fails the Ticket.

### Concurrency

A Ticket holds a worker slot from the start of a launch, including preparation, or from the delivery that wakes its idle Executor. It also holds the slot throughout an active turn, and while its background work runs after a turn, as above.

The configured concurrency limit applies to these slots, with one extra slot for a person's message or a status request. Such a wake can use the extra slot when normal slots are full, and takes the next free slot before a new launch. New work therefore cannot prevent a person from continuing an existing Ticket.

Other Inputs, such as CI results, wait for a normal slot. A launch waits in `working / queued` until a slot is free. Launches run concurrently, so a slow prepare command delays only its own Ticket.

### Execution variables

The prepare command and Executor instructions receive the same execution variables. The command reads environment variables; the Executor reads their values and descriptions in its prompt. None contains credentials. The names keep upstream's `DSH_SUPERAGENT_` prefix.

| Variable | Registered by | Value |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET` | Executor | The Ticket's directory, short name and id |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Commands the Executor may not run |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | The repository the Source watches, `owner/name` |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`, `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | The agent account and its commit email |
| `DSH_SUPERAGENT_GITHUB_NUMBER`, `DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | The Issue or pull request that started the Ticket, and its head ref when it is a pull request |
| `DSH_SUPERAGENT_FEISHU_BOT`, `DSH_SUPERAGENT_FEISHU_CHAT` | Feishu | The bot, and the chat that started the Ticket |
| `DSH_SUPERAGENT_LOCAL_CONVERSATION` | Terminal | The terminal conversation that started the Ticket |

Ticket-specific values come from its directory and originating Trigger. Other values come from the current deployment settings. Only the panel can change execution environment settings, which here include the Bash sandbox and its domains; text sent to the main Session cannot change the configured shell command or widen what workers' Bash may do (`src/app/settings.ts`).

Workers reach GitHub through the agent account's `gh` and Feishu through the bot's `lark-cli`: setup writes command shims for them in `<stateDir>/worker-bin`, first on `PATH`, and a git configuration whose credential helper is the agent's `gh`. Blocked commands fail when invoked by name, and the hook below refuses them by name or by path.

## Bash and the host's rules

### The sandbox

The Execution setting `sandbox` decides how workers' Bash runs (`Runtime.shell` in `src/app/runtime.ts`):

| Setting | Bash |
| --- | --- |
| `on` (default) | In Claude Code's sandbox, which on Linux needs `bubblewrap` and `socat`. Writes reach the Ticket directory, the state directory, the command's own temporary directory and, for a worktree, its clone's git directory, which Claude Code allows; the network reaches GitHub (`github.com`, `*.github.com`, `*.githubusercontent.com`) and the domains in `networkDomains` (Execution → other domains the sandbox reaches), nothing else; the Claude Code credentials file (`<claudeConfigDir>/.credentials.json`, and `CLAUDE_SECURESTORAGE_CONFIG_DIR` when set) cannot be read. Sandboxed commands are approved outright and unsandboxed ones are refused. Nothing runs unsandboxed: a missing dependency keeps the worker's query from starting (`failIfUnavailable`), and a sandbox that cannot run fails each command |
| `weak` | The same, with `enableWeakerNestedSandbox`, for containers where bubblewrap cannot mount `/proc`. Files and network stay in; other processes' `/proc` does not: a command sees the machine's processes |
| `off` | As the service's OS user, approved outright |

The sandbox confines what Bash runs. The file tools are Claude Code's own and follow its permission rules: `allowedTools` lists them without a path, and the hook refuses their reads of credential paths; where they may write was not probed. Claude Code itself keeps a clone's `.git/hooks` read-only.

While a sandboxed command runs, the sandbox mounts device files over the shell, git, editor and Claude Code configuration in the working directory (`.bashrc`, `.gitmodules`, `.vscode`, `.claude/settings.json` and others, `SANDBOX_PLACEHOLDERS` in `src/infra/environment.ts`), and `git add -A` fails on them. Sandboxed workers' git therefore reads `<stateDir>/sandbox-gitignore` as `core.excludesFile`, which lists those paths at the repository root.

### git in the worker

Claude Code asks before `git -c …`, `VAR=… git …` and a command that changes directory and runs git, and `dontAsk` denies what it would ask about. So the worker's git gets the agent's identity from the Session's environment: `GIT_CONFIG_COUNT` with `user.name` and `user.email` set to the agent account and its no-reply address (`workerGitVariables` in `src/infra/environment.ts`), which outranks a clone's own configuration. A worker commits with a plain `git commit`, and with `--author` for an author the Delivery requirements name. This holds in every sandbox mode. The same variables carry the sandbox's `core.excludesFile`.

The git configuration setup writes (`<stateDir>/worker-gitconfig`) replaces the operator's global and system git configuration for workers: the agent's `gh` as the github.com credential helper, GitHub SSH addresses rewritten to HTTPS, Git LFS filters, and `user.useConfigOnly`. `GH_TOKEN`, `GITHUB_TOKEN` and the operator's git identity variables are removed, and git never prompts for credentials.

### The hook

Upstream states these rules in prompt text and command shims only. Here one `PreToolUse` hook on every worker (`src/app/hooks.ts`) denies, with a reason the worker reads, in every sandbox mode:

- merging or enabling auto-merge as the agent account: `gh pr merge`, and the GraphQL `mergePullRequest` and `enablePullRequestAutoMerge` mutations;
- GitHub operations outside a worker's work: `gh repo delete|archive|edit|rename`, `gh secret`, `variable`, `ssh-key`, `gpg-key`, `org`, `ruleset`, `release delete`, `cache delete`, `gh auth`, and `gh api -X DELETE`;
- reading credential files (`.credentials.json`, `/secrets/`, `gh_token`, `.config/gh`, `.ssh/id_*`, `.git-credentials`), by shell or by file tool;
- posting to a chat directly with `lark-cli`: replies go through `orchestrator_reply`;
- signalling processes: `kill`, `pkill`, `killall`, `reboot`, `shutdown`, `halt`, `poweroff`;
- the commands the panel blocks, by name or path;
- any tool call once the Ticket has ended.

The hook reads the Ticket and the blocked commands at each call, so a change applies at once. A command line that builds a name another way gets past these checks, so neither the hook nor the sandbox is a boundary against a determined program. Run the service as an OS user that holds only the agent's credentials, and know that a worker's Claude Code process keeps the credentials Claude Code signs in with: its Bash inherits them unless Claude Code scrubs its subprocesses' environment (see Claude Code credentials in 006 Deployment). Whether Claude Code applies the hook to a worker's subagents has not been probed.

### Where Claude Code differs from DeepSeek Harness

- **A finished background job wakes the worker.** DeepSeek Harness collected a job's end and told the worker at its next turn; Claude Code starts a turn by itself. This also holds for jobs left running after a handoff.
- **A person's message cannot reach a worker during a long foreground command.** A `next` message is seen after the running tool call returns. Upstream's worker preset moved a foreground command to the background after 5 seconds, so a follow-up reached the worker at its next step; Claude Code has no such setting, and a follow-up waits until the command ends. The work prompt tells workers to run long commands as background jobs.
- **The router cannot wait.** It has no shell and no job tools, so there is no `sleep` or job wait to guard against.
- **Two processes may not write one Session.** A person who opens a worker's Session holds it, as above, where DeepSeek Harness's UI let a person write into a running Session.

## Merging

Auto-merge is governed by the **Delivery requirements** prompt. The host has no merge-specific decision logic, and refuses outright the merges that would be the agent account's own.

By default, the Executor never enables auto-merge as the agent account: GitHub attributes the merge to whoever enabled it. The hook denies `gh pr merge` and the GraphQL merge mutations, so Delivery requirements must name another account's CLI for merging, under a name other than `gh`. Without one, people merge the pull request.

The default instructions allow auto-merge only for a pull request opened for the Ticket, when it is ready, the required approvals cover the head commit, and additions plus deletions total fewer than 200 lines. Before pushing another revision, the Executor withdraws auto-merge.

Reviews without a body, such as approvals, also arrive as Triggers and can wake an Executor waiting for review. These instructions govern the agent, not GitHub's merge rules. To enforce approvals, require them in branch protection and dismiss stale approvals. Omit the merge CLI or remove the auto-merge paragraph to require manual merging.

## How a Ticket ends

- **Ready without a pull request:** a `ready` Report ends the Ticket as completed.
- **Nothing to do:** an Executor that finds no work for a person to act on, such as a request that does not reproduce or is superseded, reports `dropped`. The Ticket ends without a message, unless a matched rule asks for one, and a later message on its Threads from a person who owns follow-ups resumes it.

### Pull requests

A Ticket follows the pull request it started from once its Executor reports it. It also follows each pull request opened from its branch once reported by the Executor or found by the GitHub Source. Reopened pull requests are followed again.

The Ticket is done when none of the pull requests it opened remain open. If it opened none, all pull requests it follows must be closed. It then ends with the outcome of the last relevant close and keeps its Subscriptions, allowing a later human comment to resume it.

A close does not end the Ticket while resumed, retried or recovered work is unfinished. It also waits if the Executor acknowledged or answered a follow-up it owns but has not since made a non-progress Report or ended a turn after reading that message. A later `ready` Report ends the Ticket once the same pull-request completion rule is satisfied.

Chat Channels, Feishu's and the terminal's, receive one final notice about the pull-request outcome. GitHub already displays the outcome on the pull request itself. Removing a Ticket's Subscription to a pull request also stops it following that pull request.

"Awaiting review" therefore means a `ready` Report with a pull request.

### Follow-ups and context Threads

The Executor decides the follow-ups it owns on its Ticket's own Threads ([002 Authorization](002-authorization.md)). It handles in-scope requests and hands back requests beyond its scope or for another Ticket. Once no Executor owns the message, it becomes a candidate for the main Session. The main Session may otherwise act on the follow-up only to stop work at the person's request.

An Input counts as read after the Session takes it into a step, which Claude Code's replay shows, and subsequently reports or ends a turn. When a Ticket ends, unread messages that were not acknowledged, answered or handed back return to Eval, as described in [002 Authorization](002-authorization.md). Read messages left without action, such as thanks, do not. In Claude Code a message that waits as a turn ends starts the next turn, which takes it, so no delivered message is left untaken at a turn's end.

Threads followed only for context still deliver messages, but do not give the Ticket ownership of human follow-ups or resume ended Tickets. Those messages can be assessed independently.

Sources poll subscribed Threads while a live Ticket subscribes, and for two weeks after the later of the last Trigger and the subscribing Tickets' end. Afterwards, messages arrive only through ordinary intake: GitHub notifications or Feishu live events.

## Failure and recovery

### Executor blocked or failed

When an Executor Session reports `blocked` or `failed`, or fails to start or errors, which records `failed`, the Ticket takes no automatic Input.

A passing failure of the model provider or the network, an HTTP 408, 429 or 5xx, an overloaded or rate-limited model, or a refused, reset or timed-out connection (`transient` in `src/executor/common.ts`), is tried again first, three times with a growing backoff: a launch runs again after 5 seconds, doubling up to 5 minutes, and a worker whose turn failed is told to go on after 15, 30 and 60 seconds, as a `later` message in a slot of its own; a failed prepare command is not tried again.

Once failed, CI and bot messages are recorded on it, but they are not delivered and do not wake the Session.

A person can continue in the Session directly with `claude-superagent open`, as above.

A launch that failed is not tried again on its own.

A person's message, a later Report that is neither `blocked` nor `failed`, or a retry ends the hold.

It is worked out from the stored Reports and Inputs, so a restart keeps it.

### Model budget

Claude Code retries a model request itself and says so (`api_retry`). A retry for billing (`billing_error`, the account out of credit) is a wait on the model's budget: the `models` health entry reports each Session that waits, and the waiting Ticket's card shows it (`model_retry`), until a step answers or the turn ends. Passing failures are not counted there, a rate limit (HTTP 429) included, which Claude Code also reports for a passing throttle.

### Retry

Available while an open Ticket is in `person / delivery`, `person / blocked` or `person / failed`: a new Assignment, which starts its worker again and takes the Inputs that wait, is the remedy for each.

Once a person's message reached a blocked or failed Ticket, the Executor has the message, so the Ticket shows as working, or as queued when a failed launch starts again, and offers no retry, unless delivering that message failed.

A retry ends the current Assignment and starts a new one in the same Executor Session, directory, branch and pull request. The new Assignment's first message says only what is new, unless the Session lost the first one, such as when someone deleted it.

The Executor model applies only when a Session is created; an existing Session keeps its model (`session-model:<session id>`).

### Restart

The service restarts as a new process (`claude-superagent restart`, or a crash and a later `start`), or as a new Runtime in the same process after a settings save that setup must check. Either way, at start, oldest Ticket first:

- Running Assignments end with "host restarted" and new ones start with a recovery note that tells the Executor to check its directory, git history and GitHub before repeating any outside action.
- Assignments that are waiting, ready, blocked or failed stay as they are, unless an Input reached them after that Report, in which case they start again too.
- Pending launches are queued again, unless the Ticket waits for a person.

Sessions, directories, Subscriptions, pending messages and the stored work below survive a restart, and so does what each Executor Session took into its history: a message taken by a turn the restart cut off counts as read once a Report or the end of a turn follows, while one never taken counts as unread. A Session's ledger hands what it was not given in time over again when its query next opens.

A retry or a restart gives the new Assignment again the messages delivered to the Assignment it replaces that its Executor Session did not take. A copy still waiting in the Session's ledger or in its running query is taken out before the new Assignment's first message, so the new delivery is the only copy.

### Stored work

What claude-superagent does after a decision, such as relaying a candidate, a follow-up or a report to the main Session, launching an Assignment or delivering an Input, is stored first and done afterwards.

A relay or a delivery that fails, such as when its Session cannot be reached, is retried after 2 seconds, then after a delay that doubles up to a minute; a launch that fails fails its Ticket, unless the failure was a passing one, as above.

Each kind of work reports an error among the overview's system problems only after one item failed three times in a row; a failed Input delivery shows on its Ticket instead.

Relays to the main Session keep their order, and so do notices; a failed one holds back the later ones of its kind.

### Source failure

The GitHub Source reads each Issue, pull request and Thread on its own: a failed read keeps its error on its Thread, is read again on the next poll, and counts towards an error of the Source, which it reports after three failed polls in a row by default; any successful poll resets the count.

GitHub answers 404 also when the agent lost access to a private repository, so a 404 is retried.

A notified Issue or pull request whose reads keep failing is dropped a day after its first failed read, and at once when GitHub reports it as deleted; it then no longer fails the poll, its Thread keeps the error, and the Source's state names it.

Its read position stays where it was, so a later notification or a poll of its Thread reads what the failed reads missed.

The Feishu event consumer reports every failure, and polling of subscribed topics keeps each failure on its Thread.

A malformed item in a GitHub list or a Feishu page is skipped, and the Source's state counts it.

The terminal Source reads nothing remote: a request arrives with the HTTP call that makes it, and the call fails when the Source is off.

### Channel failure

Outgoing messages are stored and sent as stored work, retried with backoff from 5 seconds, doubling up to 300.

A Ticket's messages to one conversation go out in the order they were queued, so its acknowledgement comes before its later answer or result: a message waits while an earlier one of the same Ticket to the same conversation has not gone out, until that one has failed three times in a row and shows as a problem.

Messages of other Tickets, and messages of no Ticket, do not wait for it.

A message with failed attempts is a system problem until it goes out or is withdrawn.

A message is dropped only when its Source no longer listens to the conversation, or when the Source answers that the conversation can never receive it; while its Source is off, it waits.

The Sources answer that for a deleted Issue or a locked conversation on GitHub, and for a recalled message or one Feishu no longer finds on Feishu. A terminal conversation always receives: its reply goes into the conversation's log.

A reply to a review comment that no longer exists goes to the pull request's conversation instead.

A dropped message keeps its record, with when and why it was dropped and the Ticket it was for, so it is never queued again; a dropped acknowledgement reads as dropped, not sent.

### Pause processing

Stops dispatch, new Evals, Eval timeouts, Input delivery and replies; a launch already under way waits until processing resumes.

Sources keep recording Triggers, and a running Executor turn is not interrupted.

A person's message to an ended Ticket waits: the first pass after the pause resumes the Ticket, if its Mandate holds under the Policy then.

An Eval in progress does not expire during a pause; its deadline moves later by the pause's length.

Processing also holds while setup waits.

### Invalid configuration

A stored Source configuration that its kind rejects disables that Source instance.
