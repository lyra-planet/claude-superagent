# claude-superagent

DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) design, rebuilt on Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

> Unofficial. Not made, endorsed or supported by Anthropic or DeepSeek. Not related to SuperClaude. A research prototype: read the code and the rules below before you point it at a repository your team uses.

## What it is

An always-on agent for one GitHub repository. Someone allowed asks it for work; it confirms once, works in a Claude Code session and a git worktree of its own, and answers in the same conversation, usually with a pull request. It stays quiet while it works and speaks when a person must act or can use a result.

It keeps dsh-superagent's shape and its domain core unchanged:

- **One router, many workers.** A long-lived router session routes requests. Each accepted request becomes a ticket with its own worker session and directory.
- **Code gates, the model judges.** Who may ask for work is decided by code (allowed lists, an admission table, an accept mode). Whether a message asks for work is judged by the model.
- **Follow-ups skip the router.** Once a ticket exists, later messages on its conversation or pull request go straight to its worker.
- **Durable.** Side effects are recorded before they run and ids derive from their inputs, so a restart resumes where it stopped.

Requests come from three Sources: the **terminal** (`claude-superagent ask`), **GitHub** (mentions of the agent account, and the agent's own pull requests: CI, reviews, merge and close), and optionally **Feishu**.

## What it does differently from upstream

| | dsh-superagent | claude-superagent |
|---|---|---|
| Host | DeepSeek Harness | Claude Code, through the Agent SDK |
| Router | has `bash`; "don't do the work" is prompt text | no built-in tool at all (`tools: []`) |
| Rules such as "never merge your own PR" | prompt text and command shims | also a `PreToolUse` hook the worker cannot get past |
| Shell isolation | none (`danger-full-access`) | Claude Code's Bash sandbox, `on`, `weak` or `off` |
| Asking for work without a second account | no | the terminal Source |

[docs/host-probes.md](docs/host-probes.md) shows how the Agent SDK behaves where the host depends on it; [docs/design.md](docs/design.md) maps upstream's host onto it.

## Requirements

- Node.js 22.19 or later (the service runs its TypeScript directly), git 2.32 or later
- The GitHub CLI `gh` 2.48 or later, and a GitHub account for the agent with write access to the repository. `gh` runs as that account through a wrapper (below)
- Claude Code credentials: an `ANTHROPIC_API_KEY` (or a cloud provider) for anything that serves a team. Anthropic does not allow third-party products to offer claude.ai login or its rate limits ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)); a personal login is for your own use only
- For the sandbox: `bubblewrap` and `socat` on PATH

## Install

```sh
git clone https://github.com/lyra-planet/claude-superagent && cd claude-superagent
npm install --legacy-peer-deps      # npm 10.9 crashes on this tree's peer dependencies without it
npm run build:panel                 # the web panel; the service runs without it
```

Give `gh` the agent's account only, in a wrapper the service calls:

```sh
cat > ~/.local/bin/gh-agent <<'EOF'
#!/bin/sh
GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
EOF
chmod +x ~/.local/bin/gh-agent
gh-agent auth login          # sign in as the agent account
gh-agent api user --jq .login
```

## Set up and run

```sh
git clone https://github.com/acme/widgets ~/src/widgets     # the checkout each ticket's worktree comes from

./bin/claude-superagent.mjs init --repo acme/widgets --gh ~/.local/bin/gh-agent \
  --clone ~/src/widgets --operator alice --sandbox on
./bin/claude-superagent.mjs start          # foreground; Ctrl-C stops it. Run it under tmux or systemd to keep it
```

`init` writes `~/.claude-superagent` (or `--state <dir>`): `config.json` with the port (3082) and the database with the settings. Everything else is a setting in the panel at `http://127.0.0.1:3082/`: Sources, who may ask, proactive rules, the prepare command, the worker model and concurrency, prompts.

Hand it work from the terminal:

```sh
./bin/claude-superagent.mjs ask --wait "README.md has a typo: 'recieve' should be 'receive'. Please fix it and open a pull request."
#   agent (acknowledgement): On it: correcting `recieve` to `receive` in README.md and opening a pull request.
#   agent (reply): Fixed the README typo (`recieve` → `receive`): PR #1 is ready for review and needs a person to merge it.
./bin/claude-superagent.mjs ask --thread <id> "In the same PR, also ..."    # goes straight to that ticket's worker
./bin/claude-superagent.mjs inbox [<id>]
./bin/claude-superagent.mjs status         # exits 0 ok, 1 not running, 2 a part reports an error, 3 setup waits
```

From GitHub, an account on the allowed list comments `@<agent login> <request>` on an issue or pull request. The agent can't take requests from its own account: GitHub messages it wrote are its own.

## Rules it keeps

- Workers run in `dontAsk` mode: what is not allowed is denied, never prompted.
- A `PreToolUse` hook ([src/app/hooks.ts](src/app/hooks.ts)) denies, with a reason the worker reads: merging or enabling auto-merge as the agent, deleting or reconfiguring anything on GitHub, `gh auth`, reading credential files, posting to chats directly, signalling processes, the commands the panel blocks, and any tool call once its ticket ended.
- The sandbox setting decides Bash: `on` runs it in Claude Code's sandbox, `weak` in its weaker mode for containers that cannot mount `/proc` (files and network stay in, other processes' `/proc` does not), `off` runs it as the service's user. The hook applies in every mode. None of this is a boundary against a determined program: run the service as an OS user that holds only the agent's credentials.
- Every Claude Code process it starts reads no settings, hooks or skills of yours (`settingSources: []`) and keeps its sessions in the state directory.

## Develop

```sh
npm run check        # typecheck and tests
node --experimental-strip-types --no-warnings poc/host-probes.ts steer:next    # a host probe; calls a model
```

## License

MIT. Much of this repository comes from dsh-superagent-prototype by the DeepSeek Harness Team, also MIT; [NOTICE.md](NOTICE.md) lists what came from it and what changed.
