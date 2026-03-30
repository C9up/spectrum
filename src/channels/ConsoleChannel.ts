/**
 * Console log channel — pretty-print in dev, JSON in prod.
 *
 * @implements FR57, FR58
 */

import type { LogChannel, LogEntry } from '../types.js'

export class ConsoleChannel implements LogChannel {
  name = 'console'
  private format: 'pretty' | 'json'

  constructor(format: 'pretty' | 'json' = 'pretty') {
    this.format = format
  }

  write(entry: LogEntry): void {
    if (this.format === 'json') {
      this.writeJson(entry)
    } else {
      this.writePretty(entry)
    }
  }

  private writeJson(entry: LogEntry): void {
    // Data nested under 'data' key — no spread to prevent key collisions
    const output = JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      module: entry.module,
      message: entry.message,
      correlationId: entry.correlationId,
      data: entry.data,
    })
    this.writeToStream(entry.level, `${output}\n`)
  }

  private writePretty(entry: LogEntry): void {
    const time = entry.timestamp.substring(11, 19) // HH:MM:SS
    const levelStr = entry.level.toUpperCase().padEnd(5)
    const prefix = this.levelPrefix(entry.level)
    const cid = entry.correlationId ? ` cid=${entry.correlationId.substring(0, 8)}` : ''
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : ''

    this.writeToStream(
      entry.level,
      `${prefix} ${time} ${levelStr} [${entry.module}] ${entry.message}${cid}${dataStr}\n`,
    )
  }

  /** Route error/fatal to stderr, others to stdout. */
  private writeToStream(level: string, output: string): void {
    if (level === 'error' || level === 'fatal') {
      process.stderr.write(output)
    } else {
      process.stdout.write(output)
    }
  }

  private levelPrefix(level: string): string {
    switch (level) {
      case 'trace':
        return ' '
      case 'debug':
        return ' '
      case 'info':
        return 'i'
      case 'warn':
        return '!'
      case 'error':
        return 'x'
      case 'fatal':
        return 'X'
      default:
        return ' '
    }
  }
}
