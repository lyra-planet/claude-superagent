/** The host's log: one line per entry on standard error, with `%s`-style arguments as `util.format` reads them. */
import { format } from 'node:util'

export interface Logger {
  info(message: string, ...values: unknown[]): void
  warn(message: string, ...values: unknown[]): void
  error(message: string, ...values: unknown[]): void
}
const line = (level: string, message: string, values: unknown[]) => `${new Date().toISOString()} ${level} ${format(message, ...values)}\n`
export const consoleLogger: Logger = {
  info: (message, ...values) => { process.stderr.write(line('info', message, values)) },
  warn: (message, ...values) => { process.stderr.write(line('warn', message, values)) },
  error: (message, ...values) => { process.stderr.write(line('error', message, values)) },
}
