import { describe, expect, it } from "vitest";
import { captureOutput } from "../../../__tests__/helpers/cli-harness.js";
import type { PrCheckResult } from "../../../core/pr/check.js";
import type { PrReplayResult } from "../../../core/pr/replay.js";
import type { ClassifyResult } from "../../../core/semantic/differ.js";
import { renderPrCheck, renderPrReplay } from "../pr.js";

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

function replayResult(overrides: Partial<PrReplayResult> = {}): PrReplayResult {
	return {
		baseRef: "main",
		sessionId: "sess-1",
		framework: "next",
		changedFiles: [],
		touchedModules: [],
		touchedRoutes: [],
		touchedPackages: [],
		...overrides,
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

describe("renderPrReplay", () => {
	it("explains itself when no session was recorded", () => {
		const capture = captureOutput();

		renderPrReplay(null, capture.printer);

		expect(capture.stdout()).toContain("No trace session found");
		expect(capture.stdout()).toContain("variant trace");
	});

	it("prints the session header", () => {
		const capture = captureOutput();

		renderPrReplay(replayResult({ sessionId: "abc" }), capture.printer);

		expect(capture.stdout()).toContain("Trace session:   abc");
		expect(capture.stdout()).toContain("Framework:       next");
	});

	it("says so when the PR touches no traced route", () => {
		const capture = captureOutput();

		renderPrReplay(replayResult(), capture.printer);

		expect(capture.stdout()).toContain("No traced routes are touched");
	});

	it("lists touched routes with their module counts", () => {
		const capture = captureOutput();

		renderPrReplay(
			replayResult({
				touchedRoutes: [
					{ path: "/home", modules: ["a.ts", "b.ts"] },
					{ path: "/solo", modules: ["c.ts"] },
				],
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("/home  (2 modules)");
		expect(capture.stdout()).toContain("/solo  (1 module)");
	});

	it("lists touched packages only when there are any", () => {
		const withPackages = captureOutput();
		renderPrReplay(
			replayResult({ touchedPackages: ["web"] }),
			withPackages.printer,
		);
		expect(withPackages.stdout()).toContain("Touched packages:");
		expect(withPackages.stdout()).toContain("web");

		const withoutPackages = captureOutput();
		renderPrReplay(replayResult(), withoutPackages.printer);
		expect(withoutPackages.stdout()).not.toContain("Touched packages:");
	});
});
