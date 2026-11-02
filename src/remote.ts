/** How the command line and the terminal talk to the service that runs on this machine: its API and its live events. */
import type { LiveEvent, TerminalTicket } from './app/runtime.ts'
import type { LocalMessage } from './sources/local.ts'

export type { LiveEvent, TerminalTicket }
export interface Conversation { id: string; messages: number; first: string; at: string }

/** The service on this machine's loopback port, as the panel calls it. */
export class ServiceClient {
  constructor(readonly port: number) {}
  get base(): string { return `http://127.0.0.1:${this.port}` }
  /** One request, as the panel makes it; answers the status and the JSON body. */
  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.base}${path}`, { method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) } })
    return { status: response.status, body: await response.json().catch(() => ({})) as T }
  }
  /** One request whose answer must be a success; throws with the service's error otherwise. */
  async ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, body: answer } = await this.call<T & { error?: string }>(method, path, body)
    if (status >= 400) throw new Error(answer.error ?? `HTTP ${status}`)
    return answer
  }
  /** Whether the service answers. */
  async running(): Promise<boolean> { return this.call('GET', '/orchestrator/api/state').then(answer => answer.status === 200, () => false) }
  conversations(): Promise<{ conversations: Conversation[] }> { return this.ok('GET', '/local/conversations') }
  conversation(id: string, after = 0): Promise<{ messages: LocalMessage[]; next: number }> { return this.ok('GET', `/local/conversations/${id}?after=${after}`) }
  ask(text: string, conversation?: string): Promise<{ conversation: string; trigger_id: string; received: string }> {
    return this.ok('POST', '/local/messages', { text, ...conversation ? { conversation } : {} })
  }
  tickets(): Promise<{ tickets: TerminalTicket[] }> { return this.ok('GET', '/local/tickets') }
  /**
   * Follow the service's live events until `signal` aborts, connecting again after a drop; `connected` hears whether the
   * stream is up.
   */
  async follow(onEvent: (event: LiveEvent) => void, signal: AbortSignal, connected: (up: boolean) => void = () => {}): Promise<void> {
    let wait = 500
    while (!signal.aborted) {
      try {
        const response = await fetch(`${this.base}/local/events`, { headers: { 'x-orchestrator-request': '1' }, signal })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        connected(true); wait = 500
        const decoder = new TextDecoder()
        let buffer = ''
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true })
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
            const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
            if (data) { try { onEvent(JSON.parse(data) as LiveEvent) } catch { /* A frame this version cannot read. */ } }
          }
        }
      } catch { /* A drop or a refusal: try again below. */ }
      if (signal.aborted) return
      connected(false)
      await new Promise(resolve => setTimeout(resolve, wait))
      wait = Math.min(wait * 2, 10_000)
    }
  }
}
