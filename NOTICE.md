# Notice

claude-superagent is an unofficial project. It is not made, endorsed or supported by Anthropic or DeepSeek.

## Code derived from dsh-superagent-prototype

Source: https://github.com/deepseek-ai/dsh-superagent-prototype, commit `6337fc8` (2026-10-31).

| Files here | Status |
|---|---|
| `src/core/*.ts` | Copied unchanged |
| `src/policy.ts` | Copied; one import now points at `src/infra/worker-commands.ts` |
| `src/admission.ts`, `src/limits.ts`, `src/infra/text.ts` | Copied unchanged |
| `src/infra/worker-commands.ts` | The `WORKER_COMMANDS` constant, moved out of upstream `src/infra/environment.ts` |
| `tests/core-engine.spec.ts`, `tests/stage.spec.ts` | Copied unchanged |

Those files are covered by the upstream license:

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
