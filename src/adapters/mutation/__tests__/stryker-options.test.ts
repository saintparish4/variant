import { describe, expect, it } from "vitest";
import type { HostRequest } from "../protocol.js";
import { EXCLUDED_MUTATORS } from "../protocol.js";
import { strykerOptions } from "../stryker-options.js";

function request(overrides: Partial<HostRequest> = {}): HostRequest {
	return {
		mutate: ["src/discount.ts:2-2"],
		runner: { kind: "vitest" },
		baselineTimeoutMinutes: 5,
		tempDirName: ".variant/check-tmp/run",
		configFile: ".variant/check-tmp/run.json",
		plugins: ["/variant/stryker-reporter.js", "/variant/stryker-vitest.js"],
		...overrides,
	};
}

const context = {
	runnerPlugin: "/variant/vitest-runner",
	rewriteTsconfig: true,
};

describe("the options Stryker runs with", () => {
	it("runs Vitest's whole configured suite in the baseline, through variant's runner", () => {
		const options = strykerOptions(request(), context);

		expect(options.testRunner).toBe("variant-vitest");
		expect(options["vitest"]).toEqual({ related: false });
	});

	it("passes on the Vitest config it was given", () => {
		const options = strykerOptions(
			request({ runner: { kind: "vitest", configFile: "vitest.unit.ts" } }),
			context,
		);

		expect(options["vitest"]).toEqual({
			related: false,
			configFile: "vitest.unit.ts",
		});
	});

	it("loads Stryker's runner first and variant's plugins after it", () => {
		const options = strykerOptions(request(), context);

		expect(options.plugins).toEqual(["/variant/vitest-runner"]);
		expect(options.appendPlugins).toEqual([
			"/variant/stryker-reporter.js",
			"/variant/stryker-vitest.js",
		]);
		expect(options.reporters).toEqual(["variant"]);
	});

	it("never merges a Stryker config from the project", () => {
		expect(strykerOptions(request(), context)["configFile"]).toBe(
			".variant/check-tmp/run.json",
		);
	});

	it("mutates only what it was asked to, with variant's mutators", () => {
		const options = strykerOptions(request(), context);

		expect(options.mutate).toEqual(["src/discount.ts:2-2"]);
		expect(options.mutator).toEqual({
			excludedMutations: [...EXCLUDED_MUTATORS],
		});
		expect(options.incremental).toBe(false);
		expect(options.thresholds?.break).toBeNull();
	});

	it("skips the tsconfig rewrite where TypeScript has no JavaScript API", () => {
		expect(strykerOptions(request(), context).tsconfigFile).toBeUndefined();
		expect(
			strykerOptions(request(), { ...context, rewriteTsconfig: false })
				.tsconfigFile,
		).toBe(".variant/check-tmp/run.no-tsconfig.json");
	});
});
