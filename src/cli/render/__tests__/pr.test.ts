import { describe, expect, it } from "vitest";
import { captureOutput } from "../../../__tests__/helpers/cli-harness.js";
import type { PrCheckResult } from "../../../core/pr/check.js";
import type { ClassifyResult } from "../../../core/semantic/differ.js";
import { renderPrCheck } from "../pr.js";

function classified(
	filePath: string,
	classification: ClassifyResult["classification"],
	symbols: Partial<ClassifyResult["exportedSymbols"]> = {},
): ClassifyResult {
	return {
		filePath,
		classification,
		exportedSymbols: { added: [], removed: [], changed: [], ...symbols },
		confidence: 1,
		confidenceNotes: [],
	};
}

function checkResult(files: ClassifyResult[] = []): PrCheckResult {
	return {
		baseRef: "main",
		tsFilesChanged: files.length,
		files,
		verdict: "safe-to-skip",
	};
}

describe("renderPrCheck", () => {
	it("prints the base ref, changed count, and verdict", () => {
		const capture = captureOutput();

		renderPrCheck(checkResult(), capture.printer);

		expect(capture.stdout()).toContain("Base ref: main");
		expect(capture.stdout()).toContain("Changed .ts files: 0");
		expect(capture.stdout()).toContain("Verdict: safe to skip build");
	});

	it("omits the classification block when nothing changed", () => {
		const capture = captureOutput();

		renderPrCheck(checkResult(), capture.printer);

		expect(capture.stdout()).not.toContain("File classifications:");
	});

	it("lists each classified file", () => {
		const capture = captureOutput();

		renderPrCheck(
			checkResult([classified("src/impl.ts", "internal")]),
			capture.printer,
		);

		expect(capture.stdout()).toContain("File classifications:");
		expect(capture.stdout()).toContain("internal");
		expect(capture.stdout()).toContain("src/impl.ts");
	});

	it("summarizes the symbol delta beside the file", () => {
		const capture = captureOutput();

		renderPrCheck(
			checkResult([
				classified("src/api.ts", "breaking", {
					added: ["a"],
					removed: ["b", "c"],
					changed: [{ name: "d", kind: "signature" }],
				}),
			]),
			capture.printer,
		);

		expect(capture.stdout()).toContain("(+1 added, -2 removed, ~1 changed)");
	});

	it("shows no delta parenthetical when the surface is unchanged", () => {
		const capture = captureOutput();

		renderPrCheck(
			checkResult([classified("src/impl.ts", "internal")]),
			capture.printer,
		);

		expect(capture.stdout()).not.toContain("(");
	});
});
