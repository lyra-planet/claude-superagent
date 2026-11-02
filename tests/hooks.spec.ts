import { describe, expect, it } from 'vitest'
import { refusal, workerHooks } from '../src/app/hooks.ts'
import type { Ticket } from '../src/core/index.ts'

const live = { id: 't1', ended: undefined } as unknown as Ticket
const ended = { id: 't1', ended: { at: '', by: 'executor', outcome: 'merged' } } as unknown as Ticket
const bash = (command: string, ticket: Ticket | undefined = live, blocked: string[] = []) => refusal('Bash', { command }, ticket, blocked)

describe('refusal', () => {
  it('lets ordinary work through', () => {
    for (const command of ['git commit -m "Fix typo"', 'git push -u origin HEAD', 'gh pr create --fill', 'gh pr view 3 --json state',
      'gh api repos/acme/widgets/pulls/3/comments', 'npm test', 'echo killer feature', 'grep -r skill .']) {
      expect(bash(command), command).toBeUndefined()
    }
    expect(refusal('Read', { file_path: '/work/repo/README.md' }, live)).toBeUndefined()
    expect(refusal('mcp__superagent__orchestrator_report', { state: 'ready' }, live)).toBeUndefined()
  })
  it('refuses merging and auto-merge as the agent account', () => {
    expect(bash('gh pr merge 3 --squash')).toMatch(/never merges/)
    expect(bash('gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }\'')).toMatch(/never merges/)
  })
  it('refuses GitHub operations outside a worker\'s work', () => {
    for (const command of ['gh repo delete acme/widgets --yes', 'gh repo edit --visibility public', 'gh secret set TOKEN', 'gh auth token',
      'gh ssh-key add key.pub', 'gh release delete v1']) expect(bash(command), command).toMatch(/outside a worker/)
    expect(bash('gh api -X DELETE repos/acme/widgets/git/refs/heads/x')).toMatch(/delete anything/)
    expect(bash('gh api --method DELETE repos/acme/widgets')).toMatch(/delete anything/)
  })
  it('refuses signalling processes on a shared machine', () => {
    for (const command of ['kill 1', 'kill -9 $(cat server.pid)', 'pkill -f node', 'sleep 1; killall node', 'shutdown -h now']) {
      expect(bash(command), command).toMatch(/do not signal processes/)
    }
  })
  it('refuses reading credentials, by shell or by file tool', () => {
    expect(bash('cat ~/.config/gh/hosts.yml')).toMatch(/Credentials/)
    expect(bash('cat /home/me/.claude/.credentials.json')).toMatch(/Credentials/)
    expect(refusal('Read', { file_path: '/home/me/.ssh/id_ed25519' }, live)).toMatch(/Credentials/)
  })
  it('refuses posting to a chat directly', () => {
    expect(bash('lark-cli im +messages-send --chat-id oc_1 --text hi')).toMatch(/do not post to chats/)
  })
  it('refuses every tool once the ticket ended or is unknown', () => {
    expect(bash('git status', ended)).toMatch(/Ticket ended/)
    expect(refusal('Read', { file_path: 'README.md' }, undefined)).toMatch(/Ticket ended/)
  })
  it('refuses the blocked commands by name, wherever they stand in a command line', () => {
    expect(bash('personal-gh pr list', live, ['personal-gh'])).toMatch(/personal-gh is blocked/)
    expect(bash('cd x && /usr/local/bin/personal-gh api user', live, ['personal-gh'])).toMatch(/personal-gh is blocked/)
    expect(bash('echo personal-ghost', live, ['personal-gh'])).toBeUndefined()
  })
})

describe('workerHooks', () => {
  it('denies through PreToolUse with the reason the worker reads, and reads the ticket at each call', async () => {
    let ticket: Ticket = live
    const hooks = workerHooks('t1', { ticket: () => ticket, blocked: () => [] })
    const hook = hooks.PreToolUse![0]!.hooks[0]!
    const call = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never, 'u1', { signal: new AbortController().signal })
    expect(await call('git status')).toEqual({})
    expect(await call('gh pr merge 1')).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })
    ticket = ended
    expect(await call('git status')).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringMatching(/Ticket ended/) } })
  })
})
