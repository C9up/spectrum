/**
 * Teach ream's `ContainerBindings` what `container.make('logger')` returns.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the one it owns — the comment on the
 * interface names `logger` (spectrum) as exactly this. Nothing filled it in,
 * so resolving by the string token answered `unknown` and every call site had
 * to assert a type it could not prove.
 *
 * Loaded from the package barrel and from the provider, so registering
 * spectrum is enough — an application writes no `declare module` of its own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";
import type { Logger } from "./Logger.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The logger, bound by `SpectrumProvider`. */
		"spectrum.logger": Logger;
		/**
		 * The same binding under the name it had before the token carried its
		 * package. Kept bound so an existing `container.make(...)` resolves.
		 */
		logger: Logger;
	}
}
