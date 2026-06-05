import { ConsoleChannel } from "./channels/ConsoleChannel.js";
import { Logger } from "./Logger.js";
import { _setLogger } from "./services/main.js";
import type { LogLevel } from "./types.js";
import { LOG_LEVEL_ORDER } from "./types.js";

const VALID_LEVELS = new Set<string>(Object.keys(LOG_LEVEL_ORDER));

function resolveLogLevel(raw: string | undefined): LogLevel {
	if (raw && VALID_LEVELS.has(raw)) return raw as LogLevel;
	return "info";
}

interface SpectrumContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): T;
}

interface SpectrumConfigStore {
	get<T = unknown>(key: string): T | undefined;
}

export interface SpectrumAppContext {
	container: SpectrumContainer;
	config: SpectrumConfigStore;
}

export default class SpectrumProvider {
	constructor(protected app: SpectrumAppContext) {}

	register() {
		this.app.container.singleton(Logger, () => {
			const config = this.app.config.get<{ level?: LogLevel }>("logger");
			const level =
				config?.level && VALID_LEVELS.has(config.level)
					? config.level
					: resolveLogLevel(process.env.LOG_LEVEL);
			return new Logger({
				level,
				channels: [new ConsoleChannel("pretty")],
			});
		});

		this.app.container.singleton("logger", () => {
			return this.app.container.resolve<Logger>(Logger);
		});
	}

	async boot() {
		_setLogger(this.app.container.resolve<Logger>(Logger));
	}
}
