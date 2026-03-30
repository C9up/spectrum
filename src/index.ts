/**
 * @module @c9up/spectrum
 * @description Spectrum — structured logging for the Ream framework
 * @implements FR54, FR55, FR56, FR57, FR58
 */

export { Logger, type LogLevel } from './Logger.js'
export { type LogChannel, type LogEntry, type LogConfig } from './types.js'
export { ConsoleChannel } from './channels/ConsoleChannel.js'
