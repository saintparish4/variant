import { describe, expect, it } from "vitest";
import { explainSurvivor, operatorChange } from "../explain.js";

describe("explainSurvivor", () => {
	it("points at the boundary a relational operator moved", () => {
		expect(
			explainSurvivor({
				mutator: "EqualityOperator",
				original: "total >= 100",
				replacement: "total > 100",
			}),
		).toBe(
			"Changing >= to > went undetected. Review the behavior at total = 100.",
		);
	});

	it("reads the operands from the original even when the engine respaces the replacement", () => {
		expect(
			explainSurvivor({
				mutator: "EqualityOperator",
				original: "count<=limit",
				replacement: "count < limit",
			}),
		).toBe(
			"Changing <= to < went undetected. Review the behavior at count = limit.",
		);
	});

	it("drops the operands when they are too long to read as a hint", () => {
		const long = "items.filter((item) => item.active).length";
		expect(
			explainSurvivor({
				mutator: "EqualityOperator",
				original: `${long} > 0`,
				replacement: `${long} >= 0`,
			}),
		).toBe(
			"Changing > to >= went undetected. Review the behavior where both sides are equal.",
		);
	});

	it("names an inverted comparison without claiming a boundary", () => {
		expect(
			explainSurvivor({
				mutator: "EqualityOperator",
				original: "a === b",
				replacement: "a !== b",
			}),
		).toBe(
			"Changing === to !== went undetected. The tests that ran passed with the comparison inverted: review a case on each side of a === b.",
		);
	});

	it("says which way a forced condition went", () => {
		expect(
			explainSurvivor({
				mutator: "ConditionalExpression",
				original: "user.isAdmin",
				replacement: "true",
			}),
		).toMatch(/always true: review a case where it is false\.$/);
	});

	it("asks for a case where the two sides of a logical operator differ", () => {
		expect(
			explainSurvivor({
				mutator: "LogicalOperator",
				original: "a && b",
				replacement: "a || b",
			}),
		).toBe(
			"Changing && to || went undetected. Review a case where only one side of a && b holds.",
		);
	});

	it("describes a removed negation", () => {
		expect(
			explainSurvivor({
				mutator: "BooleanLiteral",
				original: "!done",
				replacement: "done",
			}),
		).toBe("Removing the ! from !done went undetected.");
	});

	it("describes an arithmetic swap without calling it a bug", () => {
		const text = explainSurvivor({
			mutator: "ArithmeticOperator",
			original: "price + tax",
			replacement: "price - tax",
		});
		expect(text).toBe(
			"Changing + to - went undetected. The tests that ran did not tell price + tax from price - tax.",
		);
		expect(text).not.toMatch(/bug|untested|safe|verified/i);
	});
});

describe("operatorChange", () => {
	it("finds the whole operator when old and new share its first character", () => {
		expect(operatorChange("a > b", "a >= b")).toEqual({
			left: "a",
			from: ">",
			to: ">=",
			right: "b",
		});
	});

	it("keeps operator characters inside an operand out of the operator", () => {
		expect(operatorChange("x >= -1", "x > -1")).toEqual({
			left: "x",
			from: ">=",
			to: ">",
			right: "-1",
		});
	});

	it("gives up on a change that is not one operator", () => {
		expect(operatorChange("a > b", "true")).toBeNull();
	});
});
