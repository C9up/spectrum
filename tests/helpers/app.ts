import { Logger } from "../../src/Logger.js";
import type { SpectrumAppContext } from "../../src/SpectrumProvider.js";

/**
 * The slice of an application the provider reads: a container that builds
 * each binding once, and a config store answering `logger`.
 *
 * `bound` seeds the container with values already built (an `events`
 * emitter, for instance).
 */
export function makeApp(
	loggerConfig?: unknown,
	bound: ReadonlyMap<unknown, unknown> = new Map(),
): SpectrumAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>(bound);
	return {
		container: {
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			async resolve(token) {
				if (cache.has(token)) return cache.get(token);
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = await factory();
				cache.set(token, value);
				return value;
			},
		},
		config: {
			get: (key) => (key === "logger" ? loggerConfig : undefined),
		},
	};
}

/** The logger the provider bound, checked rather than asserted. */
export async function resolveLogger(app: SpectrumAppContext): Promise<Logger> {
	const value = await app.container.resolve(Logger);
	if (!(value instanceof Logger)) throw new Error("no Logger bound");
	return value;
}
