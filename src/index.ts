/**
 * @module @c9up/spectrum
 * @description Spectrum — structured logging for the Ream framework
 * @implements FR54, FR55, FR56, FR57, FR58
 */

export { ConsoleChannel } from "./channels/ConsoleChannel.js";
export { FileChannel } from "./channels/FileChannel.js";
export { defineConfig } from "./config.js";
export { configure } from "./configure.js";
export { Logger, type LogLevel } from "./Logger.js";
export { createRustLogBridge, parseRustLog } from "./RustLogBridge.js";
export type { LogChannel, LogConfig, LogEntry } from "./types.js";
