/**
 * @module
 * One sentence per mutation the tests did not notice, saying what changed and
 * where to look. It describes what the tests that ran did; it never says the
 * code is wrong or untested.
 */

export interface Mutation {
	mutator: string;
	/** The source text the mutation replaced. */
	original: string;
	replacement: string;
}

const BOUNDARY: Readonly<Record<string, string>> = {
	">=": ">",
	">": ">=",
	"<=": "<",
	"<": "<=",
};

/** Long operands make a worse hint than none. */
const MAX_OPERAND = 40;

interface OperatorChange {
	left: string;
	from: string;
	to: string;
	right: string;
}

/**
 * The operator a binary mutation swapped, and the operands around it, read
 * from the original text. The replacement is printed by the engine and may be
 * spaced differently, so the two are compared with whitespace removed.
 */
export function operatorChange(
	original: string,
	replacement: string,
): OperatorChange | null {
	const a = original.replace(/\s+/g, "");
	const b = replacement.replace(/\s+/g, "");
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}
	// `>` to `>=` shares its first character, so widen the middle back to
	// cover the whole operator on both sides.
	while (prefix > 0 && /[<>=!&|?]/.test(a[prefix - 1] ?? "")) prefix--;
	while (suffix > 0 && /[<>=!&|?]/.test(a[a.length - suffix] ?? "")) suffix--;
	const from = a.slice(prefix, a.length - suffix);
	const to = b.slice(prefix, b.length - suffix);
	if (!/^[<>=!&|?+\-*/%]+$/.test(from) || !/^[<>=!&|?+\-*/%]+$/.test(to)) {
		return null;
	}
	// Map the prefix length back onto the original text, spaces included.
	let seen = 0;
	let index = 0;
	while (index < original.length && seen < prefix) {
		if (!/\s/.test(original[index] ?? "")) seen++;
		index++;
	}
	const left = original.slice(0, index).trim();
	const rest = original.slice(index).trimStart();
	const right = rest.slice(from.length).trim();
	return { left, from, to, right };
}

function code(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function explainSurvivor(mutation: Mutation): string {
	const { mutator, original, replacement } = mutation;
	const change = operatorChange(original, replacement);

	if (mutator === "EqualityOperator" && change !== null) {
		const head = `Changing ${change.from} to ${change.to} went undetected.`;
		if (BOUNDARY[change.from] === change.to) {
			return change.left.length <= MAX_OPERAND &&
				change.right.length <= MAX_OPERAND
				? `${head} Review the behavior at ${code(change.left)} = ${code(change.right)}.`
				: `${head} Review the behavior where both sides are equal.`;
		}
		return `${head} The tests that ran passed with the comparison inverted: review a case on each side of ${code(original)}.`;
	}
	if (
		mutator === "ConditionalExpression" &&
		/^(true|false)$/.test(replacement)
	) {
		const other = replacement === "true" ? "false" : "true";
		return `Replacing the condition ${code(original)} with ${replacement} went undetected. The tests that ran passed as if it were always ${replacement}: review a case where it is ${other}.`;
	}
	if (mutator === "LogicalOperator" && change !== null) {
		return `Changing ${change.from} to ${change.to} went undetected. Review a case where only one side of ${code(original)} holds.`;
	}
	if (mutator === "BooleanLiteral") {
		if (/^!/.test(original.trim()) && !/^!/.test(replacement.trim())) {
			return `Removing the ! from ${code(original)} went undetected.`;
		}
		return `Changing ${code(original)} to ${code(replacement)} went undetected.`;
	}
	if (mutator === "ArithmeticOperator" && change !== null) {
		return `Changing ${change.from} to ${change.to} went undetected. The tests that ran did not tell ${code(original)} from ${code(replacement)}.`;
	}
	return `Replacing ${code(original)} with ${code(replacement)} went undetected.`;
}
