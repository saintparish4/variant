import { describe, expect, it } from "vitest";
import { captureOutput } from "../../../__tests__/helpers/cli-harness.js";
import type { ClassifyResult } from "../../../core/semantic/differ.js";
import { renderClassification } from "../diff.js";

function result(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
	return {
		filePath: "src/index.ts",
		classification: "internal",
		exportedSymbols: { added: [], removed: [], changed: [] },
		confidence: 1,
		confidenceNotes: [],
		syntaxErrors: false,
		...overrides,
	};
}

describe("renderClassification", () => {
	it("prints the file, base ref, and confidence", () => {
		const capture = captureOutput();

		renderClassification(
			result({ confidence: 0.75 }),
			"HEAD~1",
			capture.printer,
		);

		expect(capture.stdout()).toContain("File:           src/index.ts");
		expect(capture.stdout()).toContain("Base ref:       HEAD~1");
		expect(capture.stdout()).toContain("Confidence:     75%");
	});

	it("explains what each classification means", () => {
		const meanings: Array<[ClassifyResult["classification"], string]> = [
			["non-impacting", "safe to skip build"],
			["internal", "implementation-only change"],
			["breaking", "exported API changed"],
		];

		for (const [classification, meaning] of meanings) {
			const capture = captureOutput();
			renderClassification(result({ classification }), "HEAD", capture.printer);
			expect(capture.stdout()).toContain(classification);
			expect(capture.stdout()).toContain(meaning);
		}
	});

	it("omits the symbol section when the export surface is unchanged", () => {
		const capture = captureOutput();

		renderClassification(result(), "HEAD", capture.printer);

		expect(capture.stdout()).not.toContain("Exported symbol changes:");
	});

	it("lists added, removed, and changed symbols separately", () => {
		const capture = captureOutput();

		renderClassification(
			result({
				classification: "breaking",
				exportedSymbols: {
					added: ["created"],
					removed: ["deleted"],
					changed: [{ name: "altered", kind: "signature" }],
				},
			}),
			"HEAD",
			capture.printer,
		);

		expect(capture.stdout()).toContain("added:   created");
		expect(capture.stdout()).toContain("removed: deleted");
		expect(capture.stdout()).toContain("changed: altered [signature]");
	});

	it("reports why the confidence was lowered", () => {
		const capture = captureOutput();

		renderClassification(
			result({ confidence: 0.5, confidenceNotes: ["dynamic import"] }),
			"HEAD",
			capture.printer,
		);

		expect(capture.stdout()).toContain("Confidence lowered by:");
		expect(capture.stdout()).toContain("- dynamic import");
	});

	it("omits the confidence-notes section at full confidence", () => {
		const capture = captureOutput();

		renderClassification(result(), "HEAD", capture.printer);

		expect(capture.stdout()).not.toContain("Confidence lowered by:");
	});
});
