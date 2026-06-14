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

	const level = levelMap[match[1].toUpperCase()];
	if (!level) return null;

	return {
		level,
		message: match[3],
		module: match[2].replace(/_/g, "-"),
		timestamp: new Date().toISOString(),
	};
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
let activeOriginalWrite: typeof process.stderr.write | undefined;
let activeBridge: { stop: () => void } | undefined;

export function createRustLogBridge(channels: LogChannel[]): {
	start: () => void;
	stop: () => void;
} {
	let bridgingDepth = 0;

	const bridge = {
		start() {
			if (activeBridge === bridge) return;
			if (activeBridge) {
				const prev = activeOriginalWrite;
				activeBridge.stop();
				if (prev) {
					process.stderr.write = prev as typeof process.stderr.write;
					prev(
						"[Spectrum] RustLogBridge replaced — previous bridge stopped. Only one bridge can be active per process.\n" as never,
					);
				}
			}

			activeOriginalWrite = process.stderr.write.bind(process.stderr);
			activeBridge = bridge;

			process.stderr.write = ((
				chunk: string | Uint8Array,
				...args: unknown[]
			) => {
				const origWrite = activeOriginalWrite;
				if (!origWrite) return true;
				if (bridgingDepth > 0) {
					return origWrite(chunk as never, ...(args as []));
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
					return origWrite(chunk as never, ...(args as []));
				}

				if (passthrough) {
					origWrite(passthrough);
				}

				return true;
			}) as typeof process.stderr.write;
		},

		stop() {
			if (activeBridge !== bridge) return;
			if (activeOriginalWrite) {
				process.stderr.write =
					activeOriginalWrite as typeof process.stderr.write;
				activeOriginalWrite = undefined;
			}
			activeBridge = undefined;
		},
	};

	return bridge;
}
