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

const logger: Logger = new Proxy({} as Logger, {
	get(_target, prop) {
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
