/**
 * Log observability — spectrum's equivalent of atlas's `onDbQuery`.
 *
 * Agnostic by design: spectrum cannot import the framework's emitter (it is a
 * standalone package), so it owns a tiny listener registry instead. An
 * integration bridges it to whatever emitter the app uses:
 *
 *     onLog((entry) => emitter.emit('log:line', entry))
 *
 * `SpectrumProvider` does exactly that when the container has an `events`
 * binding, which is what feeds the debug toolbar's log panel.
 *
 * Emission is opt-in in the only sense that matters: with nobody listening it
 * is one `Set.size` check per written line, after the level threshold has
 * already discarded everything below it.
 */

import type { LogEntry } from "./types.js";

export type LogListener = (entry: LogEntry) => void;

const listeners = new Set<LogListener>();

/**
 * Subscribe to every written line. Returns an unsubscribe function.
 *
 * The entry has already been through the serializers and the redaction rules,
 * so a listener sees what a channel sees — never the raw bag.
 */
export function onLog(listener: LogListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Remove every listener. Intended for test teardown. */
export function clearLogListeners(): void {
	listeners.clear();
}

/** Whether anyone is listening. Checked before building anything for them. */
export function hasLogListeners(): boolean {
	return listeners.size > 0;
}

/**
 * Emit to every listener. Package-internal.
 *
 * A listener that throws would otherwise take down the line that triggered it,
 * so throws are swallowed — observability must never change behaviour, least
 * of all the behaviour of writing a log.
 */
export function emitLog(entry: LogEntry): void {
	for (const listener of listeners) {
		try {
			listener(entry);
		} catch {
			// A broken observer costs its own line, nothing more.
		}
	}
}
