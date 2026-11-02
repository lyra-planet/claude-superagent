# Notice

## Code derived from dsh-superagent-prototype

Source: https://github.com/deepseek-ai/dsh-superagent-prototype, commit `6337fc8` (2026-10-31).

| Files here | Status |
|---|---|
| `src/core/*.ts` except the four below, `src/admission.ts`, `src/limits.ts`, `src/infra/text.ts`, `src/infra/commands.ts` | Copied unchanged |
| `src/core/ports.ts`, `src/core/intake.ts` | Copied; the Policy port gained `owns`, and a person it does not let decide a ticket's follow-ups reaches the ticket as context only (`docs/design.md`) |
| `src/core/errors.ts` | Copied; the panel-only execution environment also names the Bash sandbox and its domains |
| `src/core/reasons.ts`, `src/infra/health.ts` | Copied; the restart reason and a comment name this project's host |
| `src/kv.ts` | Copied; keys for the terminal Source's conversations, each Session's ledger and model, and held worker Sessions added; the schema 11 migration's keys gone |
| `src/setup.ts`, `src/infra/paths.ts` | Copied; messages and the package lookup name this project |
| `src/policy.ts` | Copied; one import now points at `src/infra/worker-commands.ts`, the Execution settings gained `sandbox` and `networkDomains`, and the Policy implements `owns` |
| `src/infra/worker-commands.ts` | The `WORKER_COMMANDS` constant, moved out of upstream `src/infra/environment.ts` |
| `src/infra/environment.ts` | Copied; commands run through Node's `child_process` instead of DeepSeek Harness's subprocess service |
| `src/deployment.ts` | Copied; the machine configuration is a JSON file read with zod instead of a DeepSeek Harness plugin configuration |
| `src/app/*.ts`, `src/app/tools/*.ts`, `src/app/views/*.ts` | Copied, except `runtime.ts`, `sessions.ts`, `delivery.ts`, `role-models.ts`, `retry-health.ts` and `migration.ts`, which are rewritten for the Agent SDK or left out. The copies changed where they used DeepSeek Harness: `http.ts` is a plain Node request handler, `resources.ts` reads transcripts and models through the host, `context.ts` reads Agent SDK messages, `store.ts` has no schema migration, `settings.ts` checks models through the host, `tools/main.ts` and `assessment.ts` return images as MCP content, `execution-environment.ts` adds `DSH_SUPERAGENT_DRAFTS` |
| `src/sources/*.ts` | Copied; a Source is a `SourcePlugin` instead of a DeepSeek Harness plugin, and Feishu images are MCP image content |
| `src/executor/common.ts` | Upstream `src/executor/dsh.ts` without its executor class; worker Session ids are UUIDs |
| `prompts/`, `skills/`, `locale/` | Copied; the text names this host where it named DeepSeek Harness, and says what differs on Claude Code (a job that ends wakes the worker; git takes no `VAR=… git` or `git -c`; a command takes its text from a file in `$DSH_SUPERAGENT_DRAFTS`) |
| `docs/000-philosophy.md` … `docs/008-cookbook.md` | Ported from upstream's `docs/`, same numbering and sections; rewritten where the host changed, and what was DeepSeek Harness's replaced by what this host does |
| `src/client/*` | Copied; it runs as a page of its own instead of a DeepSeek Harness client plugin (`main.tsx`, `host.tsx`, `tokens.css` and `index.html` replace the plugin entry and the host's design tokens), its API calls are relative to the page, Session navigation is gone (the ticket page names `claude-superagent open` instead), the Deployment page saves the machine limits into `config.json`, and the Execution settings gained the sandbox and its domains |
| `tests/core-engine.spec.ts`, `tests/stage.spec.ts` | Copied unchanged |
| The other `tests/*.spec.ts(x)` named after upstream's, and `tests/fixtures/` | Copied; adapted where the host changed, as their commits say |

Everything else (`src/app/runtime.ts`, `sessions.ts`, `session.ts`, `hooks.ts`, `models.ts`, `src/executor/claude.ts`, `src/sources/local.ts`, `src/cli.ts`, `src/infra/log.ts`, `poc/`, `docs/design.md`, `docs/host-probes.md`, `src/app/panel.ts`, and the tests upstream does not have: `hooks`, `host-review`, `local`, `paths`, `panel-handler`) is this project's own.

The files from upstream are covered by its license:

```
MIT License

Copyright (c) 2026 DeepSeek Harness Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Names

"Claude" and "Claude Code" are trademarks of Anthropic. "DeepSeek" is a trademark of its owner. They are used here only to say what this project is built on and what it is modeled after.
