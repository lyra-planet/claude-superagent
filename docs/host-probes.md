# Host probes

dsh-superagent's host gives it three things the Claude Code docs leave open: a way to hand a running worker a new message, a way for a finished background job to wake its worker, and shell isolation. [`poc/host-probes.ts`](../poc/host-probes.ts) tests each one against a real model.

Setup for every run below: Claude Agent SDK 0.3.310 with its bundled Claude Code 2.1.310, model `claude-opus-5-5`, `settingSources: []`, `persistSession: false`, `permissionMode: "dontAsk"`, a fresh working directory, Linux in a container, running as root. Each probe ran once, on 2026-11-02.

## New input while a worker runs

The worker calls a 12-second tool three times. While the first call runs, the host pushes `CODEWORD: pineapple` into the streaming input with a different `SDKUserMessage` setting each time.

| Setting | What happened | Use it for |
|---|---|---|
| `priority: "next"` | The model saw it right after the running tool returned, in the same turn, and went on with step 2. One result | A person's follow-up to a busy worker (upstream's `steer`) |
| `priority: "now"` | The running tool call was cut off ("interrupted before a result was received"), the turn ended, and a new turn started with the message. The model ran step 1 again. Two results | Stopping a worker. Not for ordinary input: a cut-off tool may or may not have taken effect |
| `priority: "later"` | Held until the turn ended, then handled as a turn of its own. Two results | Work that must not change the turn in progress (upstream's `followup`) |
| `shouldQuery: false` | With a turn running, the same as `next`: seen after the running tool, same turn | Context during a turn. Whether it leaves an idle session idle, as upstream's `inject` does, was not tested |

## A background job's end

The worker starts `sleep 25 && echo BG_DONE_42` with `run_in_background`, replies `STARTED` and ends its turn. The host sends nothing more.

When the job ended 24 seconds later, the SDK emitted `task_notification` (status `completed`), then a new turn started by itself; the model read the job's output and replied `BG_RESULT=BG_DONE_42`. Two results.

A worker can therefore end its turn while its tests run and pick up their result without the host. The host still has to count the worker as busy while a background job runs, as upstream does with worker slots.

## Shell isolation

The worker runs five commands: write inside its directory, write outside it, `curl https://example.com`, read a file listed in `sandbox.filesystem.denyRead`, and `gh pr merge 1`, which a `PreToolUse` hook denies with a reason. Settings: `sandbox.enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`, `network.allowedDomains: []`.

| Run | Inside | Outside | Network | Denied read | Hook |
|---|---|---|---|---|---|
| Default sandbox, `socat` missing | Query refused to start: `Sandbox required but unavailable … socat not installed` | | | | |
| Default sandbox, `socat` on PATH | Every command failed: `bwrap: Can't mount proc on /newroot/proc: Operation not permitted` | | | | Denied; the model quoted the reason |
| `enableWeakerNestedSandbox: true` | Written | Blocked: read-only file system | Blocked: proxy 403, `sandbox_violations` | Blocked: permission denied | Denied; the model quoted the reason |

The outside directory has to be away from `/tmp`: the sandbox lets commands write their own temporary directory, and a first run that put it there passed the write.

What the weaker sandbox leaves open: a command runs in a new PID namespace (its `$$` is 2), but `/proc` is the machine's own. It sees the machine's PID 1 and every process. Under root that likely includes other processes' `/proc/<pid>/environ`; this was not tested.

So, in an unprivileged container:

- `failIfUnavailable: true` fails closed: with a missing dependency or a sandbox that cannot start, nothing runs unsandboxed.
- The default sandbox needs a container that may mount `/proc`. The weaker one works without, and keeps files and network in, but not other processes' information.
- Hooks work in every case and are the place for rules such as "never merge".
- A worker that may run untrusted code needs more than this: its own OS user, or its own container.

## Reproduce

```sh
npm install
node --experimental-strip-types --no-warnings poc/host-probes.ts steer:next   # steer:now steer:later steer:inject background sandbox sandbox:weak
```

The sandbox needs `bubblewrap` and `socat` on PATH. Put the outside directory of the sandbox probe away from `/tmp` with `POC_OUTSIDE_PARENT`. A probe uses its own `CLAUDE_CONFIG_DIR` under `poc/.runs/` and drops the variables a running Claude Code session gives its children, so it can run from inside one.
