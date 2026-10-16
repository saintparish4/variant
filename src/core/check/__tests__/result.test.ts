import { describe, expect, it } from "vitest";
import type { PlannedMutant, TestedMutant } from "../backend.js";
import type { AssembleInput } from "../result.js";
import { allDetected, assembleCheckResult, sliceSource } from "../result.js";
import { selectMutants } from "../selection.js";

const SOURCE =
	"export function q(total: number) {\n\treturn total >= 100;\n}\n";

function planned(
	id: string,
	replacement: string,
	covered = true,
): PlannedMutant {
	return {
		id,
		file: "src/q.ts",
		mutator: "EqualityOperator",
		replacement,
		start: { line: 2, column: 9 },
		end: { line: 2, column: 21 },
		covered,
		static: false,
	};
}

function tested(id: string, status: TestedMutant["status"]): TestedMutant {
	return { id, status, killedBy: status === "Killed" ? ["q accepts 150"] : [] };
}

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
	const plan = [planned("0", "total > 100"), planned("1", "total < 100")];
	return {
		base: { ref: "HEAD", label: "HEAD" },
		targets: [
			{ file: "src/q.ts", ranges: [{ start: 2, end: 2 }], untracked: false },
		],
		excluded: [],
		deletedLines: 0,
		baselineTests: [
			{
				id: "t1",
				name: "q accepts 150",
				file: "src/q.test.ts",
				skipped: false,
			},
		],
		plan,
		selection: selectMutants(plan, 50),
		tested: new Map([
			["0", tested("0", "Killed")],
			["1", tested("1", "Killed")],
		]),
		snapshot: new Map([["src/q.ts", SOURCE]]),
		runner: { kind: "vitest" },
		durationMs: 1000,
		...overrides,
	};
}

describe("baseline and static mutants", () => {
	it("counts skipped baseline tests and keeps which mutants are static", () => {
		const staticMutant = { ...planned("0", "total > 100"), static: true };
		const result = assembleCheckResult(
			input({
				baselineTests: [
					{ id: "a", name: "a", file: "src/q.test.ts", skipped: false },
					{ id: "b", name: "b", file: "src/q.test.ts", skipped: true },
				],
				plan: [staticMutant],
				selection: selectMutants([staticMutant], 50),
				tested: new Map([["0", tested("0", "Survived")]]),
			}),
		);

		expect(result.baseline).toEqual({ tests: 2, files: 1, skipped: 1 });
		expect(result.mutants[0]?.static).toBe(true);
	});
});

describe("sliceSource", () => {
	it("quotes the text between two 1-based positions, the end excluded", () => {
		expect(
			sliceSource(SOURCE, { line: 2, column: 9 }, { line: 2, column: 21 }),
		).toBe("total >= 100");
	});
});

describe("assembleCheckResult", () => {
	it("quotes the original code and explains each undetected mutation", () => {
		const result = assembleCheckResult(
			input({
				tested: new Map([
					["0", tested("0", "Survived")],
					["1", tested("1", "Killed")],
				]),
			}),
		);

		const survivor = result.mutants.find((m) => m.outcome === "undetected");
		expect(survivor?.original).toBe("total >= 100");
		expect(survivor?.explanation).toBe(
			"Changing >= to > went undetected. Review the behavior at total = 100.",
		);
		expect(result.counts).toMatchObject({
			attempted: 2,
			detected: 1,
			undetected: 1,
		});
		expect(allDetected(result)).toBe(false);
	});

	it("reads as all detected only when every attempted mutation was", () => {
		expect(allDetected(assembleCheckResult(input()))).toBe(true);
	});

	it("is incomplete, never all detected, when the budget stopped it", () => {
		const result = assembleCheckResult(
			input({
				tested: new Map([["0", tested("0", "Killed")]]),
				stopReason: "budget",
			}),
		);

		expect(result.status).toBe("incomplete");
		expect(result.mutants.find((m) => m.id === "1")).toMatchObject({
			outcome: "not-run",
			reason: "the --budget ran out",
		});
		expect(allDetected(result)).toBe(false);
	});

	it("is incomplete when the budget ran out before the baseline finished", () => {
		const { baselineTests: _, plan: __, selection: ___, ...rest } = input();
		const result = assembleCheckResult({
			...rest,
			tested: new Map(),
			stopReason: "budget",
		});

		expect(result.status).toBe("incomplete");
		expect(result.baselineFinished).toBe(false);
		expect(allDetected(result)).toBe(false);
	});

	it("drops results for mutants past the limit, so the same change reads the same", () => {
		const plan = [planned("0", "total > 100"), planned("1", "total < 100")];
		const result = assembleCheckResult(
			input({
				plan,
				selection: selectMutants(plan, 1),
				// "1" finished anyway, on a second worker.
				tested: new Map([
					["0", tested("0", "Killed")],
					["1", tested("1", "Survived")],
				]),
				stopReason: "limit",
			}),
		);

		expect(result.mutants.find((m) => m.id === "1")).toMatchObject({
			outcome: "not-run",
			reason: "past --max-mutants",
		});
		expect(result.counts.undetected).toBe(0);
		expect(result.status).toBe("incomplete");
	});

	it("keeps code no test reached apart from code the tests missed", () => {
		const plan = [planned("0", "total > 100", false)];
		const result = assembleCheckResult(
			input({
				plan,
				selection: selectMutants(plan, 50),
				tested: new Map([["0", tested("0", "NoCoverage")]]),
			}),
		);

		expect(result.counts["no-coverage"]).toBe(1);
		expect(result.counts.undetected).toBe(0);
		expect(allDetected(result)).toBe(false);
	});

	it("counts a timeout or an error as inconclusive, not as detected", () => {
		const result = assembleCheckResult(
			input({
				tested: new Map([
					["0", tested("0", "Timeout")],
					[
						"1",
						{ ...tested("1", "RuntimeError"), statusReason: "boom\nstack" },
					],
				]),
			}),
		);

		expect(result.counts).toMatchObject({
			detected: 0,
			timeout: 1,
			"runtime-error": 1,
		});
		expect(result.mutants.find((m) => m.id === "1")?.reason).toBe("boom");
		expect(allDetected(result)).toBe(false);
	});

	it("says there was nothing to mutate when no changed line could be targeted", () => {
		const { plan: _, selection: __, ...rest } = input();
		const result = assembleCheckResult({
			...rest,
			targets: [],
			tested: new Map(),
		});

		expect(result.status).toBe("nothing-to-mutate");
		expect(allDetected(result)).toBe(false);
	});

	it("is complete but claims nothing when the changed lines hold no mutation", () => {
		const result = assembleCheckResult(
			input({ plan: [], selection: selectMutants([], 50), tested: new Map() }),
		);

		expect(result.status).toBe("complete");
		expect(result.counts.attempted).toBe(0);
		expect(allDetected(result)).toBe(false);
	});
});
