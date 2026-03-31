/**
 * Rust Log Bridge — unifies Rust stderr output with Spectrum log entries.
 *
 * Captures Rust log output (which goes to stderr) and re-emits it
 * through the Spectrum Logger so both Rust and TS logs appear in
 * the same stream with the same format.
 *
 * @implements FR55
 */

import type { LogChannel, LogEntry, LogLevel } from './types.js'

/**
 * Parse a Rust log line into a Spectrum LogEntry.
 * Supports common Rust log formats:
 *   [INFO ream_http] Server listening on 0.0.0.0:3000
 *   [WARN ream_bus] Slow dispatch: 5ms
 */
export function parseRustLog(line: string): LogEntry | null {
  // Pattern: [LEVEL module] message
  const match = line.match(/^\[(\w+)\s+(\S+)\]\s+(.+)$/)
  if (!match) return null

  const levelMap: Record<string, LogLevel> = {
    TRACE: 'trace',
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
    FATAL: 'fatal',
  }

  const level = levelMap[match[1].toUpperCase()]
  if (!level) return null

  return {
    level,
    message: match[3],
    module: match[2].replace(/_/g, '-'),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Create a bridge that captures stderr and routes Rust logs to Spectrum channels.
 *
 * Usage:
 *   const bridge = createRustLogBridge(logger.config.channels)
 *   bridge.start()
 *   // ... Rust crates emit to stderr
 *   bridge.stop()
 */
export function createRustLogBridge(channels: LogChannel[]): { start: () => void; stop: () => void } {
  let originalStderrWrite: typeof process.stderr.write | undefined

  return {
    start() {
      if (originalStderrWrite) return // already started — idempotent guard
      originalStderrWrite = process.stderr.write.bind(process.stderr)

      process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        const str = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)

        // Try to parse as Rust log — if it matches, route to channels
        for (const line of str.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const entry = parseRustLog(trimmed)
          if (entry) {
            for (const channel of channels) {
              try { channel.write(entry) } catch { /* ignore */ }
            }
          } else {
            // Not a Rust log — pass through to original stderr
            originalStderrWrite!(line + '\n')
          }
        }

        return true
      }) as typeof process.stderr.write
    },

    stop() {
      if (originalStderrWrite) {
        process.stderr.write = originalStderrWrite as typeof process.stderr.write
        originalStderrWrite = undefined
      }
    },
  }
}
