/** Built-in prompt sections, role policies, and transcript projections for orchestrator and worker Sessions. */
import { bundledSkills, promptFile } from './skill-files.ts'
export { textPage } from './cards.ts'

/** Built-in host-delivery and tool-usage rules shared by all Sessions; a team may override them (`builtInParts`). */
export const sharedPrompt = promptFile('shared')
export const masterPrompt = promptFile('orchestrator')
export const workerPrompt = promptFile('worker')
/** Built-in policy sections referenced by role prompts; a team may override them. */
export const guides: Readonly<Record<string, string>> = Object.fromEntries(['subscriptions', 'replies', 'dispatch', 'work']
  .map(name => [name, promptFile(name)]))
/** Bundled Source skills registered by dsh-superagent; a team may override their text. */
export const sourceSkills: Readonly<Record<'feishu' | 'github', string>> = { feishu: bundledSkills.feishu.content, github: bundledSkills.github.content }
export const cliNotes = promptFile('cli')
/** Default text for the team-editable prompt sections (communication, ticket scope, and PR delivery). */
export const teamDefaults = {
  communication: promptFile('team/communication'), scope: promptFile('team/scope'), delivery: promptFile('team/delivery'),
}

export const mainAdmissionPolicy = promptFile('admission')

const handoff = { shared: promptFile('handoff'), orchestrator: promptFile('handoff-orchestrator'), worker: promptFile('handoff-worker') }
export const handoffPolicy = (role: 'orchestrator' | 'worker'): string => `${handoff.shared}\n${handoff[role]}`

export const autoMergeThreshold = (lines: number): string => `it changes fewer than ${lines} lines (additions plus deletions);`

/** One message of a Claude Code Session's history, as `getSessionMessages` reads it. */
export interface SessionRecord { type: 'user' | 'assistant' | 'system'; message: unknown }
/** A content block of a transcript entry: text, a tool call or its result, an image; `type` names which. */
export interface TranscriptBlock { type: string; text?: string; [field: string]: unknown }
/** Retains a message's role and content while omitting thinking blocks and system records. */
export function transcriptEntry(event: SessionRecord): { type: 'user' | 'assistant'; message: { role: string; content: TranscriptBlock[] } } | undefined {
  if (event.type === 'system') return undefined
  const message = (event.message ?? {}) as { role?: string; content?: unknown }
  const content: TranscriptBlock[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content) ? (message.content as TranscriptBlock[]).filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking') : []
  return { type: event.type, message: { role: message.role ?? event.type, content } }
}
