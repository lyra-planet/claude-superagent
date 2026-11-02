/**
 * What a Session does, as short lines the terminal shows the way Claude Code's own terminal does: a tool it calls with what it
 * calls it on, what it says, a turn that ends, background work that starts or ends. Built from the SDK's live messages and from
 * a Session's history alike.
 */
export interface ActivityLine {
  kind: 'tool' | 'text' | 'turn' | 'task'
  text: string
  /** A failed turn, or a tool result that is an error. */
  error?: true
}
const TEXT_CHARS = 280, INPUT_CHARS = 120
const oneLine = (text: string, limit: number) => {
  const flat = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
/** A long absolute path as its last three segments, as a person reads where in the work it is. */
const shortPath = (path: string) => { const parts = path.split('/'); return path.startsWith('/') && parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : path }
/** A command with each long absolute path in it shortened; a URL's path, which follows a `:`, stays. */
const shortPaths = (command: string) => command.replace(/(^|[\s='"(])(\/[^\s'"`;|&)]+)/g, (_, before: string, path: string) => before + shortPath(path))
/** What a tool call works on: the input field a person reads it by, as Claude Code's terminal names it. */
function subject(name: string, input: Record<string, unknown>): string {
  for (const field of ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'skill', 'state', 'kind']) {
    const value = input[field]
    if (typeof value === 'string' && value) return oneLine(field === 'file_path' ? shortPath(value) : field === 'command' ? shortPaths(value) : value, INPUT_CHARS)
  }
  return name.startsWith('mcp__') ? '' : oneLine(JSON.stringify(input), INPUT_CHARS)
}
/** The name a tool shows under: an MCP tool without its server prefix. */
const toolName = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')

/** The lines of one SDK message, or of one message of a Session's history. */
export function activityOf(message: unknown): ActivityLine[] {
  const m = message as { type?: string; subtype?: string; message?: { content?: unknown }; result?: unknown; is_error?: boolean; description?: string
    status?: string; task_id?: string; summary?: string; isReplay?: boolean; parent_tool_use_id?: string | null }
  // A subagent's own steps are its business; its start and end show as a task.
  if (m.parent_tool_use_id) return []
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    return (m.message.content as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[]).flatMap((block): ActivityLine[] => {
      if (block.type === 'text' && block.text?.trim()) return [{ kind: 'text', text: oneLine(block.text, TEXT_CHARS) }]
      if (block.type === 'tool_use' && block.name) {
        const on = subject(block.name, block.input ?? {})
        return [{ kind: 'tool', text: `${toolName(block.name)}(${on})` }]
      }
      return []
    })
  }
  if (m.type === 'user' && !m.isReplay && Array.isArray(m.message?.content)) {
    return (m.message.content as { type: string; is_error?: boolean; content?: unknown }[]).flatMap((block): ActivityLine[] =>
      block.type === 'tool_result' && block.is_error ? [{ kind: 'tool', text: `↳ ${oneLine(typeof block.content === 'string' ? block.content : JSON.stringify(block.content), INPUT_CHARS)}`, error: true }] : [])
  }
  if (m.type === 'result') {
    const failed = m.subtype !== 'success' || m.is_error
    return [{ kind: 'turn', text: failed ? `turn ended: ${m.subtype}` : 'turn ended', ...failed ? { error: true as const } : {} }]
  }
  if (m.type === 'system' && m.subtype === 'task_started') return [{ kind: 'task', text: `started ${oneLine(m.description ?? m.task_id ?? '', INPUT_CHARS)}` }]
  if (m.type === 'system' && m.subtype === 'task_notification') {
    return [{ kind: 'task', text: `${m.status ?? 'ended'} ${oneLine(m.summary ?? m.description ?? m.task_id ?? 'a task', INPUT_CHARS)}` }]
  }
  return []
}
