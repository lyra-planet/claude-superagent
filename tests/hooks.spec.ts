import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refusal, workerHooks } from '../src/app/hooks.ts'
import type { Ticket } from '../src/core/index.ts'

const live = { id: 't1', ended: undefined } as unknown as Ticket
const ended = { id: 't1', ended: { at: '', by: 'executor', outcome: 'merged' } } as unknown as Ticket
const bash = (command: string, ticket: Ticket | undefined = live, blocked: string[] = []) => refusal('Bash', { command }, ticket, blocked)

describe('refusal', () => {
  it('refuses the other ways a worker could merge, delete, signal, post or read credentials', () => {
    // Adapted: forms the first table missed, found by review.
    for (const command of ['gh api -X PUT repos/acme/w/pulls/3/merge', 'gh api --method PUT repos/acme/w/pulls/3/merge', 'gh -R acme/w pr merge 3',
      'gh pr -R acme/w merge 3', 'gh pr --repo=acme/w merge 3']) expect(bash(command), command).toMatch(/never merges/)
    expect(bash("gh alias set m 'pr merge'"), 'alias').toMatch(/outside a worker/)
    for (const command of ['gh api --method=DELETE repos/acme/w/git/refs/heads/x', 'gh api -XDELETE repos/acme/w/issues/comments/1',
      "gh api graphql -f query='mutation { deleteRef(input: {refId: \"x\"}) { clientMutationId } }'", 'gh issue delete 3 --yes', 'gh label delete bug',
      'git push origin --delete agent/x', 'git push -d origin agent/x', 'git push origin :agent/x']) expect(bash(command), command).toMatch(/delete anything/)
    for (const command of ['/bin/kill -9 1234', '\\kill -9 1234', 'sleep 1; /usr/bin/pkill node']) expect(bash(command), command).toMatch(/signal processes/)
    expect(bash('lark-cli api POST /open-apis/im/v1/messages --data x')).toMatch(/post to chats/)
    expect(refusal('Read', { file_path: '/home/op/.config/gh-agent/hosts.yml' }, live)).toMatch(/Credentials/)
    expect(refusal('Read', { file_path: '/proc/1234/environ' }, live)).toMatch(/Credentials/)
    expect(bash('cat /proc/$PPID/environ')).toMatch(/Credentials/)
    for (const path of [join(homedir(), '.config'), homedir(), '/', '~']) expect(refusal('Grep', { pattern: 'token', path }, live), path).toMatch(/Credentials/)
    expect(refusal('Grep', { pattern: 'token', path: '.' }, live, [], '/work/repo')).toBeUndefined()
    // A GraphQL mutation or a body in the file a gh api call sends counts as if it were on the command line.
    const dir = mkdtempSync(join(tmpdir(), 'hooks-'))
    writeFileSync(join(dir, 'q.graphql'), 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }')
    writeFileSync(join(dir, 'reply.md'), 'Fixed in abc123.')
    expect(refusal('Bash', { command: 'gh api graphql -F query=@q.graphql' }, live, [], dir)).toMatch(/never merges/)
    expect(refusal('Bash', { command: 'gh api repos/acme/w/pulls/3/comments/9/replies --method POST -F body=@reply.md' }, live, [], dir)).toBeUndefined()
  })
  it('lets ordinary work through', () => {
    for (const command of ['gh pr create --title "Merge the two configs" --body-file /work/drafts/pr.md', 'gh pr view 3 --json mergeable,mergeStateStatus',
      'cat docs/kill-switch.md', 'git log --grep=shutdown', 'gh pr list --search "is:merged"', 'git push origin HEAD:refs/heads/agent/x']) {
      expect(bash(command), command).toBeUndefined()
    }
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
