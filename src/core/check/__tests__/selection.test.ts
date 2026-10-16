import { describe, expect, it } from "vitest";
import type { PlannedMutant } from "../backend.js";
import { selectMutants } from "../selection.js";

function mutant(id: string, covered = true, isStatic = false): PlannedMutant {
	return {
		id,
		file: "src/a.ts",
		mutator: "EqualityOperator",
		replacement: "a > b",
		start: { line: 1, column: 1 },
		end: { line: 1, column: 7 },
		covered,
		static: isStatic,
	};
}

describe("selectMutants", () => {
	it("takes the first mutants in plan order, so a change reads the same twice", () => {
		const plan = ["0", "1", "2", "3", "4"].map((id) => mutant(id));

		const selection = selectMutants(plan, 3);

		expect([...selection.selected]).toEqual(["0", "1", "2"]);
		expect(selection.overLimit).toEqual(["3", "4"]);
	});

	it("never counts code no test executed: its result costs no test run", () => {
		const plan = [
			mutant("0", false),
			mutant("1"),
			mutant("2", false),
			mutant("3"),
		];

		const selection = selectMutants(plan, 1);

		expect([...selection.free]).toEqual(["0", "2"]);
		expect([...selection.selected]).toEqual(["1"]);
		expect(selection.overLimit).toEqual(["3"]);
	});

	it("counts a static mutant, which runs every test, against the limit", () => {
		const selection = selectMutants([mutant("0", false, true)], 5);

		expect([...selection.selected]).toEqual(["0"]);
		expect(selection.free.size).toBe(0);
	});
});
