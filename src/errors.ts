/**
 * Spectrum errors, one class per code. An application branches on
 * `error.code` or on `error instanceof errors.E_…`; every one is a flare
 * `Exception`, with the HTTP status an exception handler answers with.
 */

import { createError } from "@c9up/flare";

/** A configured level, a target level or `logLevel()` input is not a level. */
export const E_SPECTRUM_UNKNOWN_LEVEL = createError<[string, string, string]>(
	"[spectrum] %s level %s. Use one of: %s.",
	"E_SPECTRUM_UNKNOWN_LEVEL",
);

/** A transport target or destination spectrum cannot build. */
export const E_SPECTRUM_UNSUPPORTED_TARGET = createError<[string]>(
	"[spectrum] %s",
	"E_SPECTRUM_UNSUPPORTED_TARGET",
);

/** A file destination's options are invalid. */
export const E_SPECTRUM_INVALID_FILE_OPTIONS = createError<[string]>(
	"[spectrum] %s",
	"E_SPECTRUM_INVALID_FILE_OPTIONS",
);

/** `messageKey`, `timestamp`, `base` or `formatters` is invalid. */
export const E_SPECTRUM_INVALID_LINE_OPTIONS = createError<[string]>(
	"[spectrum] %s",
	"E_SPECTRUM_INVALID_LINE_OPTIONS",
);

/** A `redact` path cannot be parsed. */
export const E_SPECTRUM_INVALID_REDACT_PATH = createError<[string]>(
	"[spectrum] %s",
	"E_SPECTRUM_INVALID_REDACT_PATH",
);

/** `depthLimit` or `edgeLimit` is not a positive integer. */
export const E_SPECTRUM_INVALID_STRINGIFY_LIMIT = createError<
	[string, unknown]
>(
	"[spectrum] %s must be a positive integer, got %s",
	"E_SPECTRUM_INVALID_STRINGIFY_LIMIT",
);

/** The config sets an option spectrum does not support. */
export const E_SPECTRUM_UNSUPPORTED_OPTION = createError<[string]>(
	'[spectrum] the "%s" logger option is not supported',
	"E_SPECTRUM_UNSUPPORTED_OPTION",
);

/** At boot, the container resolves something other than a `Logger`. */
export const E_SPECTRUM_LOGGER_NOT_BOUND = createError(
	"[spectrum] the container resolved something other than a Logger for the Logger token",
	"E_SPECTRUM_LOGGER_NOT_BOUND",
);

/** A multi-logger config names no `default` logger. */
export const E_SPECTRUM_MISSING_DEFAULT_LOGGER = createError(
	'[spectrum] Missing "default" property in logger config',
	"E_SPECTRUM_MISSING_DEFAULT_LOGGER",
);

/** The `default` logger is not declared in `loggers`. */
export const E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER = createError<[string]>(
	"[spectrum] %s",
	"E_SPECTRUM_UNKNOWN_DEFAULT_LOGGER",
);

/** `logger.use(name)` names a logger that is not in `loggers`. */
export const E_SPECTRUM_UNKNOWN_LOGGER = createError<[string, string]>(
	'[spectrum] Unknown logger "%s". Registered: %s',
	"E_SPECTRUM_UNKNOWN_LOGGER",
);

/** The `services/main` logger was used before `SpectrumProvider` booted. */
export const E_SPECTRUM_NOT_BOOTED = createError(
	"[spectrum] Logger singleton accessed before SpectrumProvider.boot() ran. " +
		"Check that `@c9up/spectrum/provider` is listed in your reamrc.ts providers.",
	"E_SPECTRUM_NOT_BOOTED",
);

/** A `FakeLogger` assertion failed. */
export const E_SPECTRUM_ASSERTION_FAILED = createError<[string]>(
	"[spectrum] %s",
	"E_SPECTRUM_ASSERTION_FAILED",
);

/** A `FakeLogger` assertion got an empty `containing`. */
export const E_SPECTRUM_INVALID_PREDICATE = createError(
	"[spectrum] FakeLogger: `containing` predicate cannot be an empty string — it would match every captured message.",
	"E_SPECTRUM_INVALID_PREDICATE",
);
