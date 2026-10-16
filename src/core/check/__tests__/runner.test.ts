import { describe, expect, it } from "vitest";
import { detectRunner } from "../runner.js";

const manifest = (fields: Record<string, unknown>): string =>
	JSON.stringify({ name: "app", ...fields });

describe("detectRunner", () => {
	it("finds Vitest from a dependency, a script or a config", () => {
		expect(
			detectRunner(manifest({ devDependencies: { vitest: "4.1.11" } }), []),
		).toEqual({
			kind: "vitest",
		});
		expect(
			detectRunner(manifest({ scripts: { test: "vitest run" } }), []),
		).toEqual({
			kind: "vitest",
		});
		expect(detectRunner(manifest({}), ["vitest.config.mts"])).toEqual({
			kind: "vitest",
		});
	});

	it("names what shows a package tests with Jest", () => {
		expect(
			detectRunner(manifest({ devDependencies: { jest: "30.5.2" } }), [
				"jest.config.ts",
			]),
		).toEqual({ kind: "jest", evidence: "jest.config.ts" });
		expect(
			detectRunner(manifest({ scripts: { test: "jest --ci" } }), []),
		).toEqual({
			kind: "jest",
			evidence: "the `test` script",
		});
		expect(detectRunner(manifest({ jest: { preset: "ts-jest" } }), [])).toEqual(
			{
				kind: "jest",
				evidence: "the `jest` key in package.json",
			},
		);
	});

	// A package moving to Vitest still has its Jest config for a while.
	it("takes Vitest where both are present", () => {
		expect(
			detectRunner(manifest({ devDependencies: { vitest: "4.1.11" } }), [
				"jest.config.js",
			]),
		).toEqual({ kind: "vitest" });
	});

	it("finds neither in a package that runs no tests", () => {
		expect(detectRunner(manifest({}), ["tsconfig.json"])).toEqual({
			kind: "none",
		});
		expect(detectRunner(null, [])).toEqual({ kind: "none" });
	});
});
