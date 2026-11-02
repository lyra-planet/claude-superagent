/**
 * The rules the host enforces on workers, as one `PreToolUse` hook: what upstream left to prompt text or to command shims a
 * worker could bypass by path. The prompts still explain each rule; this makes it hold when the prompt does not.
 */
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { liveTicket, type Ticket } from '../core/index.ts'

/** One rule: the tools it looks at, what it matches in their input, and the reason the worker reads when it is denied. */
interface Rule { tools: RegExp; matches: RegExp; reason: string }
const SHELL = /^(Bash|PowerShell)$/, FILES = /^(Read|Edit|Write|NotebookEdit|Glob|Grep)$/
/**
 * Every rule, in one table. A merge or auto-merge goes through the merge CLI that Delivery requirements names, which is not
 * `gh`; GitHub writes beyond the work (deleting, visibility, secrets, keys) and credential reads never go through.
 */
/** gh, its global flags with their values (`-R owner/name`), then a command: `gh -R a/b pr merge` names `pr merge` as `gh pr merge` does. */
const GH = String.raw`\bgh(\s+-{1,2}[\w-]+(=\S+|\s+[^\s-]\S*)?)*\s+`
const CREDENTIALS = /\.credentials\.json|\/secrets\/|gh_token|\.config\/gh\b|hosts\.yml|\.ssh\/id_|\.git-credentials|\/proc\/[^\s'"]*environ/
export const RULES: readonly Rule[] = [
  { tools: SHELL, matches: new RegExp(`${GH}pr(\\s+-{1,2}[\\w-]+(=\\S+|\\s+[^\\s-]\\S*)?)*\\s+merge\\b|\\bpulls\\/[^\\s/'"]+\\/merge\\b|mergePullRequest|enablePullRequestAutoMerge`),
    reason: 'The agent account never merges or enables auto-merge: people merge, or the merge CLI that Delivery requirements names does.' },
  { tools: SHELL, matches: new RegExp(`${GH}(repo\\s+(delete|archive|edit|rename)|secret|variable|ssh-key|gpg-key|auth|org|ruleset|alias|extension|release\\s+delete|cache\\s+delete)\\b`),
    reason: 'This GitHub operation is outside a worker\'s work: workers commit, push, comment and open or update pull requests.' },
  { tools: SHELL, matches: new RegExp(`${GH}[\\w-]+\\s+delete\\b|\\bgh\\s+api\\b[^\\n]*(-X|--method)[\\s=]*['"]?DELETE\\b|\\bdelete[A-Z]\\w*\\s*\\(|\\bgit\\s+push\\b[^\\n]*(\\s(--delete|-d)\\b|\\s\\+?:\\S)`, 'i'),
    reason: 'Workers do not delete anything on GitHub.' },
  { tools: SHELL, matches: /(^|[\s;&|(`])(\S*\/|\\)?(kill|pkill|killall|reboot|shutdown|halt|poweroff)(\s|$)/,
    reason: 'Workers do not signal processes: the machine runs other people\'s work. Stop a background job of your own with the job tools.' },
  { tools: SHELL, matches: /\blark-cli\b[^\n]*(\+?messages?-(send|reply|forward)\b|\bapi\b[^\n]*\b(POST|PUT|PATCH)\b[^\n]*\/im\/v1\/messages)/i,
    reason: 'Workers do not post to chats: the router delivers replies through orchestrator_reply.' },
  { tools: SHELL, matches: CREDENTIALS,
    reason: 'Credentials are not for workers to read: the gh and git of this environment already act as the agent account.' },
  { tools: FILES, matches: new RegExp(`${CREDENTIALS.source}|^/proc/`),
    reason: 'Credentials are not for workers to read: the gh and git of this environment already act as the agent account.' },
]
/** Directories whose tree holds the machine's credentials: a search from one of them, or from above, would read them too. */
const SEARCH_GUARDED = () => [homedir(), join(homedir(), '.config'), join(homedir(), '.ssh')]
/** Whether a Grep or Glob searches a tree that holds credentials: from the home directory, its .config or .ssh, or above them. */
function searchesCredentials(toolName: string, input: unknown, cwd: string): boolean {
  if (!/^(Glob|Grep)$/.test(toolName)) return false
  const path = (input as { path?: unknown } | undefined)?.path
  if (typeof path !== 'string' || !path) return false
  const root = resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()))
  return SEARCH_GUARDED().some(guarded => guarded === root || guarded.startsWith(root.endsWith(sep) ? root : root + sep))
}
/**
 * The files a `gh api` call sends (`-F name=@file`, `--input file`), up to 64 KiB each: a GraphQL mutation or a body in a
 * file is checked as if it were on the command line.
 */
function sentFiles(command: string, cwd: string): string {
  if (!/\bgh\b[^\n]*\bapi\b/.test(command)) return ''
  const paths = [...command.matchAll(/(?:-F|--field)[\s=]+['"]?\w[\w.\[\]-]*=@([^\s'"]+)|--input[\s=]+['"]?([^\s'"-][^\s'"]*)/g)].map(match => match[1] ?? match[2]!)
  return paths.map(path => {
    const file = resolve(cwd, path)
    try { return statSync(file).size <= 64 * 1024 ? readFileSync(file, 'utf8') : '' } catch { return '' }
  }).join('\n')
}
/** The input of a tool call as one string a rule reads: its command, path or pattern, or its whole input. */
function inputText(input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>
  return ['command', 'file_path', 'path', 'pattern', 'notebook_path'].map(name => fields[name]).filter(value => typeof value === 'string').join('\n')
    || JSON.stringify(input ?? {})
}
/**
 * The reason a call is denied, or undefined when no rule refuses it; `blocked` adds the Execution settings' blocked commands,
 * and `cwd` is where the call runs, against which its relative paths resolve.
 */
export function refusal(toolName: string, input: unknown, ticket: Ticket | undefined, blocked: readonly string[] = [], cwd = ticket?.execution?.directory || process.cwd()): string | undefined {
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended; new work needs a new authorized ticket.'
  const command = inputText(input)
  const text = SHELL.test(toolName) ? `${command}\n${sentFiles(command, cwd)}` : command
  const rule = RULES.find(item => item.tools.test(toolName) && item.matches.test(text))
  if (rule) return rule.reason
  if (searchesCredentials(toolName, input, cwd)) return RULES.at(-1)!.reason
  if (SHELL.test(toolName)) {
    const name = blocked.find(command => new RegExp(`(^|[\\s;&|(\`/])${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(text))
    if (name) return `${name} is blocked in this installation; use gh, which acts as the agent account.`
  }
  return undefined
}
/** The hooks of a ticket's worker: its live state and the blocked commands are read at each call, so a change applies at once. */
export function workerHooks(ticketId: string, read: { ticket(id: string): Ticket | undefined; blocked(): readonly string[] }):
  Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return { PreToolUse: [{ hooks: [async input => {
    const call = input as { tool_name?: string; tool_input?: unknown; cwd?: string }
    const ticket = read.ticket(ticketId)
    const reason = refusal(call.tool_name ?? '', call.tool_input, ticket, read.blocked(), call.cwd || ticket?.execution?.directory || process.cwd())
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {}
  }] }] }
}
