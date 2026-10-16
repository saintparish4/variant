/**
 * @module
 * The options `variant check` runs Stryker with, built from the request
 * alone so that what each runner is given can be tested without running it.
 */

import path from "node:path";
import type {
	LogLevel,
	PartialStrykerOptions,
} from "@stryker-mutator/api/core";
import type { RunnerKind } from "../../core/check/runner.js";
import type { HostRequest } from "./protocol.js";
import { EXCLUDED_MUTATORS } from "./protocol.js";

/** Stryker's own runner for each test runner, resolved from variant's install. */
export const RUNNER_PACKAGES: Readonly<Record<RunnerKind, string>> = {
	vitest: "@stryker-mutator/vitest-runner",
	jest: "@stryker-mutator/jest-runner",
};

export interface OptionsContext {
	/** The package directory, where the host runs. */
	cwd: string;
	/** Where this runner's package (`RUNNER_PACKAGES`) resolved. */
	runnerPlugin: string;
	/** False where Stryker cannot rewrite the tsconfig (TypeScript 7). */
	rewriteTsconfig: boolean;
}

/**
 * Stryker types its log levels as a `const enum`, which a bundler compiling
 * one file at a time cannot inline from another package. The values are these
 * strings.
 */
function logLevel(value: "off" | "error"): LogLevel {
	return value as unknown as LogLevel;
}

function runnerOptions(
	request: HostRequest,
	context: OptionsContext,
): PartialStrykerOptions {
	const { configFile, nodeArgs } = request.runner;
	if (request.runner.kind === "jest") {
		return {
			// Stryker's Jest runner with the environment resolved as Jest
			// resolves it: see stryker-jest.ts.
			testRunner: "variant-jest",
			...(nodeArgs !== undefined && { testRunnerNodeArgs: nodeArgs }),
			jest: {
				projectType: "custom",
				...(configFile !== undefined && { configFile }),
				// As `vitest.related`: Jest's guess at related tests would
				// narrow the baseline too, not only each mutant's run.
				enableFindRelatedTests: false,
				// Merged over the project's config. Stryker itself already turns
				// off coverage, reporters and a results processor.
				config: {
					// Watchman would watch from the repository root, outside the
					// copy the tests run in.
					watchman: false,
					// Jest caches transformed files across runs; the mutated ones
					// stay with the run and go with it.
					cacheDirectory: path.join(
						context.cwd,
						request.tempDirName,
						"jest-cache",
					),
				},
			},
		};
	}
	return {
		// Stryker's Vitest runner, made to count a test file that fails to
		// load: see stryker-vitest.ts.
		testRunner: "variant-vitest",
		vitest: {
			// The whole configured suite in the baseline, so each mutant's
			// tests come from measured coverage, not from Vitest's guess at
			// which tests relate to the file.
			related: false,
			...(configFile !== undefined && { configFile }),
		},
	};
}

export function strykerOptions(
	request: HostRequest,
	context: OptionsContext,
): PartialStrykerOptions {
	return {
		// Pointed at a file that does not exist, Stryker's tsconfig
		// preprocessor skips, which beats failing every run on TypeScript 7.
		...(!context.rewriteTsconfig && {
			tsconfigFile: `${request.tempDirName}.no-tsconfig.json`,
		}),
		configFile: request.configFile,
		...runnerOptions(request, context),
		mutate: request.mutate,
		mutator: { excludedMutations: [...EXCLUDED_MUTATORS] },
		// Setting `plugins` replaces Stryker's default, which looks only
		// beside Stryker's own package.
		plugins: [context.runnerPlugin],
		appendPlugins: request.plugins,
		reporters: ["variant"],
		tempDirName: request.tempDirName,
		cleanTempDir: "always",
		ignorePatterns: ["/.variant"],
		fileLogLevel: logLevel("off"),
		// Stryker names the failing baseline tests only in its log.
		logLevel: logLevel("error"),
		incremental: false,
		thresholds: { high: 80, low: 60, break: null },
		dryRunTimeoutMinutes: request.baselineTimeoutMinutes,
	};
}
