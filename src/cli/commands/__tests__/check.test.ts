import { describe, expect, it } from "vitest";
import { CliUsageError } from "../../../core/errors.js";
import { parseBudget, parseMaxMutants } from "../check.js";

describe("parseBudget", () => {
	it.each([
		["300", 300_000],
		["90s", 90_000],
		["5m", 300_000],
	])("reads %s", (value, ms) => {
		expect(parseBudget(value)).toBe(ms);
	});

	it("defaults to five minutes", () => {
		expect(parseBudget(undefined)).toBe(300_000);
	});

	it.each(["0", "5h", "-1", "fast"])("rejects %s", (value) => {
		expect(() => parseBudget(value)).toThrow(CliUsageError);
	});
});

describe("parseMaxMutants", () => {
	it("reads a whole number and defaults to 50", () => {
		expect(parseMaxMutants("7")).toBe(7);
		expect(parseMaxMutants(undefined)).toBe(50);
	});

	it.each(["0", "1.5", "many"])("rejects %s", (value) => {
		expect(() => parseMaxMutants(value)).toThrow(CliUsageError);
	});
});
