/**
 * Rust Log Bridge — unifies Rust stderr output with Spectrum log entries.
 *
 * Captures Rust log output (which goes to stderr) and re-emits it
 * through the Spectrum Logger so both Rust and TS logs appear in
 * the same stream with the same format.
 *
 * Every stderr write in the process goes through the bridge, not only the
 * Rust crates' — `console.error`, a child process, a library echoing request
 * data. So a line is claimed only when its module is on an allow-list
 * (`ream-*` by default), it is written through the Logger (its level,
 * `enabled`, serializers and redaction apply) and it carries
 * `source: 'rust'`. Before that, any `[FATAL anything] text` that reached
 * stderr became a genuine-looking structured entry.
 *
 * @implements FR55
 */

import type { Logger } from "./Logger.js";
import type { LogEntry, LogLevel } from "./types.js";

export interface RustLogBridgeOptions {
	/**
	 * Modules (after `_` → `-`) the bridge claims. Anything else passes
	 * through to stderr as text. Default `/^ream-/`.
	 */
	modules?: RegExp;
}

const DEFAULT_MODULES = /^ream-/;

/**
 * Parse a Rust log line into a Spectrum LogEntry.
 * Supports common Rust log formats:
 *   [INFO ream_http] Server listening on 0.0.0.0:3000
 *   [WARN ream_bus] Slow dispatch: 5ms
 */
export function parseRustLog(line: string): LogEntry | null {
	// Pattern: [LEVEL module] message
	const match = line.match(/^\[(\w+)\s+(\S+)\]\s+(.+)$/);
	if (!match) return null;

	const levelMap: Record<string, LogLevel> = {
		TRACE: "trace",
		DEBUG: "debug",
		INFO: "info",
		WARN: "warn",
		ERROR: "error",
		FATAL: "fatal",
	};

	// All three groups are required by the pattern, so a match carries them.
	const [, rawLevel, rawModule, rawMessage] = match;
	if (
		rawLevel === undefined ||
		rawModule === undefined ||
		rawMessage === undefined
	) {
		return null;
	}
	const level = levelMap[rawLevel.toUpperCase()];
	if (!level) return null;

	return {
		level,
		message: rawMessage,
		module: rawModule.replace(/_/g, "-"),
		timestamp: new Date().toISOString(),
	};
}

/**
 * `process.stderr.write` exactly as it was found, so `stop()` puts THAT back.
 *
 * Storing a bound copy instead meant every start wrapped the previous stop's
 * restoration in one more `bind`, so a process that started and stopped the
 * bridge repeatedly grew a chain of wrappers around its own stderr.
 */
let activeOriginalWrite: typeof process.stderr.write | undefined;
let activeBridge: { stop: () => void } | undefined;

/** The flush callback `stream.write(chunk, encoding?, callback?)` may carry. */
type WriteCallback = (error?: Error | null) => void;

function isWriteCallback(value: unknown): value is WriteCallback {
	return typeof value === "function";
}

const BUFFER_ENCODINGS = new Set<string>([
	"ascii",
	"utf8",
	"utf-8",
	"utf16le",
	"utf-16le",
	"ucs2",
	"ucs-2",
	"base64",
	"base64url",
	"latin1",
	"binary",
	"hex",
]);

function isBufferEncoding(value: unknown): value is BufferEncoding {
	return typeof value === "string" && BUFFER_ENCODINGS.has(value);
}

/**
 * Hand a chunk to the real `process.stderr.write`, callback included.
 *
 * The callback is the whole point of the indirection. It is the stream's
 * promise that the chunk is out, and callers wait on it; a bridge that returns
 * `true` without ever calling it leaves them waiting forever.
 */
function passThrough(
	write: typeof process.stderr.write,
	chunk: string | Uint8Array,
	encoding: BufferEncoding | undefined,
	done: WriteCallback | undefined,
): boolean {
	// `encoding` stays in its own position even when absent: Node reads an
	// `undefined` encoding as "the stream's default", and passing it keeps the
	// callback in the slot the three-argument form expects.
	return write.call(process.stderr, chunk, encoding, done);
}

/**
 * Create a bridge that captures stderr and routes Rust logs through `logger`.
 *
 *   const logger = new Logger({ level: 'info', channels: [new ConsoleChannel('pretty')] })
 *   const bridge = createRustLogBridge(logger)
 *   bridge.start()
 *   // ... Rust crates emit to stderr
 *   bridge.stop()
 */
export function createRustLogBridge(
	logger: Logger,
	options: RustLogBridgeOptions = {},
): {
	start: () => void;
	stop: () => void;
} {
	const modules = options.modules ?? DEFAULT_MODULES;
	let bridgingDepth = 0;

	/** A claimed line, through the logger, its own writes passed straight on. */
	const emit = (entry: LogEntry): void => {
		bridgingDepth++;
		try {
			logger
				.child({ module: entry.module, source: "rust" })
				.log(entry.level, entry.message);
		} catch {
			// The bridge must never break a stderr write.
		} finally {
			bridgingDepth--;
		}
	};

	const bridge = {
		start() {
			if (activeBridge === bridge) return;
			if (activeBridge) {
				// `stop()` has already restored it; say so through the restored
				// write rather than through the one about to be installed.
				activeBridge.stop();
				process.stderr.write(
					"[Spectrum] RustLogBridge replaced — previous bridge stopped. Only one bridge can be active per process.\n",
				);
			}

			activeOriginalWrite = process.stderr.write;
			activeBridge = bridge;

			// Written in the shape the stream's own `write` is declared in, so it
			// can be installed without asserting that it fits.
			process.stderr.write = (
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | WriteCallback,
				callback?: WriteCallback,
			): boolean => {
				const origWrite = activeOriginalWrite;
				if (!origWrite) return true;
				const encoding = isBufferEncoding(encodingOrCallback)
					? encodingOrCallback
					: undefined;
				// `write(chunk, callback)` puts the callback where the encoding
				// would be.
				const done = isWriteCallback(callback)
					? callback
					: isWriteCallback(encodingOrCallback)
						? encodingOrCallback
						: undefined;
				if (bridgingDepth > 0) {
					return passThrough(origWrite, chunk, encoding, done);
				}

				const str =
					typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				let hadRustLog = false;
				// Rebuild passthrough byte-faithfully: split("\n") drops the
				// separator, so every segment except a trailing fragment (the
				// chunk didn't end in "\n") was newline-terminated originally —
				// reattach accordingly. Text ahead of a claimed line is written
				// before it, so the order a reader sees is the order written.
				let passthrough = "";
				const segments = str.split("\n");
				for (let i = 0; i < segments.length; i++) {
					const seg = segments[i] ?? "";
					const isTrailingFragment = i === segments.length - 1;
					const original = isTrailingFragment ? seg : `${seg}\n`;
					const trimmed = seg.trim();
					// Only a complete, non-empty line is a Rust-log candidate. A
					// trailing fragment is a partial write — never parse or drop it.
					const parsed =
						trimmed && !isTrailingFragment ? parseRustLog(trimmed) : null;
					const entry =
						parsed !== null && modules.test(parsed.module) ? parsed : null;
					if (entry) {
						hadRustLog = true;
						if (passthrough) {
							passThrough(origWrite, passthrough, undefined, undefined);
							passthrough = "";
						}
						emit(entry);
					} else {
						passthrough += original;
					}
				}

				// Preserve original chunk when we didn't intercept any Rust logs.
				if (!hadRustLog) {
					return passThrough(origWrite, chunk, encoding, done);
				}

				// Something was consumed, so the chunk cannot go out verbatim.
				// What is left still carries the caller's callback; when nothing
				// is left, it is called here rather than dropped.
				if (passthrough) {
					return passThrough(origWrite, passthrough, undefined, done);
				}
				done?.();

				return true;
			};
		},

		stop() {
			if (activeBridge !== bridge) return;
			if (activeOriginalWrite) {
				process.stderr.write = activeOriginalWrite;
				activeOriginalWrite = undefined;
			}
			activeBridge = undefined;
		},
	};

	return bridge;
}
