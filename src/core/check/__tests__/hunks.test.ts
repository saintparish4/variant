import { describe, expect, it } from "vitest";
import { countLines, parseZeroContextDiff } from "../hunks.js";

const header = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..2222222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
];

describe("parseZeroContextDiff", () => {
	it("reads each hunk's new lines as a range", () => {
		const diff = [
			...header,
			"@@ -3 +3 @@ export function a() {",
			"-\treturn 1;",
			"+\treturn 2;",
			"@@ -10,0 +11,3 @@",
			"+one",
			"+two",
			"+three",
		].join("\n");

		expect(parseZeroContextDiff(diff)).toEqual({
			added: [
				{ start: 3, end: 3 },
				{ start: 11, end: 13 },
			],
			deletedLines: 0,
		});
	});

	it("counts lines removed with nothing in their place, which no mutation can reach", () => {
		const diff = [...header, "@@ -4,2 +3,0 @@", "-gone", "-also gone"].join(
			"\n",
		);

		expect(parseZeroContextDiff(diff)).toEqual({ added: [], deletedLines: 2 });
	});

	// git omits a count of 1: `-5` is one old line. Found by `variant check`
	// on this module: nothing here covered the omitted count.
	it("counts a one-line deletion, whose old count git leaves out", () => {
		const diff = [...header, "@@ -5 +4,0 @@", "-gone"].join("\n");

		expect(parseZeroContextDiff(diff)).toEqual({ added: [], deletedLines: 1 });
	});

	it("treats a new file as one range covering it", () => {
		const diff = [
			"diff --git a/new.ts b/new.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/new.ts",
			"@@ -0,0 +1,4 @@",
			"+a",
			"+b",
			"+c",
			"+d",
		].join("\n");

		expect(parseZeroContextDiff(diff).added).toEqual([{ start: 1, end: 4 }]);
	});

	// A changed line starting `@@` is content, prefixed `+`; only a header
	// starts the line with it.
	it("ignores content that only looks like a hunk header", () => {
		const diff = [...header, "@@ -1 +1 @@", "+@@ -9 +9 @@ not a header"].join(
			"\n",
		);

		expect(parseZeroContextDiff(diff).added).toEqual([{ start: 1, end: 1 }]);
	});

	it("reads nothing from an empty diff", () => {
		expect(parseZeroContextDiff("")).toEqual({ added: [], deletedLines: 0 });
	});
});

describe("countLines", () => {
	it("counts inclusive ranges", () => {
		expect(
			countLines([
				{ start: 1, end: 1 },
				{ start: 5, end: 7 },
			]),
		).toBe(4);
	});
});
