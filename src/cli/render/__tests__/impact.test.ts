import { beforeEach, describe, expect, it } from "vitest";
import { captureOutput } from "../../../__tests__/helpers/cli-harness.js";
import type { ImpactReport } from "../../../core/impact/predict.js";
import type {
	BlastRadius,
	FileImpact,
} from "../../../core/semantic/blast-radius.js";
import type { TestImpact } from "../../../core/semantic/test-impact.js";
import { writeGlobalColorChoice } from "../../visuals/color.js";
import { renderImpact, renderImpactJson } from "../impact.js";

beforeEach(() => {
	writeGlobalColorChoice("never");
});

function fileImpact(
	filePath: string,
	overrides: Partial<FileImpact> = {},
): FileImpact {
	return {
		filePath,
		classification: "breaking",
		impactedSymbols: [],
		propagates: true,
		notes: [],
		...overrides,
	};
}

function report(overrides: {
	radius?: Partial<BlastRadius>;
	tests?: Partial<TestImpact>;
	packagesFound?: number;
	historyLogged?: boolean;
}): ImpactReport {
	const radius: BlastRadius = {
		baseRef: "HEAD~1",
		changed: [],
		affectedFiles: [],
		affectedPackages: [],
		affectedTasks: [],
		confidence: 1,
		notes: [],
		repositoryNotes: [],
		...overrides.radius,
	};
	const tests: TestImpact = {
		affectedTests: [],
		totalTests: 0,
		selectAll: false,
		unreached: [],
		confidence: 1,
		resolution: "high",
		notes: [],
		repositoryNotes: [],
		...overrides.tests,
	};
	return {
		baseRef: "HEAD~1",
		result: { radius, tests },
		verdict: "build-required",
		packagesFound: overrides.packagesFound ?? 0,
		historyLogged: overrides.historyLogged ?? true,
	};
}

describe("renderImpact", () => {
	it("prints the base ref and the changed-file count", () => {
		const capture = captureOutput();

		renderImpact(
			report({ radius: { changed: [fileImpact("src/a.ts")] } }),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Base ref: HEAD~1");
		expect(capture.stdout()).toContain("You changed 1 file.");
	});

	it.each([
		[0, "Workspace: no workspace packages found"],
		[3, "Workspace: 3 packages"],
	])("states how many workspace packages were found (%i)", (found, line) => {
		const capture = captureOutput();

		renderImpact(report({ packagesFound: found }), capture.printer);

		expect(capture.stdout()).toContain(line);
	});

	it("lists each changed file with its classification", () => {
		const capture = captureOutput();

		renderImpact(
			report({
				radius: {
					changed: [
						fileImpact("src/a.ts", { classification: "internal" }),
						fileImpact("data.json", { classification: "unanalyzed" }),
					],
				},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("internal");
		expect(capture.stdout()).toContain("src/a.ts");
		expect(capture.stdout()).toContain("unanalyzed");
	});

	it("names the impacted symbols beside the file", () => {
		const capture = captureOutput();

		renderImpact(
			report({
				radius: {
					changed: [fileImpact("src/a.ts", { impactedSymbols: ["login"] })],
				},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("src/a.ts  (login)");
	});

	it("truncates a long change list and says how many are hidden", () => {
		const changed = Array.from({ length: 25 }, (_, i) =>
			fileImpact(`src/file-${i}.ts`),
		);
		const capture = captureOutput();

		renderImpact(report({ radius: { changed } }), capture.printer);

		expect(capture.stdout()).toContain("src/file-19.ts");
		expect(capture.stdout()).not.toContain("src/file-20.ts");
		expect(capture.stdout()).toContain("… and 5 more");
	});

	it("names affected packages alongside the affected file count", () => {
		const capture = captureOutput();

		renderImpact(
			report({
				radius: {
					affectedFiles: ["src/a.ts", "src/b.ts"],
					affectedPackages: ["web"],
				},
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Impact: 2 files, 1 package (web)");
	});

	it("omits the package clause outside a workspace", () => {
		const capture = captureOutput();

		renderImpact(
			report({ radius: { affectedFiles: ["src/a.ts"] } }),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Impact: 1 file\n");
	});

	it("reports the run/skip split against the total", () => {
		const capture = captureOutput();

		renderImpact(
			report({ tests: { affectedTests: ["a.test.ts"], totalTests: 4 } }),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Run:   1 test file");
		expect(capture.stdout()).toContain("Skip:  3 test files (of 4 total)");
	});

	it("always states that the result is report-only", () => {
		const capture = captureOutput();

		renderImpact(
			report({ tests: { confidence: 0.82, resolution: "medium" } }),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Confidence: medium (82%)");
		expect(capture.stdout()).toContain("report-only");
	});

	it("collects radius and test notes into one section", () => {
		const capture = captureOutput();

		renderImpact(
			report({
				radius: { notes: ["radius note"] },
				tests: { notes: ["test note"] },
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Notes:");
		expect(capture.stdout()).toContain("- radius note");
		expect(capture.stdout()).toContain("- test note");
	});

	// Printed in full on every run, notes about the repository bury the ones
	// about the change.
	it("sums up standing repository notes in one line", () => {
		const capture = captureOutput();

		renderImpact(
			report({
				radius: { repositoryNotes: ["a loader computes its specifier"] },
				tests: { repositoryNotes: ["some tests are JavaScript"] },
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain(
			"Repository: 2 standing notes, the same whatever changed (-v lists them)",
		);
		expect(capture.stdout()).not.toContain("a loader computes its specifier");
		expect(capture.stdout()).not.toContain("Notes:");
	});

	it("lists the standing notes with -v", () => {
		const capture = captureOutput("verbose");

		renderImpact(
			report({
				radius: { repositoryNotes: ["a loader computes its specifier"] },
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("- a loader computes its specifier");
	});

	it("warns about changed files no test can reach", () => {
		const capture = captureOutput();

		renderImpact(
			report({ tests: { unreached: ["src/orphan.css"] } }),
			capture.printer,
		);

		expect(capture.stdout()).toContain(
			"Unreached: 1 changed file that variant cannot analyze and no test imports (src/orphan.css).",
		);
	});

	it("says nothing about unreached files when every change reaches a test", () => {
		const capture = captureOutput();

		renderImpact(report({}), capture.printer);

		expect(capture.stdout()).not.toContain("Unreached");
	});

	it("omits the notes section when there is nothing to note", () => {
		const capture = captureOutput();

		renderImpact(report({}), capture.printer);

		expect(capture.stdout()).not.toContain("Notes:");
	});

	it("warns when the shadow-mode prediction could not be persisted", () => {
		const capture = captureOutput();

		renderImpact(report({ historyLogged: false }), capture.printer);

		expect(capture.stdout()).toContain("shadow-mode logging skipped");
	});
});

describe("renderImpactJson", () => {
	it("emits the report with radius and tests hoisted to the top level", () => {
		const capture = captureOutput();

		renderImpactJson(
			report({ tests: { affectedTests: ["a.test.ts"], totalTests: 1 } }),
			capture.printer,
		);

		const parsed = JSON.parse(capture.stdout()) as {
			verdict: string;
			baseRef: string;
			radius: BlastRadius;
			tests: TestImpact;
			result?: unknown;
		};
		expect(parsed.verdict).toBe("build-required");
		expect(parsed.baseRef).toBe("HEAD~1");
		expect(parsed.tests.affectedTests).toEqual(["a.test.ts"]);
		expect(parsed.result).toBeUndefined();
	});
});
