/**
 * @module
 * Stryker's own Jest runner, loaded by path in each test-runner worker, with
 * the test environment resolved the way Jest resolves it.
 *
 * Stryker swaps the environment for one that records coverage, which loads
 * the project's own environment by name from the project directory. Under
 * pnpm `jest-environment-node` is not there: it is one of Jest's own
 * dependencies, and Jest finds it from its own install. Left to Stryker, the
 * baseline failed in every pnpm package.
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { Injector, PluginContext } from "@stryker-mutator/api/plugin";
import {
	commonTokens,
	declareFactoryPlugin,
	PluginKind,
	tokens,
} from "@stryker-mutator/api/plugin";
import type { TestRunner } from "@stryker-mutator/api/test-runner";
import { strykerPlugins as jestPlugins } from "@stryker-mutator/jest-runner";

/** A Jest config as Stryker's runner holds it: the file's, merged with Stryker's. */
export type JestConfig = Record<string, unknown>;

/** Stryker's Jest runner keeps its merged config in a plain field. */
export interface WithJestConfig {
	jestConfig?: JestConfig;
}

/** The part of `jest-config` this uses, the same in Jest 29 and 30. */
export interface JestConfigModule {
	normalize: (
		options: JestConfig,
		argv: Record<string, never>,
		configPath: null,
		projectIndex: number,
	) => Promise<{ options: { testEnvironment?: unknown } }>;
}

/** `jest-config` from the project's own Jest, as Stryker finds `jest`. */
export function projectJestConfig(cwd: string): JestConfigModule {
	const fromProject = createRequire(path.join(cwd, "package.json"));
	const fromJest = createRequire(fromProject.resolve("jest"));
	const fromJestCli = createRequire(fromJest.resolve("jest-cli"));
	return fromJestCli("jest-config") as JestConfigModule;
}

/**
 * The environment the config names, as the path Jest itself would load:
 * from the project first, then from Jest's install, a preset's included.
 * Undefined when it cannot tell, which leaves Stryker's own lookup.
 */
export async function resolvedEnvironment(
	config: JestConfig,
	cwd: string,
	loadJestConfig: () => JestConfigModule = () => projectJestConfig(cwd),
): Promise<string | undefined> {
	try {
		// A copy, as Jest is given it: Stryker passes the config on as JSON.
		const copy = JSON.parse(JSON.stringify(config)) as JestConfig;
		const { options } = await loadJestConfig().normalize(
			{ ...copy, rootDir: copy["rootDir"] ?? cwd },
			{},
			null,
			0,
		);
		return typeof options.testEnvironment === "string"
			? options.testEnvironment
			: undefined;
	} catch {
		return undefined;
	}
}

/** Gives Stryker the environment by path, which its lookup cannot miss. */
export async function withResolvedEnvironment(
	runner: WithJestConfig,
	cwd: string,
	loadJestConfig?: () => JestConfigModule,
): Promise<void> {
	const config = runner.jestConfig;
	if (config === undefined) return;
	const environment = await resolvedEnvironment(config, cwd, loadJestConfig);
	if (environment !== undefined) {
		runner.jestConfig = { ...config, testEnvironment: environment };
	}
}

const jest = jestPlugins.find(
	(plugin) => plugin.kind === PluginKind.TestRunner && plugin.name === "jest",
);

function createJestRunner(injector: Injector<PluginContext>): TestRunner {
	if (jest === undefined || !("factory" in jest)) {
		throw new Error("@stryker-mutator/jest-runner has no Jest runner");
	}
	const runner = injector.injectFunction(jest.factory) as TestRunner &
		WithJestConfig;
	return {
		capabilities: () => runner.capabilities(),
		init: async () => {
			await runner.init?.();
			await withResolvedEnvironment(runner, process.cwd());
		},
		dryRun: (options) => runner.dryRun(options),
		mutantRun: (options) => runner.mutantRun(options),
		dispose: async () => runner.dispose?.(),
	};
}
createJestRunner.inject = tokens(commonTokens.injector);

export const strykerPlugins = [
	declareFactoryPlugin(PluginKind.TestRunner, "variant-jest", createJestRunner),
];
