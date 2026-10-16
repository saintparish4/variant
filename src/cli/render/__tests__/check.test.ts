import { beforeEach, describe, expect, it } from "vitest";
import { captureOutput } from "../../../__tests__/helpers/cli-harness.js";
import type { CheckResult, MutantOutcome } from "../../../core/check/result.js";
import { writeGlobalColorChoice } from "../../visuals/color.js";
import { renderCheck, renderCheckJson } from "../check.js";

beforeEach(() => {
	writeGlobalColorChoice("never");
});

function mutant(overrides: Partial<MutantOutcome> = {}): MutantOutcome {
	return {
		id: "0",
		file: "src/discount.ts",
		start: { line: 3, column: 9 },
		end: { line: 3, column: 21 },
		mutator: "EqualityOperator",
		original: "total >= 100",
		replacement: "total > 100",
		outcome: "detected",
		symbol: "qualifiesForDiscount",
		...overrides,
	};
}

function result(overrides: Partial<CheckResult> = {}): CheckResult {
	const mutants = overrides.mutants ?? [mutant()];
	const counts = {
		detected: 0,
		undetected: 0,
		"no-coverage": 0,
		timeout: 0,
		"runtime-error": 0,
		"compile-error": 0,
		ignored: 0,
		"not-run": 0,
		attempted: 0,
	};
	for (const m of mutants) {
		counts[m.outcome]++;
		if (m.outcome !== "not-run" && m.outcome !== "ignored") counts.attempted++;
	}
	return {
		base: { ref: "HEAD", label: "HEAD: your staged and unstaged changes" },
		status: "complete",
		baselineFinished: true,
		files: [
			{
				file: "src/discount.ts",
				ranges: [{ start: 1, end: 4 }],
				untracked: false,
				changedLines: 4,
				mutants: mutants.length,
				symbols: ["qualifiesForDiscount"],
			},
		],
		excluded: [{ file: "src/discount.test.ts", reason: "test" }],
		deletedLines: 0,
		baseline: { tests: 2, files: 1, skipped: 0 },
		mutants,
		counts,
		notes: [],
		durationMs: 3600,
		...overrides,
	};
}

describe("renderCheck", () => {
	it("shows each undetected mutation as a change to the source, with what to review", () => {
		const capture = captureOutput();

		renderCheck(
			result({
				mutants: [
					mutant({
						outcome: "undetected",
						explanation:
							"Changing >= to > went undetected. Review the behavior at total = 100.",
					}),
					mutant({ id: "1", replacement: "total < 100" }),
				],
			}),
			capture.printer,
		);

		const out = capture.stdout();
		expect(out).toContain(
			"Compared with HEAD (your staged and unstaged changes).",
		);
		expect(out).toContain(
			"  src/discount.ts  4 changed lines, 2 mutations  (qualifiesForDiscount)",
		);
		expect(out).toContain("  src/discount.test.ts  a test file");
		expect(out).toContain(
			[
				"Undetected: 1",
				"  src/discount.ts:3:9  in qualifiesForDiscount",
				"    - total >= 100",
				"    + total > 100",
				"    Changing >= to > went undetected. Review the behavior at total = 100.",
			].join("\n"),
		);
		expect(out).toContain(
			"2 mutations run against the tests: 1 detected, 1 undetected.",
		);
		expect(out).toMatch(
			/Scope: the tests passed unmutated first \(2 tests in 1 file/,
		);
		expect(out).toContain("Time: 3.6 s");
	});

	it("claims evidence, not correctness, when every mutation was detected", () => {
		const capture = captureOutput();

		renderCheck(
			result({
				mutants: [mutant(), mutant({ id: "1", replacement: "total < 100" })],
			}),
			capture.printer,
		);

		const out = capture.stdout();
		expect(out).toContain(
			"All 2 mutations were detected by the tests that ran.",
		);
		expect(out).toContain("not proof the change is correct");
		expect(out).not.toMatch(/verified|safe|fully tested/i);
	});

	it("reads naturally when a single mutation was tried", () => {
		const capture = captureOutput();

		renderCheck(result(), capture.printer);

		expect(capture.stdout()).toContain(
			"The one mutation tried was detected by the tests that ran.",
		);
	});

	it("says an incomplete run is incomplete and never reads it as all detected", () => {
		const capture = captureOutput();

		renderCheck(
			result({
				status: "incomplete",
				stopReason: "budget",
				mutants: [
					mutant(),
					mutant({
						id: "1",
						outcome: "not-run",
						reason: "the --budget ran out",
					}),
				],
			}),
			capture.printer,
		);

		const out = capture.stdout();
		expect(out).toContain(
			"Incomplete: the --budget ran out after 1 of 2 mutations.",
		);
		expect(out).not.toMatch(/were detected|was detected/);
	});

	it("shows unreached code apart from undetected mutations", () => {
		const capture = captureOutput();

		renderCheck(
			result({ mutants: [mutant({ outcome: "no-coverage" })] }),
			capture.printer,
		);

		const out = capture.stdout();
		expect(out).toContain("No test reached: 1");
		expect(out).toContain("No test executed this code in the test process");
		expect(out).not.toContain("Undetected:");
	});

	it("lists timeouts and errors as inconclusive", () => {
		const capture = captureOutput();

		renderCheck(
			result({
				mutants: [mutant({ outcome: "timeout", reason: "Timed out" })],
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Inconclusive: 1");
		expect(capture.stdout()).toContain("timed out: Timed out");
	});

	it("keeps a long list of files it did not mutate short, with the rest in --json", () => {
		const capture = captureOutput();
		const excluded = Array.from({ length: 25 }, (_, i) => ({
			file: `src/draft-${i}.ts`,
			reason: "not-typescript" as const,
		}));

		renderCheck(result({ excluded }), capture.printer);

		const out = capture.stdout();
		expect(out).toContain("src/draft-9.ts");
		expect(out).not.toContain("src/draft-10.ts");
		expect(out).toContain("… and 15 more (all of them in --json)");
	});

	// pyra: "291 mutations tried" read as --max-mutants 50 being ignored; 277
	// of them were in code no test executed, which costs no test run.
	it("counts mutations run against the tests apart from those in unreached code", () => {
		const capture = captureOutput();

		renderCheck(
			result({
				mutants: [
					mutant(),
					mutant({ id: "1", outcome: "undetected", explanation: "x" }),
					mutant({ id: "2", outcome: "no-coverage" }),
					mutant({ id: "3", outcome: "no-coverage" }),
				],
			}),
			capture.printer,
		);

		const out = capture.stdout();
		expect(out).toContain(
			"4 mutations: 2 run against the tests (1 detected, 1 undetected), 2 in code no test executed (those run no tests and do not count toward --max-mutants).",
		);
	});

	// pyra: the same untested code read "undetected" in one run and "no test
	// reached" in another. Code that runs when its module loads is run
	// against every test, so "undetected" is right, but it has to say why.
	it("says when an undetected mutation is in code that runs as its module loads", () => {
		const capture = captureOutput();

		renderCheck(
			result({
				mutants: [
					mutant({ outcome: "undetected", explanation: "x", static: true }),
				],
			}),
			capture.printer,
		);

		expect(capture.stdout()).toContain(
			"    This runs when its module loads, so every test ran against it.",
		);
	});

	it("says how many baseline tests were skipped, which can leave code unreached", () => {
		const capture = captureOutput();

		renderCheck(
			result({
				baseline: { tests: 5, files: 2, skipped: 3 },
				mutants: [mutant({ outcome: "no-coverage" })],
			}),
			capture.printer,
		);

		const out = capture.stdout();
		expect(out).toContain("(5 tests in 2 files, 3 of them skipped,");
		expect(out).toContain(
			"3 tests were skipped; code only they would reach reads as reached by no test.",
		);
	});

	it("says when nothing changed that could be mutated", () => {
		const capture = captureOutput();

		renderCheck(
			result({ status: "nothing-to-mutate", files: [], mutants: [] }),
			capture.printer,
		);

		expect(capture.stdout()).toContain("Nothing to check:");
	});
});

describe("renderCheckJson", () => {
	it("prints the whole result with the all-detected verdict beside it", () => {
		const capture = captureOutput();

		renderCheckJson(result(), capture.printer);

		const parsed = JSON.parse(capture.stdout()) as {
			allDetected: boolean;
			status: string;
		};
		expect(parsed).toMatchObject({ allDetected: true, status: "complete" });
	});
});
