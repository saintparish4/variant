import { describe, expect, it } from "vitest";
import { defaultIsTestFile } from "../../semantic/test-impact.js";
import type { FileHunks } from "../hunks.js";
import type { TargetInput } from "../targets.js";
import { mutateEntries, selectTargets } from "../targets.js";

const changedLines = (start: number, end: number): FileHunks => ({
	added: [{ start, end }],
	deletedLines: 0,
});

function input(overrides: Partial<TargetInput>): TargetInput {
	return {
		changed: [],
		untracked: [],
		hunks: new Map(),
		formattingOnly: new Set(),
		isTestFile: defaultIsTestFile,
		...overrides,
	};
}

describe("selectTargets", () => {
	it("mutates changed TypeScript source and says why each other file is left out", () => {
		const result = selectTargets(
			input({
				changed: [
					"src/price.ts",
					"src/price.test.ts",
					"src/types.d.ts",
					"README.md",
					"../other/thing.ts",
					"src/removed.ts",
				],
				hunks: new Map([
					["src/price.ts", changedLines(3, 5)],
					["src/removed.ts", { added: [], deletedLines: 12 }],
				]),
			}),
		);

		expect(result.targets).toEqual([
			{
				file: "src/price.ts",
				ranges: [{ start: 3, end: 5 }],
				untracked: false,
			},
		]);
		expect(result.excluded).toEqual([
			{ file: "../other/thing.ts", reason: "outside" },
			{ file: "README.md", reason: "not-typescript" },
			{ file: "src/price.test.ts", reason: "test" },
			{ file: "src/removed.ts", reason: "deleted-lines-only" },
			{ file: "src/types.d.ts", reason: "declaration" },
		]);
	});

	// Named to the engine as a glob, a brace expands before it can be escaped.
	it("leaves out a file whose name holds a brace, and says why", () => {
		const result = selectTargets(
			input({
				changed: ["src/{legacy}/price.ts", "src/[id]/price.ts"],
				hunks: new Map([
					["src/{legacy}/price.ts", changedLines(1, 1)],
					["src/[id]/price.ts", changedLines(1, 1)],
				]),
			}),
		);

		expect(result.targets.map((target) => target.file)).toEqual([
			"src/[id]/price.ts",
		]);
		expect(result.excluded).toEqual([
			{ file: "src/{legacy}/price.ts", reason: "unnamable" },
		]);
	});

	// pyra: "I just wrote a new module" left it untracked, and check mutated
	// nothing of it.
	it("mutates a new file git does not track yet, all of it", () => {
		const result = selectTargets(
			input({
				untracked: ["src/draft.ts", "src/draft.test.ts", "notes.txt"],
				hunks: new Map([["src/draft.ts", changedLines(1, 20)]]),
			}),
		);

		expect(result.targets).toEqual([
			{
				file: "src/draft.ts",
				ranges: [{ start: 1, end: 20 }],
				untracked: true,
			},
		]);
		expect(result.excluded).toEqual([
			{ file: "src/draft.test.ts", reason: "test" },
		]);
	});

	// pyra: a formatting commit gave 18 findings on code whose behaviour no
	// one touched.
	it("leaves out a file whose change is only formatting or comments", () => {
		const result = selectTargets(
			input({
				changed: ["src/style.ts"],
				hunks: new Map([["src/style.ts", changedLines(4, 9)]]),
				formattingOnly: new Set(["src/style.ts"]),
			}),
		);

		expect(result.targets).toEqual([]);
		expect(result.excluded).toEqual([
			{ file: "src/style.ts", reason: "formatting-only" },
		]);
	});

	// A project with no .gitignore has every installed file untracked; none
	// of them is source anyone wrote.
	it("never treats installed dependencies as new source", () => {
		const result = selectTargets(
			input({
				untracked: [
					"node_modules/zod/src/index.ts",
					"packages/a/node_modules/x/y.ts",
				],
				hunks: new Map([["node_modules/zod/src/index.ts", changedLines(1, 3)]]),
			}),
		);

		expect(result.targets).toEqual([]);
		expect(result.excluded).toEqual([]);
	});

	it("counts deleted lines only in the files it mutates", () => {
		const result = selectTargets(
			input({
				changed: ["src/a.ts"],
				hunks: new Map([
					["src/a.ts", { added: [{ start: 2, end: 2 }], deletedLines: 3 }],
				]),
			}),
		);

		expect(result.deletedLines).toBe(3);
	});
});

describe("mutateEntries", () => {
	it("gives one path:start-end entry per changed range", () => {
		expect(
			mutateEntries([
				{
					file: "src/a.ts",
					ranges: [
						{ start: 2, end: 2 },
						{ start: 8, end: 12 },
					],
					untracked: false,
				},
			]),
		).toEqual(["src/a.ts:2-2", "src/a.ts:8-12"]);
	});

	// Next.js routes: `[id]`, `[...slug]`, `[[...slug]]`, `(group)`.
	it("escapes glob characters in the path, each as a class of one", () => {
		expect(
			mutateEntries([
				{
					file: "src/app/(shop)/[id]/[[...slug]]/page.tsx",
					ranges: [{ start: 3, end: 4 }],
					untracked: false,
				},
				{
					file: "src/a*b?.ts",
					ranges: [{ start: 1, end: 1 }],
					untracked: true,
				},
			]),
		).toEqual([
			"src/app/[(]shop[)]/[[]id[]]/[[][[]...slug[]][]]/page.tsx:3-4",
			"src/a[*]b[?].ts:1-1",
		]);
	});
});
