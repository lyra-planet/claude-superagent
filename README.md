# claude-superagent

DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) design, rebuilt on Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

> Unofficial. Not made, endorsed or supported by Anthropic or DeepSeek. Not related to SuperClaude. Early work: there is no runnable agent yet.

## What it is

An always-on agent for a team. It takes requests from where the team already talks, works on each one in its own session and directory, and answers in the original conversation, for example with a pull request. It speaks only when someone must act or can use a result.

It keeps dsh-superagent's shape:

- **One router, many workers.** A long-lived router session reads every candidate request and routes it. Each accepted request becomes a ticket with its own worker session.
- **Code gates, the model judges.** Who may ask for work is decided by code (allowed lists, an admission table). Whether a message asks for work is judged by the model.
- **Follow-ups skip the router.** Once a ticket exists, later messages on its threads go straight to its worker.
- **Durable by design.** Every side effect is recorded before it runs, and every id is derived from its inputs, so restarts and replays are safe.

## What changes on Claude Code

| dsh-superagent needs | On Claude Code |
|---|---|
| A persistent session per ticket | `query()` with `resume` |
| Tools and a prompt per role | In-process MCP tools (`createSdkMcpServer`), `systemPrompt` |
| A tool allowlist | `allowedTools` with `permissionMode: "dontAsk"`; `disallowedTools` removes a tool |
| Rules the host enforces | `PreToolUse` hooks, which run before every other permission step |
| New input while a worker runs | Streaming input with `priority: "next"`: the worker sees it after its running tool, in the same turn |
| A finished background job wakes its worker | Built in: `task_notification`, then a new turn |
| Shell isolation | The Bash sandbox (bubblewrap on Linux); in an unprivileged container only its weaker mode runs |

[docs/host-probes.md](docs/host-probes.md) has how each of the last three was tested.

Planned differences from upstream:

- The router gets no shell at all. Upstream keeps `bash` on its router and relies on the prompt.
- Rules upstream leaves to prompt text, such as "never merge your own pull request", become hooks.
- A follow-up from someone outside the allowed list no longer reaches a full-access worker as if they had asked for it.

## Status

- [x] Domain core ported unchanged from upstream (`src/core`, `src/policy.ts`), with its 144 tests passing
- [x] Host probes: how streaming input, background jobs and the sandbox behave ([docs/host-probes.md](docs/host-probes.md))
- [ ] Claude Code host: router and worker sessions, delivery, tools
- [ ] GitHub source
- [ ] Follow-up admission fix

## Develop

Node.js 22.19 or later.

```sh
npm install
npm run check          # typecheck and tests
node --experimental-strip-types --no-warnings poc/host-probes.ts steer:next
```

The probes call a model through the Claude Code binary the SDK bundles, with your usual Claude Code login.

## Accounts

Anything that serves a team must authenticate with an API key or a cloud provider. Anthropic does not allow third-party products to offer claude.ai login or its rate limits; see the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

## License

MIT. Parts of this repository come from dsh-superagent-prototype by the DeepSeek Harness Team, also MIT; [NOTICE.md](NOTICE.md) lists them.
