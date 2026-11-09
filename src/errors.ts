/**
 * A spectrum configuration or usage error, carrying an `E_SPECTRUM_*` code an
 * application can filter on.
 */
export class SpectrumError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`[spectrum] ${message}`);
		this.name = "SpectrumError";
		this.code = code;
	}
}
