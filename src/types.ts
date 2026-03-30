/**
 * Spectrum types.
 * @implements FR54, FR57
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

export interface LogEntry {
  level: LogLevel
  message: string
  module: string
  correlationId?: string
  timestamp: string
  data?: Record<string, unknown>
}

export interface LogChannel {
  name: string
  write(entry: LogEntry): void
}

export interface LogConfig {
  level: LogLevel
  channels: LogChannel[]
  /** Per-module log level overrides */
  modules?: Record<string, LogLevel>
}
