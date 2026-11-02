/**
 * Probes of the Claude Code behaviours a dsh-superagent-style host depends on but the docs leave open.
 *
 *   node --experimental-strip-types --no-warnings poc/host-probes.ts <probe>
 *
 * Probes:
 *   steer:<now|next|later|inject>  push a message while a tool runs: when does the model see it?
 *   background                    end a turn with a background Bash job running: does its end wake the session?
 *   sandbox[:weak]                sandboxed Bash under dontAsk: writes outside cwd, network, a denied read, and a
 *                                 PreToolUse hook deny whose reason the model should repeat; `weak` turns on
 *                                 enableWeakerNestedSandbox, for containers where bubblewrap cannot mount /proc
 *
 * Every probe runs in a fresh directory under poc/.runs/, loads no settings (settingSources: []), persists no session,
 * and prints a timeline of the SDK messages. Set POC_MODEL to choose the model.
 */
import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const MODEL = process.env.POC_MODEL ?? 'claude-opus-5-5'
const RUNS = new URL('.runs/', import.meta.url).pathname
const started = Date.now()
const at = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`.padStart(8)
const say = (text: string) => { console.log(`${at()}  ${text}`) }
/**
 * The environment of a probe's Claude Code process: the caller's, without the variables a Claude Code session gives its own
 * children, which would make the probe part of that session, and with a config directory of its own under poc/.runs/, so
 * the probe reads none of the caller's settings and writes none of its state. Credentials still come from where the caller's
 * Claude Code keeps them.
 */
const SESSION_VARIABLES = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/
const probeEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.test(name))),
  CLAUDE_CONFIG_DIR: join(RUNS, 'config'), ...extra })

/** A prompt stream the host can push into while the query runs, as the router does with new Inputs. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false
  push(text: string, extra: Partial<SDKUserMessage> = {}): void {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...extra })
    this.wake?.()
  }
  close(): void { this.closed = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!
      if (this.closed) return
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

/** One line per SDK message: its kind, and the parts of it a probe reads. */
function describe(message: SDKMessage): string {
  const m = message as any
  if (m.type === 'assistant') {
    return 'assistant  ' + (m.message?.content ?? []).map((block: any) => block.type === 'text' ? `text ${JSON.stringify(block.text.slice(0, 160))}`
      : block.type === 'tool_use' ? `tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 160)}` : block.type).join(' | ')
  }
  if (m.type === 'user') {
    const content = m.message?.content
    if (typeof content === 'string') return `user  ${JSON.stringify(content.slice(0, 120))}`
    return 'user  ' + (content ?? []).map((block: any) => block.type === 'tool_result'
      ? `tool_result ${JSON.stringify(JSON.stringify(block.content).slice(0, 160))}` : block.type === 'text' ? `text ${JSON.stringify(block.text.slice(0, 120))}` : block.type).join(' | ')
  }
  if (m.type === 'result') return `result  ${m.subtype} turns=${m.num_turns} ${JSON.stringify(String(m.result ?? '').slice(0, 200))}`
  if (m.type === 'system') {
    const extra = m.subtype === 'init' ? `model=${m.model} version=${m.claude_code_version ?? '?'} permissionMode=${m.permissionMode}`
      : m.subtype?.startsWith('task_') ? `task=${m.task_id} status=${m.status ?? ''} ${JSON.stringify(String(m.summary ?? m.description ?? '').slice(0, 120))}`
      : ''
    return `system/${m.subtype}  ${extra}`
  }
  return m.type + (m.subtype ? `/${m.subtype}` : '')
}

/** Run one query over `inbox`, calling `on` for each message, until `done` says so or `limitMs` passes. */
async function run(options: Options, inbox: Inbox, on: (message: SDKMessage) => boolean | void, limitMs: number): Promise<SDKMessage[]> {
  const abortController = new AbortController()
  const timer = setTimeout(() => { say('time limit reached'); inbox.close(); abortController.abort() }, limitMs)
  const seen: SDKMessage[] = []
  try {
    for await (const message of query({ prompt: inbox, options: { model: MODEL, settingSources: [], persistSession: false, abortController, env: probeEnv(), ...options } })) {
      seen.push(message)
      say(describe(message))
      if (on(message)) inbox.close()
    }
  } catch (error) {
    say(`query ended with ${String(error).slice(0, 300)}`)
  } finally { clearTimeout(timer) }
  return seen
}

const text = (messages: SDKMessage[]) => messages.flatMap((message: any) => message.type === 'assistant'
  ? message.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text as string) : []).join('\n')
const results = (messages: SDKMessage[]) => messages.filter(message => message.type === 'result').length

async function steer(mode: 'now' | 'next' | 'later' | 'inject', cwd: string): Promise<void> {
  let calls = 0
  const slow = tool('slow_step', 'Run one slow step of the job. Takes about 12 seconds.', { n: z.number().int() }, async ({ n }) => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 12_000))
    return { content: [{ type: 'text', text: `step ${n} done` }] }
  })
  const inbox = new Inbox()
  inbox.push('Call slow_step with n=1, then n=2, then n=3, one call at a time. If a user message with a codeword reaches you at any point, '
    + 'write "GOT <codeword>" in your very next text before doing anything else. After step 3, reply with one line: LAST_SEEN=<codeword or NONE>.')
  let pushed = false, asked = false, turns = 0, said = ''
  const messages = await run({
    cwd, permissionMode: 'dontAsk', allowedTools: ['mcp__probe__slow_step'], disallowedTools: ['Bash', 'Write', 'Edit', 'Agent'],
    systemPrompt: 'You are a test agent. Follow the instructions exactly and keep text short.',
    mcpServers: { probe: createSdkMcpServer({ name: 'probe', tools: [slow] }) },
  }, inbox, message => {
    const m = message as any
    said += text([message])
    const step1 = m.type === 'assistant' && m.message.content.some((block: any) => block.type === 'tool_use' && block.input?.n === 1)
    if (step1 && !pushed) {
      pushed = true
      const extra = mode === 'inject' ? { shouldQuery: false } : { priority: mode }
      say(`>>> host pushes CODEWORD pineapple with ${JSON.stringify(extra)} while slow_step 1 runs`)
      inbox.push('CODEWORD: pineapple', extra)
    }
    if (m.type !== 'result') return false
    turns++
    if (/pineapple/i.test(said) || turns >= 3) return true
    // An injected message asks for no turn: ask once whether it reached the transcript anyway.
    if (mode === 'inject' && !asked) {
      asked = true
      say('>>> host asks which codewords arrived')
      inbox.push('List every codeword any user message has given you so far, or say NONE.')
    }
    return false
  }, 150_000)
  const all = text(messages)
  const got = messages.findIndex((message: any) => message.type === 'assistant' && message.message.content.some((block: any) => block.type === 'text' && /GOT pineapple/i.test(block.text)))
  const step2 = messages.findIndex((message: any) => message.type === 'assistant' && message.message.content.some((block: any) => block.type === 'tool_use' && block.input?.n === 2))
  const firstResult = messages.findIndex(message => message.type === 'result')
  say(`VERDICT steer:${mode}: slow_step calls=${calls}, results=${results(messages)}, saw codeword=${/pineapple/i.test(all)}, `
    + `GOT before step 2=${got >= 0 && step2 >= 0 && got < step2}, GOT after first result=${got > firstResult && firstResult >= 0}, ${/LAST_SEEN=\S+/.exec(all)?.[0] ?? 'no LAST_SEEN'}`)
}

async function background(cwd: string): Promise<void> {
  const inbox = new Inbox()
  inbox.push('Run this exact command with the Bash tool and run_in_background set to true: sleep 25 && echo BG_DONE_42 . '
    + 'Do not wait for it and do not check on it: as soon as it has started, reply with the single word STARTED and end your turn. '
    + 'Later, if you learn that the command finished, reply with one line: BG_RESULT=<its output>.')
  const messages = await run({
    cwd, permissionMode: 'dontAsk', allowedTools: ['Bash'], disallowedTools: ['Write', 'Edit', 'Agent'],
    systemPrompt: 'You are a test agent. Follow the instructions exactly and keep text short.',
  }, inbox, message => (message as any).type === 'result' && /BG_RESULT/.test(String((message as any).result ?? '')), 120_000)
  const notified = messages.some((message: any) => message.type === 'system' && message.subtype === 'task_notification')
  say(`VERDICT background: results=${results(messages)}, task_notification=${notified}, woke and reported=${/BG_RESULT=\S*BG_DONE_42/.test(text(messages))}`)
}

async function sandbox(cwd: string, weak: boolean): Promise<void> {
  // The sandbox lets Bash write its own temporary directory, so put the outside directory where POC_OUTSIDE_PARENT says.
  const outside = await mkdtemp(join(process.env.POC_OUTSIDE_PARENT ?? RUNS, 'outside-'))
  const secret = join(outside, 'fake-secret.txt')
  await writeFile(secret, 'FAKE_SECRET_7')
  // A stand-in gh on PATH, so a call the hook fails to stop reaches nothing real.
  const stubs = join(outside, 'bin')
  await mkdir(stubs)
  await writeFile(join(stubs, 'gh'), '#!/bin/sh\necho STUB_GH_RAN\n')
  await chmod(join(stubs, 'gh'), 0o755)
  const denied: string[] = []
  const inbox = new Inbox()
  inbox.push([
    'Run each of these five commands with the Bash tool, one call each, in order, even if one fails. Do not retry, do not work around a failure, and do not ask for permission.',
    '1. echo inside > inside.txt && cat inside.txt',
    `2. echo outside > ${outside}/probe.txt`,
    "3. curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com",
    `4. cat ${secret}`,
    '5. gh pr merge 1',
    'Then reply with five lines, one per command: N=<ok|failed> <the output, the error, or the exact reason you were given>.',
  ].join('\n'))
  const messages = await run({
    cwd, permissionMode: 'dontAsk', disallowedTools: ['Write', 'Edit', 'Agent'],
    env: probeEnv({ PATH: `${stubs}:${process.env.PATH ?? ''}` }),
    systemPrompt: 'You are a test agent. Follow the instructions exactly and keep text short.',
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      network: { allowedDomains: [] }, filesystem: { denyRead: [secret] }, ...weak ? { enableWeakerNestedSandbox: true } : {} },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async input => {
      const command = String((input as any).tool_input?.command ?? '')
      if (!/\bgh\s+pr\s+merge\b/.test(command)) return {}
      denied.push(command)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'HOOK_REASON_9: people merge pull requests in this repository' } }
    }] }] },
  }, inbox, message => (message as any).type === 'result', 180_000)
  const wroteOutside = await stat(join(outside, 'probe.txt')).then(() => true, () => false)
  const inside = await readFile(join(cwd, 'inside.txt'), 'utf8').then(value => value.trim(), () => '')
  const all = text(messages)
  say(`VERDICT sandbox${weak ? ':weak' : ''}: inside.txt=${JSON.stringify(inside)}, wrote outside cwd=${wroteOutside}, secret leaked=${/FAKE_SECRET_7/.test(all)}, `
    + `hook denied=${denied.length}, model repeated hook reason=${/HOOK_REASON_9/.test(all)}, stub gh ran=${/STUB_GH_RAN/.test(all)}`)
}

const probe = process.argv[2] ?? ''
await mkdir(RUNS, { recursive: true })
const cwd = await mkdtemp(join(RUNS, `${probe.replace(/[^a-z]+/g, '-')}-`))
say(`probe ${probe} in ${cwd} with ${MODEL}`)
if (probe.startsWith('steer:')) await steer(probe.slice(6) as 'now' | 'next' | 'later' | 'inject', cwd)
else if (probe === 'background') await background(cwd)
else if (probe === 'sandbox' || probe === 'sandbox:weak') await sandbox(cwd, probe === 'sandbox:weak')
else { console.error('Probes: steer:now steer:next steer:later steer:inject background sandbox sandbox:weak'); process.exit(2) }
