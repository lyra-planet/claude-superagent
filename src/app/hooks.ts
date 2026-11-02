/**
 * The rules the host enforces on workers, as one `PreToolUse` hook: what upstream left to prompt text or to command shims a
 * worker could bypass by path. The prompts still explain each rule; this makes it hold when the prompt does not.
 */
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk'
import { liveTicket, type Ticket } from '../core/index.ts'

/** One rule: the tools it looks at, what it matches in their input, and the reason the worker reads when it is denied. */
interface Rule { tools: RegExp; matches: RegExp; reason: string }
const SHELL = /^(Bash|PowerShell)$/, FILES = /^(Read|Edit|Write|NotebookEdit|Glob|Grep)$/
/**
 * Every rule, in one table. A merge or auto-merge goes through the merge CLI that Delivery requirements names, which is not
 * `gh`; GitHub writes beyond the work (deleting, visibility, secrets, keys) and credential reads never go through.
 */
export const RULES: readonly Rule[] = [
  { tools: SHELL, matches: /\bgh\s+pr\s+merge\b|mergePullRequest|enablePullRequestAutoMerge/,
    reason: 'The agent account never merges or enables auto-merge: people merge, or the merge CLI that Delivery requirements names does.' },
  { tools: SHELL, matches: /\bgh\s+(repo\s+(delete|archive|edit|rename)|secret|variable|ssh-key|gpg-key|auth|org|ruleset|release\s+delete|cache\s+delete)\b/,
    reason: 'This GitHub operation is outside a worker\'s work: workers commit, push, comment and open or update pull requests.' },
  { tools: SHELL, matches: /\bgh\s+api\b[^\n]*(-X|--method)\s*['"]?DELETE\b/i, reason: 'Workers do not delete anything on GitHub.' },
  { tools: SHELL, matches: /(^|[\s;&|(`])(kill|pkill|killall|reboot|shutdown|halt|poweroff)\b/,
    reason: 'Workers do not signal processes: the machine runs other people\'s work. Stop a background job of your own with the job tools.' },
  { tools: SHELL, matches: /\blark-cli\b[^\n]*\+?messages?-(send|reply|forward)\b/,
    reason: 'Workers do not post to chats: the router delivers replies through orchestrator_reply.' },
  { tools: SHELL, matches: /\.credentials\.json|\/secrets\/|gh_token|\.config\/gh\b|\.ssh\/id_|\.git-credentials/,
    reason: 'Credentials are not for workers to read: the gh and git of this environment already act as the agent account.' },
  { tools: FILES, matches: /\.credentials\.json|\/secrets\/|gh_token|\.config\/gh\/|\.ssh\/id_|\.git-credentials/,
    reason: 'Credentials are not for workers to read: the gh and git of this environment already act as the agent account.' },
]
/** The input of a tool call as one string a rule reads: its command, path or pattern, or its whole input. */
function inputText(input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>
  return ['command', 'file_path', 'path', 'pattern', 'notebook_path'].map(name => fields[name]).filter(value => typeof value === 'string').join('\n')
    || JSON.stringify(input ?? {})
}
/** The reason a call is denied, or undefined when no rule refuses it; `blocked` adds the Execution settings' blocked commands. */
export function refusal(toolName: string, input: unknown, ticket: Ticket | undefined, blocked: readonly string[] = []): string | undefined {
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended; new work needs a new authorized ticket.'
  const text = inputText(input)
  const rule = RULES.find(item => item.tools.test(toolName) && item.matches.test(text))
  if (rule) return rule.reason
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
    const call = input as { tool_name?: string; tool_input?: unknown }
    const reason = refusal(call.tool_name ?? '', call.tool_input, read.ticket(ticketId), read.blocked())
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {}
  }] }] }
}
