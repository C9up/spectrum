/**
 * printf interpolation of a log message, with upstream's rules.
 *
 * Node's `util.format` is not what upstream runs, and the difference is a
 * leak: it inspects an object for `%s`, `%o` and `%O` with no redaction, knows
 * `%c` (which swallows an argument), and appends every argument no token took
 * to the end of the message. A message that carries request data then decides,
 * by its content, what of the remaining arguments ends up in clear in `msg`.
 *
 * These are the rules of the formatter upstream uses: `%s` is `String(value)`,
 * `%d` / `%f` a number, `%i` an integer, `%%` a percent sign that consumes
 * nothing, `%j` / `%o` / `%O` the value through `stringify` — which the logger
 * hands in already serialised and redacted — and an argument no token takes
 * is dropped. Any other `%x` is left as written.
 */

/** Turns a value interpolated by `%j`, `%o` or `%O` into text. */
export type InterpolationStringify = (value: unknown) => string;

const PERCENT = 37;
const LOWER_D = 100;
const LOWER_F = 102;
const LOWER_I = 105;
const LOWER_J = 106;
const LOWER_O = 111;
const UPPER_O = 79;
const LOWER_S = 115;

/** `String(value)`, without letting a throwing `toString` take the line down. */
function asText(value: unknown): string {
	try {
		return String(value);
	} catch {
		return "[unprintable]";
	}
}

/** `Number(value)`, which throws on a symbol or an object without a primitive. */
function asNumber(value: unknown, integer: boolean): string {
	try {
		const number = Number(value);
		return String(integer ? Math.floor(number) : number);
	} catch {
		return "NaN";
	}
}

/**
 * The message with its tokens replaced by `args`. Without arguments the
 * template is returned as written, `%%` included.
 */
export function formatMessage(
	template: string,
	args: readonly unknown[],
	stringify: InterpolationStringify,
): string {
	if (args.length === 0) return template;
	let out = "";
	let argIndex = 0;
	let lastPos = -1;
	const length = template.length;
	for (let i = 0; i < length; i++) {
		if (template.charCodeAt(i) !== PERCENT || i + 1 >= length) continue;
		lastPos = lastPos > -1 ? lastPos : 0;
		const arg = args[argIndex];
		const available = argIndex < args.length;
		let replacement: string | undefined;
		switch (template.charCodeAt(i + 1)) {
			case LOWER_D:
			case LOWER_F:
				if (available && arg != null) replacement = asNumber(arg, false);
				break;
			case LOWER_I:
				if (available && arg != null) replacement = asNumber(arg, true);
				break;
			case LOWER_J:
			case LOWER_O:
			case UPPER_O:
				if (!available || arg === undefined) break;
				if (typeof arg === "string") replacement = `'${arg}'`;
				else if (typeof arg === "function") {
					replacement = arg.name || "<anonymous>";
				} else replacement = stringify(arg);
				break;
			case LOWER_S:
				if (available) replacement = asText(arg);
				break;
			case PERCENT:
				replacement = "%";
				// A literal percent takes no argument.
				argIndex--;
				break;
		}
		if (replacement !== undefined) {
			if (lastPos < i) out += template.slice(lastPos, i);
			out += replacement;
			lastPos = i + 2;
			i++;
		}
		argIndex++;
	}
	if (lastPos === -1) return template;
	if (lastPos < length) out += template.slice(lastPos);
	return out;
}
