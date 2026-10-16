/**
 * @module
 * Stryker's own Jest runner, loaded by path in each test-runner worker, with
 * two things changed:
 *
 * - The test environment is resolved the way Jest resolves it. Stryker swaps
 *   the environment for one that records coverage, which loads the project's
 *   own by name from the project directory. Under pnpm `jest-environment-node`
 *   is not there: it is one of Jest's own dependencies, and Jest finds it from
 *   its own install. Left to Stryker, the baseline failed in every pnpm
 *   package.
 * - A test file that fails to load counts as a failing baseline test.
 *   Stryker reports it as an error of its own, which read as variant failing
 *   rather than as the tests failing.
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
import type {
	DryRunResult,
	TestResult,
	TestRunner,
} from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import { strykerPlugins as jestPlugins } from "@stryker-mutator/jest-runner";
import { LOAD_FAILURE_SUFFIX } from "./protocol.js";

/** A Jest config as Stryker's runner holds it: the file's, merged with Stryker's. */
export type JestConfig = Record<string, unknown>;

/** The parts of Jest's aggregated results this reads. */
export interface JestResults {
	testResults: ReadonlyArray<{
		testFilePath: string;
		testExecError?: { message?: string } | null;
		testResults: ReadonlyArray<{
			fullName: string;
			status: string;
			duration?: number | null;
			failureMessages?: readonly string[];
		}>;
	}>;
}

interface TestAdapter {
	run: (settings: unknown) => Promise<{ results: JestResults }>;
}

/** Stryker's Jest runner keeps what this reads in plain fields. */
export interface WithJestConfig {
	jestConfig?: JestConfig;
	jestTestAdapter?: TestAdapter;
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

function toPosix(file: string): string {
	return file.split(path.sep).join("/");
}

/** Each test as Stryker's runner reads it, with its file. */
function testsOf(suite: JestResults["testResults"][number]): TestResult[] {
	return suite.testResults.map((test) => {
		const base = {
			id: test.fullName,
			name: test.fullName,
			timeSpentMs: test.duration ?? 0,
			fileName: suite.testFilePath,
		};
		if (test.status === "passed") {
			return { ...base, status: TestStatus.Success };
		}
		if (test.status === "failed") {
			return {
				...base,
				status: TestStatus.Failed,
				failureMessage: (test.failureMessages ?? []).join(", "),
			};
		}
		return { ...base, status: TestStatus.Skipped };
	});
}

/**
 * The baseline with each file Jest could not run added as a failed test:
 * an import that fails, a file with no test in it. Stryker turns such a file
 * into an error of its own, with only the error text. Jest's results say
 * which files they were.
 */
export function withLoadFailures(
	result: DryRunResult,
	results: JestResults | undefined,
	cwd: string,
): DryRunResult {
	if (result.status !== DryRunStatus.Error || results === undefined) {
		return result;
	}
	const failed = results.testResults.filter(
		(suite) =>
			suite.testExecError !== undefined && suite.testExecError !== null,
	);
	if (failed.length === 0) return result;
	const tests: TestResult[] = results.testResults.flatMap((suite) => {
		if (!failed.includes(suite)) return testsOf(suite);
		const name = `${toPosix(path.relative(cwd, suite.testFilePath))}${LOAD_FAILURE_SUFFIX}`;
		return [
			{
				id: `${name}#variant-load`,
				name,
				status: TestStatus.Failed,
				failureMessage:
					suite.testExecError?.message?.split("\n")[0] ??
					"the file failed to load",
				timeSpentMs: 0,
				fileName: suite.testFilePath,
			},
		];
	});
	return { status: DryRunStatus.Complete, tests };
}

/** Keeps what each run of the tests returned, for the runner to read after. */
function recordResults(runner: WithJestConfig): () => JestResults | undefined {
	let last: JestResults | undefined;
	const adapter = runner.jestTestAdapter;
	if (adapter !== undefined && typeof adapter.run === "function") {
		const run = adapter.run.bind(adapter);
		adapter.run = async (settings) => {
			last = undefined;
			const output = await run(settings);
			last = output.results;
			return output;
		};
	}
	return () => last;
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
	const lastResults = recordResults(runner);
	return {
		capabilities: () => runner.capabilities(),
		init: async () => {
			await runner.init?.();
			await withResolvedEnvironment(runner, process.cwd());
		},
		dryRun: async (options) =>
			withLoadFailures(
				await runner.dryRun(options),
				lastResults(),
				process.cwd(),
			),
		mutantRun: (options) => runner.mutantRun(options),
		dispose: async () => runner.dispose?.(),
	};
}
createJestRunner.inject = tokens(commonTokens.injector);

export const strykerPlugins = [
	declareFactoryPlugin(PluginKind.TestRunner, "variant-jest", createJestRunner),
];
