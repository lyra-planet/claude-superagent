/**
 * The terminal's entry, which `claude-superagent` runs without a command: start the service in the background when it does not
 * run, draw the terminal, and between draws open a worker's Session in Claude Code or stop the service when asked.
 */
import { render } from 'ink'
import { createInterface } from 'node:readline/promises'
import { runClaude, type Held } from '../open.ts'
import { ServiceClient } from '../remote.ts'
import { startDetached, stopService } from '../service.ts'
import { App, type Exit } from './app.tsx'
import { short } from './model.ts'

export interface Options { stateDir: string; port: number; foreground: string[] }
const say = (text: string) => { process.stdout.write(`${text}\n`) }

export async function main({ stateDir, port, foreground }: Options): Promise<void> {
  const client = new ServiceClient(port)
  if (!await client.running()) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await prompt.question(`claude-superagent is not running on ${stateDir}. Start it in the background? [Y/n] `)).trim().toLowerCase()
    prompt.close()
    if (answer && answer !== 'y' && answer !== 'yes') return
    const { log } = await startDetached(stateDir, foreground, () => client.running())
    say(`Started; its log is ${log}`)
  }
  let resumed: { conversation?: string; note: string } | undefined
  for (;;) {
    let left: { exit: Exit; conversation?: string } = { exit: { kind: 'quit' } }
    const app = render(<App client={client} stateDir={stateDir} {...resumed ? { resumed } : {}}
      onExit={(exit, conversation) => { left = { exit, ...conversation ? { conversation } : {} } }} />, { exitOnCtrlC: false })
    await app.waitUntilExit()
    const { exit, conversation } = left
    if (exit.kind === 'quit') { say('The service goes on in the background; claude-superagent stop stops it.'); return }
    if (exit.kind === 'shutdown') {
      say('Stopping claude-superagent…')
      await stopService(stateDir, true, () => { say('Waiting for the workers to stop…') })
      return
    }
    resumed = { ...conversation ? { conversation } : {}, note: await open(client, exit) }
  }
}

/** Open a ticket's worker Session in Claude Code, and say how it went for the terminal's next draw. */
async function open(client: ServiceClient, { ticket, now, fork }: Extract<Exit, { kind: 'open' }>): Promise<string> {
  try {
    if (fork) {
      await runClaude({ ...await client.ok<Held>('GET', `/local/tickets/${ticket.id}/session`), stopped: 0 }, true)
      return `Back from a copy of ${short(ticket.id)}'s Session; the worker did not see it.`
    }
    const before = await client.ok<Held & { working: boolean }>('GET', `/local/tickets/${ticket.id}/session`)
    if (before.working && !now) say(`The worker of ${short(ticket.id)} is in a turn; its Session opens once that turn ends (/open ${short(ticket.id)} now cuts it short)…`)
    const held = await client.ok<Held>('POST', `/local/tickets/${ticket.id}/hold`, { now })
    say(`Opening the worker's Session of "${ticket.title}" in Claude Code; the worker waits until you leave it.${held.stopped ? ` Stopped ${held.stopped} background task(s) it left running.` : ''}`)
    try { await runClaude(held, false) } finally { await client.ok('POST', `/local/tickets/${ticket.id}/release`) }
    return `Back from ${short(ticket.id)}'s Session; the worker has it again and reads what you did there at its next turn.`
  } catch (error) {
    return `Could not open ${short(ticket.id)}'s Session: ${error instanceof Error ? error.message : String(error)}`
  }
}
