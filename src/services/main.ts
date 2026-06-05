/**
 * Default `Logger` singleton — mirror of Adonis's
 * `import logger from '@adonisjs/core/services/logger'` shape.
 *
 *   import logger from '@c9up/spectrum/services/main'
 *
 *   logger.info({ userId }, 'user logged in')
 *
 * Populated by `SpectrumProvider.boot()`.
 */

import type { Logger } from "../Logger.js";

let _instance: Logger | undefined;

/** @internal Bind the singleton (called by SpectrumProvider). */
export function _setLogger(instance: Logger): void {
	_instance = instance;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getLogger(): Logger | undefined {
	return _instance;
}

const logger: Logger = new Proxy({} as Logger, {
	get(_target, prop) {
		if (!_instance) {
			throw new Error(
				"[spectrum] Logger singleton accessed before SpectrumProvider.boot() ran. " +
					"Check that `@c9up/spectrum/provider` is listed in your reamrc.ts providers.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default logger;
