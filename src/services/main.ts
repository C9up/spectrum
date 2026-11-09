/**
 * Default `Logger` singleton — mirror of Adonis's
 * `import logger from '@adonisjs/core/services/logger'` shape.
 *
 *   import logger from '@c9up/spectrum/services/main'
 *
 *   logger.info('user logged in', { userId })   // message-first; data + `err` serialized
 *
 * Populated by `SpectrumProvider.boot()`.
 */

import type { Logger } from "../Logger.js";

let instance: Logger | undefined;

/** @internal Bind the singleton (called by SpectrumProvider). */
export function setLogger(value: Logger): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getLogger(): Logger | undefined {
	return instance;
}

/**
 * @internal Release the singleton, so a shut-down application does not leave a
 * dead logger reachable through `services/main`.
 *
 * The caller checks ownership first (`getLogger() === mine`): two applications
 * share this module in one process, and the one shutting down must not clear
 * what the other has since bound.
 */
export function clearLogger(): void {
	instance = undefined;
}

/** What the proxy stands on: nothing of its own, every read is trapped. */
const target: Logger = Object.create(null);

const logger: Logger = new Proxy(target, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it reads
		// `then` to decide whether the namespace is thenable, and various symbols
		// for interop and formatting. Throwing on those turns a plain
		// `import { setLogger } from '.../services/main'` into a crash at import
		// time, far from any real use. They are not logger members, so answer
		// undefined and let a genuine access be the one that reports.
		if (typeof prop === "symbol" || prop === "then") {
			return undefined;
		}
		if (!instance) {
			throw new Error(
				"[spectrum] Logger singleton accessed before SpectrumProvider.boot() ran. " +
					"Check that `@c9up/spectrum/provider` is listed in your reamrc.ts providers.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default logger;
