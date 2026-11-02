# 006 Deployment

Use this guide to install, configure and operate claude-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

The examples write `claude-superagent`; from the checkout, that is `./bin/claude-superagent.mjs`. Every command takes `--state <dir>` (or `CLAUDE_SUPERAGENT_STATE`) for the state directory, `~/.claude-superagent` by default.

## What runs

- **One Node process per state directory**, `claude-superagent start`. It holds the database, the router's and the workers' Claude Code Sessions (through the Claude Agent SDK, which bundles Claude Code), the Sources' loops, and a management server on `127.0.0.1:<port>` that serves the panel, its API and the terminal's routes.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Claude Code credentials** for the Sessions.
- **Optional:** a Feishu bot for chat requests.

`<stateDir>/config.json` holds the machine configuration. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories, commands and the sandbox.

### Permissions and isolation

Every Claude Code process the service starts runs with `CLAUDE_CONFIG_DIR` set to the deployment's Claude Code configuration directory (`<stateDir>/claude` by default) and `settingSources: []`: it reads no settings, hooks, skills or `CLAUDE.md` of yours, and its Sessions live with the deployment's state. The variables a running Claude Code session gives its children are removed, so a service started from inside a Claude Code session is not part of it.

Workers run in `dontAsk` mode: what is not allowed is denied, never asked. Their Bash runs in Claude Code's sandbox (`on`), its weaker mode for containers that cannot mount `/proc` (`weak`), or as the service's OS user (`off`), and a `PreToolUse` hook refuses merges as the agent, destructive GitHub operations, credential reads, direct chat posts, process signals and blocked commands in every mode ([003 Execution](003-execution.md)).

Account wrappers choose the agent's credentials by default; they do not isolate the process. Neither the hook nor the sandbox is a boundary against a determined program, and a worker's commands see the service's environment, less credential-shaped variables other than Claude Code's own. For isolation, run the service as a dedicated OS account that holds only the agent's credentials.

## Prerequisites

- Node.js 22.19 or later: the service runs its TypeScript directly, with no build step.
- git 2.32 or later. Install `git-lfs` if the repository uses Git LFS.
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees.
- For the sandbox (`on` or `weak`): `bubblewrap` and `socat` on `PATH`.
- For Feishu: `lark-cli` (upstream tested 1.0.90) and a Feishu or Lark app with a bot.

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because claude-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. claude-superagent reads the login the same way.

### Claude Code credentials

The Sessions need a model provider, set in the service's environment: `ANTHROPIC_API_KEY`, or a cloud provider's variables. Anything that serves a team needs an API key or a cloud provider: Anthropic does not allow third-party products to offer claude.ai login or its rate limits. A claude.ai login is for your own use only, and since the Sessions use the deployment's own `CLAUDE_CONFIG_DIR`, a login in your `~/.claude` does not reach them.

A worker's Claude Code process keeps the credentials Claude Code signs in with (`CLAUDE_CREDENTIALS` in `src/infra/environment.ts`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, the AWS and Foundry keys), while every other variable whose name contains KEY, PASSWORD, SECRET or TOKEN is removed. Its Bash inherits those credentials. Claude Code can scrub its subprocesses' environment (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, which needs bubblewrap); the host neither sets it nor tests it, so read Claude Code's documentation before relying on it.

Sandboxed Bash cannot read the Claude Code credentials file in the configuration directory.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-claude-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-claude-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-claude-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.
3. `init` writes the Feishu Source off. Set the bot CLI, for example `/home/me/.local/bin/lark-bot`, and the chats on the Feishu card, then switch it on.

## Install

```sh
git clone <this repository> claude-superagent && cd claude-superagent
npm install --legacy-peer-deps      # npm 10.9 fails on this tree's peer dependencies without it
```

`npm install` also builds the panel (`lib/panel`) and the interactive terminal (`lib/tui.mjs`) through the package's `prepare` script; `npm run build` builds both again. The service itself needs no build.

## Set up

```sh
git clone https://github.com/acme/widgets ~/src/widgets     # the clone each Ticket's worktree comes from
claude-superagent init --repo acme/widgets --gh ~/.local/bin/gh-agent --clone ~/src/widgets --operator alice --sandbox on
```

`init` creates the state directory with `config.json` and the database, and refuses a directory that already has a database:

| Flag | Writes |
| --- | --- |
| `--repo <owner/name>` (required) | The GitHub Source's repository |
| `--gh <cli>` (required) | The GitHub Source's CLI: `gh`, or a wrapper signed in as the agent account |
| `--clone <path>` | A prepare command that fetches the Ticket's source ref from GitHub into the clone and adds a worktree of it on a branch `agent/<short name>`; without it, each Ticket starts in an empty directory |
| `--operator <name>` | The terminal Source's operator name, also its allowed list (`operator` by default) |
| `--port <n>` | `port` in `config.json` (3082 by default) |
| `--allow-host <host>` | `allowedHosts` in `config.json`; repeatable |
| `--sandbox on\|weak\|off` | The workers' Bash sandbox (`on` by default) |
| `--mode off\|observe\|auto` | The accept mode (`observe` by default) |

It writes the GitHub and terminal Sources on and the Feishu Source off. The GitHub allowed list starts empty: until you add someone in the panel, only the terminal's operator can ask for work.

## Machine configuration

`<stateDir>/config.json` holds what upstream's DeepSeek Harness profile held (`ConfigSchema` in `src/deployment.ts`). Unknown keys and invalid values stop every command that reads the file, with the key named.

| Key | Default | Meaning | Applies |
| --- | --- | --- | --- |
| `port` | 3082 | The loopback port of the panel, its API and the terminal's routes | At a restart |
| `allowedHosts` | `[]` | Host headers the server answers besides `127.0.0.1:<port>` and `localhost:<port>`, such as a gateway's | At a restart |
| `claudeConfigDir` | `""` | Claude Code's configuration directory for every Session; empty for `<stateDir>/claude` | At a restart |
| `promptMaxChars` | 100000 | The largest saved prompt configuration | At its next use |
| `admissionContextMaxPages` | 10 | How many Thread pages one assessment reads | At its next use |
| `admissionContextTimeoutMs` | 15000 | How long one assessment's Thread reads may take | At its next use |

The three limits are read from the file whenever it changed, so an edit by hand or a save in **Settings → Deployment** applies without a restart; a file that does not parse keeps the last values read.

The state directory also holds, all written by the service:

| Path | Holds |
| --- | --- |
| `orchestrator.sqlite` | The database. Back it up before upgrades |
| `claude/` | Claude Code's configuration and the Sessions' histories, unless `claudeConfigDir` names another directory |
| `router/` | The router Session's working directory |
| `work/` | The Ticket directories, unless the Execution settings name another root |
| `plugin/r<revision>/` | The host's skills as a Claude Code plugin, for the latest five prompt revisions |
| `worker-bin/`, `worker-gitconfig`, `sandbox-gitignore` | The workers' command shims, git configuration and the sandbox's git ignore file |
| `service.pid`, `stopped`, `logs/` | The background service's pid, a person's stop mark, and its logs |

A lock beside the directory, `<stateDir>.lock`, keeps a second process from opening the same state.

## Start and stop

```sh
claude-superagent start --detach
claude-superagent status
```

| Command | Does |
| --- | --- |
| `start` | Runs the service in the foreground; Ctrl-C or SIGTERM stops it. Refuses a state directory a running service holds |
| `start --detach` | Runs it in the background with a new log, waits up to a minute until it answers, and prints its pid, the panel's address and the log. Clears a person's stop mark |
| `stop` | Writes the stop mark, sends SIGTERM to the process the pid file names, only when its command line is the service's, and waits up to five minutes for it to stop the workers and exit |
| `restart` | `stop` without the mark, then `start --detach` |
| `status` | Prints the pid, the setup problem, the accounts, whether processing is paused, the Executor load and each part that reports an error, as JSON; exits with the code below |
| `check` | Starts the service in the background unless it runs, then exits as `status`; with `--respect-stop`, leaves a service a person stopped stopped, says so and exits 0 |
| `logs` | Prints the newest log; `-f` follows it. Only `--detach` writes logs |

`status` and `check` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run or does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and the setup problem under `setup`. Only an intentional `stop` pauses automatic recovery: a scheduled `check --respect-stop` leaves the service stopped until `start --detach` clears the mark. A foreground `start` does not clear it.

Logs are `<stateDir>/logs/service-<time>.log`; the newest 20 are kept.

### Scheduled check

Run `check --respect-stop` every hour from cron or a systemd timer, outside the service, so it keeps running when the service is down:

```sh
0 * * * * $HOME/.local/bin/claude-superagent-check
```

where `claude-superagent-check` is a script of yours that sets the environment the service needs and runs `/path/to/claude-superagent/bin/claude-superagent.mjs check --respect-stop`. A service that `check` starts inherits that environment, and cron's is minimal: set `PATH` so it finds `node`, `git`, the `gh` wrapper, `bubblewrap` and `socat`, and the Claude Code credentials. Exit 0 also covers a service a person stopped. Exit 2 and 3 need a person: read `status`. Exit 1 means the service did not come up: read the newest log and the Troubleshooting table below.

## The terminal

`claude-superagent` without a command, in a terminal, opens the interactive terminal (`src/tui/`). It offers to start the service in the background when it does not run, opens on the latest conversation, and shows the agent's replies, its Tickets' changes and what their workers do, live. A line without `/` goes to the agent in the current conversation, as `ask` does.

| Command | Does |
| --- | --- |
| `/new`, `/threads`, `/thread <n\|id>` | Start a conversation, list them, switch to one |
| `/tickets` | List the Tickets by number |
| `/open <ticket> [now]`, `/fork <ticket>` | Open a Ticket's worker Session in Claude Code, as `open` below |
| `/stop <ticket>`, `/retry <ticket>` | Stop or retry a Ticket, as the panel does |
| `/activity` | Show or hide what the workers do |
| `/status`, `/panel` | The service's health and load; the panel's address |
| `/pause`, `/resume` | Pause or resume processing |
| `/help`, `/quit`, `/shutdown` | The commands; leave the terminal, the service going on; stop the service and leave |

The same work without the interactive terminal:

| Command | Does |
| --- | --- |
| `ask <text>` | Hands the agent a request in a new conversation; `--thread <id>` continues one, `--wait` prints the replies until the first one after the acknowledgement, for at most an hour |
| `inbox [<id>]` | Lists the conversations, or prints one |
| `tickets` | Lists the Tickets with their stage and pull request |
| `open <ticket>` | Opens the Ticket's worker Session in Claude Code, in this terminal: the service holds the Session once the worker's turn ends (`--now` cuts the turn short), Claude Code resumes it in the Ticket's directory with the worker's git and `gh`, and when you leave, the worker has it again. `--fork` opens a copy and holds nothing |

`open` runs the Claude Code that the Agent SDK bundles, so it reads the same Session format; `CLAUDE_SUPERAGENT_CLAUDE` names another. It uses the deployment's Claude Code configuration directory and marks its onboarding done; whether to trust the Ticket's folder stays your answer. While you work there, you act as the agent account, without the host's tools, hook or sandbox.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change that setup reads runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** `init` set the GitHub repository and the agent CLI. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages. The Terminal card holds the operator's name.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request from that Source can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root, the prepare command (`init --clone` writes one), the sandbox and the domains it reaches, such as a package registry the tests need. To give each Ticket a checkout of the repository by hand:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author, the merge CLI and the auto-merge condition.

### From another machine

The service listens on `127.0.0.1` only. To open the panel from another machine, forward the port (`ssh -L 3082:127.0.0.1:3082 <host>`), or put it behind a gateway that serves it under a path, such as code-server's `/proxy/3082/`, and allow the Host the gateway forwards: `init --allow-host <host>`, or `allowedHosts` in `config.json` and a restart.

A request for any other Host gets a 403 that names the Host and says to add it to `allowedHosts`, and the log says the same once per Host. This refuses a page that a DNS rebinding points at the port. The page redirects itself to an address that ends in a slash, so its relative addresses stay under the gateway's path.

### Management API

The panel, the command line and the interactive terminal use a local HTTP API that agents can also call.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The Host must be `127.0.0.1:<port>`, `localhost:<port>` or one of `allowedHosts`, and an `Origin`, when sent, must be that Host's. Other requests receive 403. The API answers once the service has started or found what setup still needs.

API saves have the panel's permissions. They can change the execution environment, the sandbox and setup account fields, unlike saves made through the main Session's tools.

Every route, typed in `src/app/api.ts`:

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup` (the `machine` limits, `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them); `health`, an entry per part with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the workers `running`, the Tickets `queued` and `maxWorkers`; `paused`; `masterId` |
| `GET overview` | The overview: Tickets that need a person, problems, the last day's flow and the Executor's load |
| `GET search?q=` | Triggers, Threads and Tickets the query finds |
| `GET sources` | Each Source's status: `state`, the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` and the messages it `dropped` in that day |
| `GET settings` | `blocks` (`policy`, `eval`, `executor`, each with `value` and `revision`), `sources` (each with `id`, `kind`, its block's `value`, `revision`, its kind's form and its setup `problem`), `policyVersion`, and the execution `environment` |
| `PUT settings/<block>` with `{"value", "revision"}` | Saves `policy`, `eval`, `executor` or `source:<id>`: `saved`, the block's new `revision`, `policy_changed`, `restarting` and `context_delivery`. `value` is the whole block; a missing key takes its default |
| `POST sources/<id>/labels` | Reads the Source's display names again: `added` |
| `GET threads?filter=&offset=&limit=`, `GET threads/<key>` | Thread lists (`subscribed`, `evaluating`, `recent`, `all`), and one Thread's timeline, Decisions and Subscriptions |
| `POST threads/<key>/unsubscribe` | Drops every Subscription on the Thread |
| `POST triggers/<id>/requeue` | Queues a stored Trigger for a fresh Eval: `queued` |
| `GET decisions?kind=&window=24h`, `POST decisions/<id>/dismiss` | The Decision list; dismisses an unavailable Decision's problem |
| `GET tickets?state=`, `GET tickets/<id>` | Ticket lists (`open`, `person`, `working`, `idle`, `ended`), and one Ticket's page with its execution environment |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `GET policy/history` | Each saved settings revision with what it changed |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `POST setup/check` | Runs setup again by restarting the Runtime: `restarting: true`. Refused when setup has nothing to fix |
| `PUT deployment` with the three limits | Writes them into `config.json`: the limits and `stateDir` |
| `GET models` | The models Claude Code lists for the credentials in use |
| `GET prompts?revision=&offset=`, `PUT prompts` with `{"config", "baseRevision"}`, `POST prompts/preview` | Reads the prompt configuration (`current`, `defaults`, `sections`, `skillName`, `builtin`, `skillPrefix`, `parts`, `defaultChanged`, the Sessions' revisions and the history), saves it (`revision`), or composes a configuration without saving it |

The terminal's routes, under `/local/`, take the same header and Host checks (`src/sources/local.ts`, and `Runtime.terminal` in `src/app/runtime.ts`):

| Request | Answer |
| --- | --- |
| `POST /local/messages` with `{"text", "conversation"?}` | Hands the agent a request from the operator, in a new conversation unless one is named: `conversation`, `trigger_id` and `received` (`stored`, `duplicate` or `filtered`). 409 while the terminal Source is off |
| `GET /local/conversations`, `GET /local/conversations/<id>?after=<n>` | The conversations; one conversation's messages after position `n`, and `next` |
| `GET /local/events` | Server-sent events: each new message of a conversation, each committed change of a Ticket, and what the Sessions do |
| `GET /local/tickets`, `GET /local/tickets/<id>/activity?limit=` | The Tickets as the terminal lists them; the last lines of what a worker did, read from its Session's history |
| `GET /local/tickets/<id>/session` | Where the worker's Session is: `sessionId`, `cwd`, `claudeConfigDir`, `working`, `held`, and the environment that gives Claude Code the worker's git and `gh` |
| `POST /local/tickets/<id>/hold` with `{"now"?}`, `POST /local/tickets/<id>/release` | Hands the worker's Session to a person, once its turn ended or at once with `now`, and answers as `session` with the number of background tasks `stopped`; hands it back |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on the model's budget: Claude Code retrying a request the provider refused for billing |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Worker Session event handling; appears after its first failure |
| `github`, `feishu`, `history`, `local` | Source polling, events, history recovery and the terminal Source |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large (128 KiB; prompt saves scale with `promptMaxChars`).
- 403: a Host, header or Origin the server does not accept.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`: `{"enabled": true, "config": {…}}` with `repository` and `cli`, the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI, and `pollSeconds` and `failuresBeforeError`.
- `source:feishu`: `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, `otherChats` as `"none"` or `"mentions"`, and `readPageSize` and `linkTimeoutMs`.
- `source:local`: `operator`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}, "local": {"allowed": [{"id": "alice"}]}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, by `issues`, `pulls`, `comments` or `ci` for GitHub, and `terminal` for the terminal; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`, also the main Session's model.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare`, `blockedCommands`, `sandbox` (`on`, `weak` or `off`) and `networkDomains`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

A model is `{"provider": "claude-code", "model": "<id>"}`, as `GET models` lists them, or `null` for Claude Code's default; an optional `reasoningEffort` of `low`, `medium`, `high`, `xhigh` or `max` becomes the Session's effort. A save refuses a model that Claude Code does not list, unless its id starts with `claude-`. A Session keeps the model it was made with; a new Session's first start makes the same check and fails on a model that does not pass it.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is unavailable while the Runtime restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup runs the account CLIs as worker shells run them: through Node's `child_process`, with the shim directory removed from `PATH` and every variable whose name contains KEY, PASSWORD, SECRET or TOKEN removed.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed. The commit identity comes from each worker Session's environment instead ([003 Execution](003-execution.md)).
- **The sandbox's git ignore file**, `<stateDir>/sandbox-gitignore`.

A file in `worker-bin`, `worker-gitconfig` or `sandbox-gitignore` that claude-superagent did not write stops setup; files upstream's dsh-superagent wrote are taken over. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From the terminal:

```sh
claude-superagent ask --wait "README.md has a typo: 'recieve' should be 'receive'. Please fix it and open a pull request."
```

The agent acknowledges the request, works in its own Session and directory, and answers in the conversation, here with a pull request. From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`: within a polling interval (one minute by default), Overview shows a Ticket. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no worker is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`, and the Claude Code configuration directory (`<stateDir>/claude` by default), which holds the Sessions the database refers to.
3. Run `git pull && npm install --legacy-peer-deps`.
4. Run `claude-superagent restart` and inspect `status`.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

The database has upstream's schema 11, and there is no migration yet: a database of any other schema refuses to open, and the file is left as it was. A database from upstream's schema 10 cannot be upgraded here. Rollback therefore requires the pre-upgrade backup once a later version changes the schema.

An upgrade can change the Agent SDK and the Claude Code it bundles; `open` runs the new bundled Claude Code as well.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log, `status` and the API show the English text below (`src/setup.ts`).

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account.` | Sign the wrapper in with `auth login` |
| `The agent GitHub CLI did not report a GitHub account.` | The CLI printed something other than a GitHub user; run `<cli> api user` by hand |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The agent GitHub CLI did not return …` | The repository answer was not what `gh api` prints; check the repository name and the CLI |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| `git does not read the github.com credential configuration claude-superagent writes` | Install git 2.32 or later |
| `… was not written by claude-superagent` | Move the named file out of `<stateDir>/worker-bin`, `worker-gitconfig` or `sandbox-gitignore`, or choose another state directory |
| `Preparing the agent environment failed.` | The output names the cause, such as a state directory the service cannot write |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.`, `auth status of the bot lark-cli did not report the app.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot API did not return the bot's open_id.` | Check that the app has the bot capability and a published version |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| A worker fails with `Sandbox required but unavailable … socat not installed`, or names bubblewrap | Install `bubblewrap` and `socat` on the service's `PATH`, or set the sandbox to `off` |
| Every sandboxed command fails with `bwrap: Can't mount proc on /newroot/proc: Operation not permitted` | The container cannot mount `/proc`: set the sandbox to `weak` |
| A worker reports that it needs permission for `git -c …`, `VAR=… git …` or `cd … && git …` | `dontAsk` denies what Claude Code would ask about. The host already gives git the agent's identity; a prompt that tells the worker to run such a command needs rewording into a plain `git` command in the working directory |
| A sandboxed command cannot reach a host | Add its domain under Execution → other domains the sandbox reaches; GitHub's are always reached |
| A browser or gateway gets `claude-superagent does not answer for Host "…"` | Add that Host to `allowedHosts` in `config.json` and restart |
| `/` answers that the panel is not built | Run `npm run build` in the checkout, then restart: the service looks for the build as it starts |
| `The terminal is not built` | Run `npm run build` in the checkout |
| `No state directory at …: run claude-superagent init first` | Run `init`, or pass the right `--state` |
| `… is set up already; change its settings in the panel` | `init` runs once per state directory |
| `claude-superagent runs already on … (pid …)` | Use the running service, or `stop` it first |
| `start --detach` says the service exited as it started, or did not answer within 60 seconds | Read the log it names |
| `Unsupported database schema …` | The database comes from another version; restore the backup of this version's database |
| A command fails naming a key of `config.json` | Remove the key or fix its value; the table under Machine configuration lists them |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, does not answer, or its runtime reports an error; the output and the newest log say which |
| `models` reports a Session waiting on the model's budget | The account of the credentials in use is out of credit; add credit, and the Session goes on once Claude Code's retry succeeds |
| A Ticket fails, or relays to the main Session keep failing, with `Claude Code lists no model …` | A new Session's model is one Claude Code does not list for the credentials in use; choose one from the list in the Execution or Eval settings |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the service's user to see its own message |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
