# 005 Panel

The panel is a web page of its own, served by the service at `http://127.0.0.1:<port>/` (3082 by default), to supervise the agent. It is upstream's panel, which ran inside DeepSeek Harness's Web sidebar, moved onto a standalone page (`src/client/main.tsx`, `src/client/host.tsx`). The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

`npm install` builds the page into `lib/panel`; `npm run build:panel` builds it again. Without a build the service still answers the management API, and `/` says the panel is not built. The page picks the first of the browser's languages it has, Chinese or English, and its header switches language; the browser keeps the choice. Every address on the page is relative, so a gateway can serve it under a path, as 006 Deployment describes.

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Source**, **Trigger**, **Eval**, **Execution**, and **Settings**. Until repository and account setup succeeds, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | Tickets needing action, system problems, activity counts for the last 24 hours, and Executor load. Each block links to its detailed page |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Overview |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

### Opening an Executor Session

Upstream's Ticket page had **Open Session**, which opened the Executor Session in DeepSeek Harness's UI. A browser cannot open a Claude Code Session, so the folded identifiers of a Ticket name the command that does: `claude-superagent open <first 8 characters of the Ticket id>`, run in a terminal on the service's machine, or `/open` in the interactive terminal. [003 Execution](003-execution.md) describes what holding the Session means for the worker.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts: GitHub, Feishu and Terminal. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced. The Terminal card names the person who asks from this machine, which the Terminal's allowed list must name.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model, which is also the main Session's model; the model list is what Claude Code offers for the credentials in use.
- **Execution:** worker model, concurrency, directory root, prepare command, blocked commands, the **Bash sandbox** (on, weak or off) and the **other domains the sandbox reaches**, which do nothing while the sandbox is off. Clicking an available variable inserts it into the prepare command. Only the panel can change this group's environment settings; the main Session's save tool cannot.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory, and the machine limits: the largest saved prompt configuration, and how many Thread pages one assessment reads within what time. Saving the limits writes them into `config.json` in the state directory, and they apply at their next use, without a restart. The port, the allowed Hosts and the Claude Code configuration directory are edited in `config.json` and apply at a restart.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12`, a GitHub URL or a terminal conversation's id, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use the design tokens of `src/client/tokens.css`, which define for this page the tokens DeepSeek Harness defined upstream, and the controls of `src/client/controls.tsx`, local copies of DeepSeek Harness's. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
