import { beforeEach, describe, expect, it } from 'vitest'
import { ConsoleChannel, Logger } from '../../src/index.js'
import type { LogChannel, LogEntry } from '../../src/index.js'

/** In-memory channel for testing. */
class TestChannel implements LogChannel {
  name = 'test'
  entries: LogEntry[] = []
  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

describe('logger > log levels', () => {
  let channel: TestChannel
  let logger: Logger

  beforeEach(() => {
    channel = new TestChannel()
    logger = new Logger({ level: 'info', channels: [channel] })
  })

  it('logs at info level and above', () => {
    logger.trace('should not appear')
    logger.debug('should not appear')
    logger.info('visible')
    logger.warn('visible')
    logger.error('visible')
    logger.fatal('visible')

    expect(channel.entries.length).toBe(4)
    expect(channel.entries.map((e) => e.level)).toEqual(['info', 'warn', 'error', 'fatal'])
  })

  it('logs at trace level when configured', () => {
    const traceLogger = new Logger({ level: 'trace', channels: [channel] })
    traceLogger.trace('visible')
    traceLogger.debug('visible')
    expect(channel.entries.length).toBe(2)
  })

  it('includes message and module', () => {
    logger.info('test message')
    expect(channel.entries[0].message).toBe('test message')
    expect(channel.entries[0].module).toBe('app')
  })

  it('includes timestamp as ISO 8601', () => {
    logger.info('test')
    expect(channel.entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('includes optional data', () => {
    logger.info('order', { orderId: '123', amount: 42 })
    expect(channel.entries[0].data).toEqual({ orderId: '123', amount: 42 })
  })
})

describe('logger > correlation ID', () => {
  it('carries correlation ID when set', () => {
    const channel = new TestChannel()
    const logger = new Logger({ level: 'info', channels: [channel] })
    logger.setCorrelationId('corr-abc')

    logger.info('test')
    expect(channel.entries[0].correlationId).toBe('corr-abc')
  })

  it('child logger inherits correlation ID', () => {
    const channel = new TestChannel()
    const logger = new Logger({ level: 'info', channels: [channel] })
    logger.setCorrelationId('parent-id')

    const child = logger.child({ module: 'OrderService' })
    child.info('child log')

    expect(channel.entries[0].module).toBe('OrderService')
    expect(channel.entries[0].correlationId).toBe('parent-id')
  })

  it('child logger can override correlation ID', () => {
    const channel = new TestChannel()
    const logger = new Logger({ level: 'info', channels: [channel] })

    const child = logger.child({ module: 'test', correlationId: 'child-id' })
    child.info('test')

    expect(channel.entries[0].correlationId).toBe('child-id')
  })
})

describe('logger > per-module level override', () => {
  it('respects module-specific log level', () => {
    const channel = new TestChannel()
    const logger = new Logger({
      level: 'info',
      channels: [channel],
      modules: { 'bus:rust': 'warn' }, // Only warn+ for bus:rust
    })

    const busLogger = logger.child({ module: 'bus:rust' })
    busLogger.info('should not appear')
    busLogger.warn('should appear')

    expect(channel.entries.length).toBe(1)
    expect(channel.entries[0].level).toBe('warn')
  })
})

describe('logger > multiple channels', () => {
  it('writes to all channels', () => {
    const ch1 = new TestChannel()
    const ch2 = new TestChannel()
    const logger = new Logger({ level: 'info', channels: [ch1, ch2] })

    logger.info('test')

    expect(ch1.entries.length).toBe(1)
    expect(ch2.entries.length).toBe(1)
  })
})

describe('logger > ConsoleChannel', () => {
  it('creates without error', () => {
    const channel = new ConsoleChannel('json')
    expect(channel.name).toBe('console')
  })

  it('pretty format creates without error', () => {
    const channel = new ConsoleChannel('pretty')
    expect(channel.name).toBe('console')
  })
})
