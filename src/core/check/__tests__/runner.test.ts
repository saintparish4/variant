import { describe, expect, it } from "vitest";
import { CliUsageError } from "../../errors.js";
import { detectRunner, requestedRunner } from "../runner.js";

const manifest = (fields: Record<string, unknown>): string =>
	JSON.stringify({ name: "app", ...fields });

const kind = (text: string | null, files: string[] = []) =>
	detectRunner(text, files).kind;

describe("detectRunner", () => {
	it("finds Vitest from a dependency, a script or a config", () => {
		expect(kind(manifest({ devDependencies: { vitest: "4.1.11" } }))).toBe(
			"vitest",
		);
		expect(kind(manifest({ scripts: { test: "vitest run" } }))).toBe("vitest");
		expect(kind(manifest({}), ["vitest.config.mts"])).toBe("vitest");
	});

	it("finds Jest from a config, a script, the jest key or a dependency", () => {
		expect(kind(manifest({}), ["jest.config.ts"])).toBe("jest");
		expect(kind(manifest({ scripts: { test: "jest --ci" } }))).toBe("jest");
		expect(kind(manifest({ jest: { preset: "ts-jest" } }))).toBe("jest");
		expect(kind(manifest({ devDependencies: { jest: "30.5.2" } }))).toBe(
			"jest",
		);
	});

	it("follows the test script where both runners show", () => {
		expect(
			kind(
				manifest({
					scripts: { test: "jest", "test:new": "vitest run" },
					devDependencies: { jest: "30.5.2", vitest: "4.1.11" },
				}),
			),
		).toBe("jest");
		expect(
			kind(
				manifest({
					scripts: { test: "vitest run" },
					devDependencies: { jest: "30.5.2", vitest: "4.1.11" },
				}),
				["jest.config.js"],
			),
		).toBe("vitest");
	});

	// A package moving to Vitest still has its Jest config for a while.
	it("takes Vitest where both show and the test script names neither", () => {
		expect(
			kind(
				manifest({
					scripts: { test: "turbo run test" },
					devDependencies: { vitest: "4.1.11" },
				}),
				["jest.config.js"],
			),
		).toBe("vitest");
	});

	it("finds neither in a package that runs no tests", () => {
		expect(kind(manifest({}), ["tsconfig.json"])).toBe("none");
		expect(kind(null)).toBe("none");
	});

	it("keeps the ESM flag a Jest test script runs with", () => {
		expect(
			detectRunner(
				manifest({
					scripts: { test: "NODE_OPTIONS=--experimental-vm-modules jest" },
				}),
				[],
			),
		).toEqual({ kind: "jest", nodeArgs: ["--experimental-vm-modules"] });
		expect(
			detectRunner(manifest({ scripts: { test: "jest" } }), []).nodeArgs,
		).toEqual([]);
	});
});

describe("requestedRunner", () => {
	it("names no runner when no flag does", () => {
		expect(requestedRunner({})).toBeUndefined();
	});

	it("takes a config flag as naming its runner", () => {
		expect(requestedRunner({ jestConfig: "jest.unit.config.js" })).toEqual({
			kind: "jest",
			configFile: "jest.unit.config.js",
		});
		expect(requestedRunner({ vitestConfig: "vitest.unit.ts" })).toEqual({
			kind: "vitest",
			configFile: "vitest.unit.ts",
		});
		expect(requestedRunner({ runner: "jest" })).toEqual({ kind: "jest" });
	});

	it.each([
		[{ runner: "mocha" }],
		[{ jestConfig: "a.js", vitestConfig: "b.ts" }],
		[{ runner: "vitest", jestConfig: "a.js" }],
	])("refuses flags that disagree: %o", (flags) => {
		expect(() => requestedRunner(flags)).toThrow(CliUsageError);
	});
});
