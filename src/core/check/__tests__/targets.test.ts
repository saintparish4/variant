import { describe, expect, it } from "vitest";
import { defaultIsTestFile } from "../../semantic/test-impact.js";
import type { FileHunks } from "../hunks.js";
import { mutateEntries, selectTargets } from "../targets.js";

const changedLines = (start: number, end: number): FileHunks => ({
	added: [{ start, end }],
	deletedLines: 0,
});

describe("selectTargets", () => {
	it("mutates changed TypeScript source and says why each other file is left out", () => {
		const result = selectTargets({
			changed: [
				"src/price.ts",
				"src/price.test.ts",
				"src/types.d.ts",
				"README.md",
				"../other/thing.ts",
				"src/removed.ts",
			],
			untracked: ["src/draft.ts", "notes.txt"],
			hunks: new Map([
				["src/price.ts", changedLines(3, 5)],
				["src/removed.ts", { added: [], deletedLines: 12 }],
			]),
			isTestFile: defaultIsTestFile,
		});

		expect(result.targets).toEqual([
			{ file: "src/price.ts", ranges: [{ start: 3, end: 5 }] },
		]);
		expect(result.excluded).toEqual([
			{ file: "../other/thing.ts", reason: "outside" },
			{ file: "README.md", reason: "not-typescript" },
			{ file: "src/price.test.ts", reason: "test" },
			{ file: "src/removed.ts", reason: "deleted-lines-only" },
			{ file: "src/types.d.ts", reason: "declaration" },
			{ file: "src/draft.ts", reason: "untracked" },
		]);
	});

	it("counts deleted lines only in the files it mutates", () => {
		const result = selectTargets({
			changed: ["src/a.ts"],
			untracked: [],
			hunks: new Map([
				["src/a.ts", { added: [{ start: 2, end: 2 }], deletedLines: 3 }],
			]),
			isTestFile: defaultIsTestFile,
		});

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
				},
			]),
		).toEqual(["src/a.ts:2-2", "src/a.ts:8-12"]);
	});
});
