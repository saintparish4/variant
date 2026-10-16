import { describe, expect, it } from "vitest";
import type { JestConfigModule, WithJestConfig } from "../stryker-jest.js";
import { withResolvedEnvironment } from "../stryker-jest.js";

function jestConfig(
	normalize: JestConfigModule["normalize"],
): () => JestConfigModule {
	return () => ({ normalize });
}

describe("the test environment Stryker is given", () => {
	// pnpm: `jest-environment-node` is Jest's dependency, not the project's,
	// and Stryker looks for it in the project.
	it("is the path Jest itself resolves", async () => {
		const runner: WithJestConfig = { jestConfig: { rootDir: "/repo" } };

		await withResolvedEnvironment(
			runner,
			"/repo",
			jestConfig(async (options) => ({
				options: {
					testEnvironment: `/store/jest-environment-node/${String(options["rootDir"])}`,
				},
			})),
		);

		expect(runner.jestConfig).toEqual({
			rootDir: "/repo",
			testEnvironment: "/store/jest-environment-node//repo",
		});
	});

	it("is resolved from cwd where the config names no root", async () => {
		const seen: unknown[] = [];
		await withResolvedEnvironment(
			{ jestConfig: {} },
			"/repo",
			jestConfig(async (options) => {
				seen.push(options["rootDir"]);
				return { options: {} };
			}),
		);

		expect(seen).toEqual(["/repo"]);
	});

	it("is left to Stryker where Jest cannot resolve it", async () => {
		const runner: WithJestConfig = { jestConfig: { testEnvironment: "x" } };

		await withResolvedEnvironment(
			runner,
			"/repo",
			jestConfig(async () => {
				throw new Error("Test environment x cannot be found");
			}),
		);

		expect(runner.jestConfig).toEqual({ testEnvironment: "x" });
	});
});
