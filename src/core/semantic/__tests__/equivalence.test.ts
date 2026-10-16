import { describe, expect, it } from "vitest";
import { createProgramComparer } from "../equivalence.js";

const same = createProgramComparer();

describe("createProgramComparer", () => {
	// pyra: Biome dropped the parentheses around an arrow body, and the file
	// read as changed.
	it("reads redundant parentheses removed by a formatter as the same program", async () => {
		expect(
			await same(
				"x.ts",
				'export const f = (xs: unknown[]) => xs.map((l) => (l === null ? "" : String(l)));',
				'export const f = (xs: unknown[]) =>\n\txs.map((l) =>\n\t\tl === null ? "" : String(l),\n\t);',
			),
		).toBe(true);
	});

	it("reads comments, whitespace and trailing commas as the same program", async () => {
		expect(
			await same(
				"x.ts",
				"export function g(a: number, b: number) { return a + b; }",
				"// sum\nexport function g(\n\ta: number,\n\tb: number,\n) {\n\treturn a + b;\n}",
			),
		).toBe(true);
	});

	it("tells parentheses that change precedence apart", async () => {
		expect(
			await same(
				"x.ts",
				"export const v = (a + b) * c;",
				"export const v = a + b * c;",
			),
		).toBe(false);
	});

	// `(a?.b).c` throws where `a` is null; `a?.b.c` does not.
	it("tells an optional chain cut by parentheses apart", async () => {
		expect(
			await same(
				"x.ts",
				"export const v = (a?.b).c;",
				"export const v = a?.b.c;",
			),
		).toBe(false);
	});

	// In parentheses it is an expression, not a directive.
	it('tells ("use strict") from the directive', async () => {
		expect(
			await same(
				"x.ts",
				'("use strict");\nexport const v = 1;',
				'"use strict";\nexport const v = 1;',
			),
		).toBe(false);
	});

	it("tells a real change apart", async () => {
		expect(
			await same(
				"x.ts",
				"export const v = a >= 100;",
				"export const v = a > 100;",
			),
		).toBe(false);
	});
});
