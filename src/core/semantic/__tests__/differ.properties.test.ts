/**
 * Classifier properties over generated TypeScript files. Each case builds a
 * random module from a small grammar, applies one kind of edit, and checks
 * the class the edit must produce. A failure prints its seed and both
 * versions of the file.
 */

import { describe, expect, it } from "vitest";
import type { Random } from "../../../__tests__/helpers/seeded-random.js";
import {
	seededRandom,
	seeds,
} from "../../../__tests__/helpers/seeded-random.js";
import type { ClassifyResult } from "../differ.js";
import { createClassifier } from "../differ.js";

const CASES = 100;

type Type = "number" | "string" | "boolean";
const TYPES: readonly Type[] = ["number", "string", "boolean"];

interface Param {
	name: string;
	type: Type;
}

interface Fn {
	exported: boolean;
	name: string;
	params: Param[];
	returns: Type;
	value: string;
	padded: boolean;
}

interface Iface {
	name: string;
	fields: Param[];
}

interface Module {
	functions: Fn[];
	interfaces: Iface[];
}

function literal(random: Random, type: Type): string {
	switch (type) {
		case "number":
			return String(random.int(0, 99));
		case "string":
			return `"s${random.int(0, 99)}"`;
		case "boolean":
			return random.pick(["true", "false"]);
	}
}

function otherType(random: Random, type: Type): Type {
	return random.pick(TYPES.filter((t) => t !== type));
}

function params(random: Random, prefix: string): Param[] {
	return Array.from({ length: random.int(0, 3) }, (_, i) => ({
		name: `${prefix}${i}`,
		type: random.pick(TYPES),
	}));
}

function generateModule(random: Random): Module {
	const functions: Fn[] = Array.from({ length: random.int(1, 3) }, (_, i) => {
		const returns = random.pick(TYPES);
		return {
			exported: true,
			name: `fn${i}`,
			params: params(random, "a"),
			returns,
			value: literal(random, returns),
			padded: random.chance(0.3),
		};
	});
	if (random.chance(0.5)) {
		const returns = random.pick(TYPES);
		functions.push({
			exported: false,
			name: "helper",
			params: params(random, "h"),
			returns,
			value: literal(random, returns),
			padded: false,
		});
	}
	const interfaces: Iface[] = random.chance(0.5)
		? [{ name: "Shape", fields: params(random, "f") }]
		: [];
	return { functions: random.shuffle(functions), interfaces };
}

function functionTokens(fn: Fn): string[] {
	const signature = fn.params.flatMap((p, i) => [
		...(i > 0 ? [","] : []),
		p.name,
		":",
		p.type,
	]);
	return [
		...(fn.exported ? ["export"] : []),
		"function",
		fn.name,
		"(",
		...signature,
		")",
		":",
		fn.returns,
		"{",
		...(fn.padded ? ["const", "pad", "=", "0", ";"] : []),
		"const",
		"v",
		":",
		fn.returns,
		"=",
		fn.value,
		";",
		"return",
		"v",
		";",
		"}",
	];
}

function interfaceTokens(iface: Iface): string[] {
	return [
		"export",
		"interface",
		iface.name,
		"{",
		...iface.fields.flatMap((f) => [f.name, ":", f.type, ";"]),
		"}",
	];
}

function tokensOf(module: Module): string[] {
	return [
		...module.interfaces.flatMap(interfaceTokens),
		...module.functions.flatMap(functionTokens),
	];
}

/**
 * Trivia that may stand between two tokens. A line break after `return` or
 * `interface` changes the parse (automatic semicolon insertion), so those
 * positions only take trivia without one.
 */
const TRIVIA = [
	"  ",
	"\t",
	"\n",
	"\n\n\t",
	" /* note */ ",
	"/* two\nlines */",
	" // note\n",
];
const SAME_LINE_TRIVIA = TRIVIA.filter((t) => !t.includes("\n"));
const NO_LINE_BREAK_AFTER = new Set(["return", "interface"]);

function render(tokens: readonly string[], random?: Random): string {
	let out = "";
	tokens.forEach((token, i) => {
		if (i > 0) {
			const previous = tokens[i - 1] ?? "";
			out +=
				random?.chance(0.3) === true
					? random.pick(
							NO_LINE_BREAK_AFTER.has(previous) ? SAME_LINE_TRIVIA : TRIVIA,
						)
					: " ";
		}
		out += token;
	});
	return out;
}

function exportedFunctions(module: Module): Fn[] {
	return module.functions.filter((fn) => fn.exported);
}

function withFunction(module: Module, name: string, edit: Fn): Module {
	return {
		...module,
		functions: module.functions.map((fn) => (fn.name === name ? edit : fn)),
	};
}

/** An edit to the public shape of one function; the body may follow along. */
function changeSignature(random: Random, fn: Fn): Fn {
	const edits: (() => Fn)[] = [
		() => ({
			...fn,
			params: [...fn.params, { name: "extra", type: random.pick(TYPES) }],
		}),
		() => {
			const returns = otherType(random, fn.returns);
			return { ...fn, returns, value: literal(random, returns) };
		},
	];
	if (fn.params.length > 0) {
		const index = random.int(0, fn.params.length - 1);
		edits.push(
			() => ({
				...fn,
				params: fn.params.filter((_, i) => i !== index),
			}),
			() => ({
				...fn,
				params: fn.params.map((p, i) =>
					i === index ? { ...p, type: otherType(random, p.type) } : p,
				),
			}),
		);
	}
	return random.pick(edits)();
}

/** An edit to the implementation only; the public shape is unchanged. */
function changeBody(random: Random, fn: Fn): Fn {
	if (random.chance(0.5)) return { ...fn, padded: !fn.padded };
	let value = fn.value;
	while (value === fn.value) value = literal(random, fn.returns);
	return { ...fn, value };
}

function describeCase(seed: number, before: string, after: string): string {
	return `seed ${seed}\n--- before\n${before}\n--- after\n${after}`;
}

function noSymbolChanges(result: ClassifyResult): boolean {
	const { added, removed, changed } = result.exportedSymbols;
	return added.length === 0 && removed.length === 0 && changed.length === 0;
}

describe("classifier properties", () => {
	const classify = createClassifier();

	it("identical before and after is non-impacting", async () => {
		for (const seed of seeds(CASES)) {
			const random = seededRandom(seed);
			const source = render(tokensOf(generateModule(random)), random);

			const result = await classify({
				filePath: "src/m.ts",
				before: source,
				after: source,
			});

			const context = describeCase(seed, source, source);
			expect(result.classification, context).toBe("non-impacting");
			expect(noSymbolChanges(result), context).toBe(true);
			expect(result.confidence, context).toBe(1);
		}
	});

	it("comments and whitespace inserted anywhere are non-impacting", async () => {
		for (const seed of seeds(CASES)) {
			const random = seededRandom(seed);
			const tokens = tokensOf(generateModule(random));
			const before = render(tokens);
			const after = render(tokens, random);

			const result = await classify({ filePath: "src/m.ts", before, after });

			const context = describeCase(seed, before, after);
			expect(result.classification, context).toBe("non-impacting");
			expect(noSymbolChanges(result), context).toBe(true);
		}
	});

	it("a changed parameter or return type of an exported function is breaking", async () => {
		for (const seed of seeds(CASES)) {
			const random = seededRandom(seed);
			const module = generateModule(random);
			const target = random.pick(exportedFunctions(module));
			const edited = withFunction(
				module,
				target.name,
				changeSignature(random, target),
			);
			const before = render(tokensOf(module), random);
			const after = render(tokensOf(edited), random);

			const result = await classify({ filePath: "src/m.ts", before, after });

			const context = describeCase(seed, before, after);
			expect(result.classification, context).toBe("breaking");
			expect(result.exportedSymbols.changed, context).toEqual([
				{ name: target.name, kind: "signature" },
			]);
		}
	});

	it("a body-only edit of an exported function is internal, never non-impacting", async () => {
		for (const seed of seeds(CASES)) {
			const random = seededRandom(seed);
			const module = generateModule(random);
			const target = random.pick(exportedFunctions(module));
			const edited = withFunction(
				module,
				target.name,
				changeBody(random, target),
			);
			const before = render(tokensOf(module), random);
			const after = render(tokensOf(edited), random);

			const result = await classify({ filePath: "src/m.ts", before, after });

			const context = describeCase(seed, before, after);
			expect(result.classification, context).toBe("internal");
			expect(result.exportedSymbols.changed, context).toEqual([
				{ name: target.name, kind: "body" },
			]);
		}
	});
});
