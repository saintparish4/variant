import { describe, expect, it } from "vitest";
import { classifyChange, createClassifier } from "../differ.js";

function changedNames(r: Awaited<ReturnType<typeof classifyChange>>) {
	return r.exportedSymbols.changed.map((c) => c.name);
}

describe("classifyChange", () => {
	it("flags comment-only edits as non-impacting", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export const a = 1;\n// hello",
			after: "export const a = 1;\n// goodbye",
		});
		expect(r.classification).toBe("non-impacting");
	});

	it("flags non-exported body changes as internal", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "function f() { return 1; }\nexport const a = 1;",
			after: "function f() { return 2; }\nexport const a = 1;",
		});
		expect(r.classification).toBe("internal");
	});

	it("flags exported signature changes as breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export function add(a: number, b: number) { return a+b; }",
			after: "export function add(a: number) { return a; }",
		});
		expect(r.classification).toBe("breaking");
		expect(changedNames(r)).toContain("add");
		expect(r.exportedSymbols.changed[0]?.kind).toBe("signature");
	});

	it("adding a new exported symbol is breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export const a = 1;",
			after: "export const a = 1;\nexport const b = 2;",
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.added).toContain("b");
	});

	it("removing an exported symbol is breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export const a = 1;\nexport const b = 2;",
			after: "export const a = 1;",
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.removed).toContain("b");
	});

	it("changing an exported type alias is breaking with kind type", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export type Foo = { x: number };",
			after: "export type Foo = { x: string };",
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "Foo",
			kind: "type",
		});
	});

	it("identical inputs produce non-impacting", async () => {
		const code = "export const a = 1;\nfunction internal() { return 2; }";
		const r = await classifyChange({
			filePath: "x.ts",
			before: code,
			after: code,
		});
		expect(r.classification).toBe("non-impacting");
		expect(r.confidence).toBe(1);
		expect(r.confidenceNotes).toEqual([]);
	});

	it("whitespace-only change is non-impacting", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export const a = 1;",
			after: "export const a   =   1 ;",
		});
		expect(r.classification).toBe("non-impacting");
	});

	it("changing an exported interface is breaking with kind type", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export interface Bar { x: number; }",
			after: "export interface Bar { x: number; y: string; }",
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "Bar",
			kind: "type",
		});
	});

	// --- signature-level differ ---

	it("body-only edit of an exported function is internal, not breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before:
				"export function add(a: number, b: number): number { return a + b; }",
			after:
				"export function add(a: number, b: number): number { const sum = a + b; return sum; }",
		});
		expect(r.classification).toBe("internal");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "add",
			kind: "body",
		});
	});

	it("body-only edit of an exported arrow function is internal", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export const f = (x: number): number => x + 1;",
			after: "export const f = (x: number): number => x + 2;",
		});
		expect(r.classification).toBe("internal");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "f",
			kind: "body",
		});
	});

	it("comment added inside an exported function body is non-impacting", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export function f(): number { return 1; }",
			after: "export function f(): number { /* why */ return 1; }",
		});
		expect(r.classification).toBe("non-impacting");
	});

	it("string content change that looks like a comment is still detected", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: 'export function f(): string { return "http://a.example"; }',
			after: 'export function f(): string { return "http://b.example"; }',
		});
		expect(r.classification).toBe("internal");
	});

	it("return type annotation change is a breaking signature change", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export function f(): number { return 1; }",
			after: "export function f(): number | undefined { return 1; }",
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "f",
			kind: "signature",
		});
	});

	it("body edit that changes the inferred return type is breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export function f() { return 1; }",
			after: 'export function f() { return "one"; }',
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "f",
			kind: "signature",
		});
	});

	it("parameter rename without other changes is internal", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export function f(a: number): number { return a; }",
			after: "export function f(value: number): number { return value; }",
		});
		expect(r.classification).toBe("internal");
	});

	it("adding a defaulted parameter is a breaking signature change", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export function f(a: number): number { return a; }",
			after: "export function f(a: number, b = 2): number { return a + b; }",
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "f",
			kind: "signature",
		});
	});

	it("changing a default value without changing arity is internal", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export function f(a = 1): number { return a; }",
			after: "export function f(a = 2): number { return a; }",
		});
		expect(r.classification).toBe("internal");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "f",
			kind: "body",
		});
	});

	it("exported const value change of the same type is internal", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export const limit = 10;",
			after: "export const limit = 20;",
		});
		expect(r.classification).toBe("internal");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "limit",
			kind: "body",
		});
	});

	it("exported const type change is breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export const limit = 10;",
			after: 'export const limit = "ten";',
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "limit",
			kind: "signature",
		});
	});

	// --- classes ---

	it("public method body edit on an exported class is internal", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export class C { run(): number { return 1; } }",
			after: "export class C { run(): number { return 2; } }",
		});
		expect(r.classification).toBe("internal");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "C",
			kind: "body",
		});
	});

	it("public method signature change on an exported class is breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "export class C { run(): number { return 1; } }",
			after: "export class C { run(flag: boolean): number { return 1; } }",
		});
		expect(r.classification).toBe("breaking");
	});

	it("private member changes on an exported class are internal", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before:
				"export class C { private count = 0; run(): number { return this.count; } }",
			after:
				"export class C { private total = 0; run(): number { return this.total; } }",
		});
		expect(r.classification).toBe("internal");
	});

	// --- re-exports and type-only imports ---

	it("changing the module of a re-export is breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: 'export { auth } from "./auth-v1";',
			after: 'export { auth } from "./auth-v2";',
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "auth",
			kind: "signature",
		});
	});

	it("adding a named re-export is breaking", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: 'export { a } from "./m";',
			after: 'export { a, b } from "./m";',
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.added).toContain("b");
	});

	it("type-only re-export change carries kind type", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: 'export type { Config } from "./config-v1";',
			after: 'export type { Config } from "./config-v2";',
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "Config",
			kind: "type",
		});
	});

	it("export of a type-only imported name is tracked as type-space", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: 'import type { T } from "./a";\nexport { T };',
			after: 'import type { T } from "./b";\nexport { T };',
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.changed).toContainEqual({
			name: "T",
			kind: "type",
		});
	});

	it("changing the module of an export * is breaking and lowers confidence", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: 'export * from "./a";',
			after: 'export * from "./b";',
		});
		expect(r.classification).toBe("breaking");
		expect(r.confidence).toBeLessThan(1);
		expect(r.confidenceNotes.length).toBeGreaterThan(0);
	});

	// --- confidence ---

	it("dynamic import lowers confidence", async () => {
		const code =
			'export async function load() { return import("./heavy.js"); }';
		const r = await classifyChange({
			filePath: "x.ts",
			before: code,
			after: code,
		});
		expect(r.confidence).toBeLessThan(1);
		expect(r.confidenceNotes.some((n) => n.includes("dynamic import"))).toBe(
			true,
		);
	});

	it("namespace declaration merging lowers confidence", async () => {
		const code =
			"export function f(): number { return 1; }\nexport namespace f { export const x = 1; }";
		const r = await classifyChange({
			filePath: "x.ts",
			before: code,
			after: code,
		});
		expect(r.confidence).toBeLessThan(1);
	});

	it("confidence never drops below the floor", async () => {
		const code = [
			'export * from "./a";',
			'export * from "./b";',
			'export * from "./c";',
			'export * from "./d";',
			'export * from "./e";',
			'export * from "./f";',
			'export async function load() { return import("./g.js"); }',
		].join("\n");
		const r = await classifyChange({
			filePath: "x.ts",
			before: code,
			after: code,
		});
		expect(r.confidence).toBeGreaterThanOrEqual(0.3);
	});

	it("new file (empty before) reports all exports as added", async () => {
		const r = await classifyChange({
			filePath: "x.ts",
			before: "",
			after: "export const a = 1;",
		});
		expect(r.classification).toBe("breaking");
		expect(r.exportedSymbols.added).toEqual(["a"]);
	});
});

describe("createClassifier", () => {
	it("classifies many files through one reused project", async () => {
		const classify = createClassifier();
		const results = [];
		for (let i = 0; i < 20; i++) {
			results.push(
				await classify({
					filePath: `m${i}.ts`,
					before: `export function f${i}(a: number): number { return a; }`,
					after: `export function f${i}(a: number, b: number): number { return a; }`,
				}),
			);
		}
		expect(results.map((r) => r.classification)).toEqual(
			Array(20).fill("breaking"),
		);
		expect(results.map((r) => r.filePath)).toEqual(
			Array.from({ length: 20 }, (_, i) => `m${i}.ts`),
		);
	});

	it("keeps concurrent classifications independent", async () => {
		const classify = createClassifier();
		const results = await Promise.all([
			classify({
				filePath: "a.ts",
				before: "export const a = 1;",
				after: "export const a = 1;",
			}),
			classify({
				filePath: "b.ts",
				before: "export function b(x: number) { return x; }",
				after: "export function b(x: string) { return x; }",
			}),
			classify({
				filePath: "c.ts",
				before: "export function c() { return 1; }",
				after: "export function c() { return 2; }",
			}),
		]);
		expect(results.map((r) => [r.filePath, r.classification])).toEqual([
			["a.ts", "non-impacting"],
			["b.ts", "breaking"],
			["c.ts", "internal"],
		]);
	});
});
