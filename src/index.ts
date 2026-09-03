/**
 * @module @c9up/spectrum
 * @description Spectrum — structured logging for the Ream framework
 * @implements FR54, FR55, FR56, FR57, FR58
 */

import "./augmentations.js";

export { ConsoleChannel } from "./channels/ConsoleChannel.js";
export { FileChannel } from "./channels/FileChannel.js";
export { defineConfig } from "./config.js";
export { configure } from "./configure.js";
export { Logger, type LogLevel } from "./Logger.js";
export { LoggerManager } from "./LoggerManager.js";
export { createRustLogBridge, parseRustLog } from "./RustLogBridge.js";
export type {
	FileTargetOptions,
	PrettyTargetOptions,
	TransportTargetOptions,
} from "./targets.js";
export { channelsFromTargets, Targets, targets } from "./targets.js";
export {
	isLogLevelWithSilent,
	type LogChannel,
	type LogConfig,
	type LogEntry,
	type LoggerManagerConfig,
	type LogLevelWithSilent,
	type LogSerializer,
	logEntryExtras,
	logLevel,
	type RedactOptions,
} from "./types.js";
