/**
 * Rust Log Bridge — unifies Rust stderr output with Spectrum log entries.
 *
 * Captures Rust log output (which goes to stderr) and re-emits it
 * through the Spectrum Logger so both Rust and TS logs appear in
 * the same stream with the same format.
 *
 * @implements FR55
 */

import type { LogChannel, LogEntry, LogLevel } from "./types.js";

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
 * Create a bridge that captures stderr and routes Rust logs to Spectrum channels.
 *
 * Usage — pass the same channels array you built the Logger with (Logger.config
 * is private, so reuse the array rather than reaching into the instance):
 *   const channels = [new ConsoleChannel('pretty')]
 *   const logger = new Logger({ level: 'info', channels })
 *   const bridge = createRustLogBridge(channels)
 *   bridge.start()
 *   // ... Rust crates emit to stderr
 *   bridge.stop()
 */
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

export function createRustLogBridge(channels: LogChannel[]): {
	start: () => void;
	stop: () => void;
} {
	let bridgingDepth = 0;

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
				// Rebuild passthrough as one byte-faithful string instead of
				// re-emitting each line with an appended "\n". split("\n") drops
				// the separator, so every segment except a trailing fragment (the
				// chunk didn't end in "\n") was newline-terminated originally —
				// reattach accordingly. This preserves blank lines and a partial
				// no-newline trailing write verbatim, and keeps passthrough lines
				// in their original order.
				let passthrough = "";
				const segments = str.split("\n");
				for (let i = 0; i < segments.length; i++) {
					const seg = segments[i] ?? "";
					const isTrailingFragment = i === segments.length - 1;
					const original = isTrailingFragment ? seg : `${seg}\n`;
					const trimmed = seg.trim();
					// Only a complete, non-empty line is a Rust-log candidate. A
					// trailing fragment is a partial write — never parse or drop it.
					const entry =
						trimmed && !isTrailingFragment ? parseRustLog(trimmed) : null;
					if (entry) {
						hadRustLog = true;
						for (const channel of channels) {
							bridgingDepth++;
							try {
								channel.write(entry);
							} catch {
								/* ignore */
							} finally {
								bridgingDepth--;
							}
						}
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
