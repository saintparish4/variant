/**
 * @module
 * Stryker's own Jest runner, loaded by path in each test-runner worker, with
 * these things changed:
 *
 * - The test environment is resolved the way Jest resolves it. Stryker swaps
 *   the environment for one that records coverage, which loads the project's
 *   own by name from the project directory. Under pnpm `jest-environment-node`
 *   is not there: it is one of Jest's own dependencies, and Jest finds it from
 *   its own install. Left to Stryker, the baseline failed in every pnpm
 *   package.
 * - Jest's own environments record coverage wherever they load. A test file
 *   can name its environment in a `@jest-environment` comment, and Jest then
 *   loads that one instead of the one Stryker set; the baseline failed with
 *   "Missing coverage results" (Next.js route tests, on dearly).
 * - Where coverage still cannot be measured, the baseline runs again without
 *   it, and every mutation runs against every test.
 * - Coverage of nothing is coverage: with no mutated code run, Stryker read
 *   the empty result as coverage analysis turned off.
 * - A test file that fails to load counts as a failing baseline test.
 *   Stryker reports it as an error of its own, which read as variant failing
 *   rather than as the tests failing.
 * - A config that runs several projects is refused before any test runs.
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
	DryRunOptions,
	DryRunResult,
	TestResult,
	TestRunner,
} from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import {
	strykerPlugins as jestPlugins,
	mixinJestEnvironment,
} from "@stryker-mutator/jest-runner";
import { LOAD_FAILURE_SUFFIX, UNSUPPORTED } from "./protocol.js";

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

/** What this uses of the project's own Jest, the same in Jest 29 and 30. */
export interface ProjectJest {
	normalize: (
		options: JestConfig,
		argv: Record<string, never>,
		configPath: null,
		projectIndex: number,
	) => Promise<{ options: { testEnvironment?: unknown } }>;
	/** An environment's path, as Jest resolves a name it is given. */
	resolveEnvironment: (rootDir: string, name: string) => string;
	/** A module by its absolute path. */
	load: (file: string) => unknown;
}

/** The project's own Jest, found as Stryker finds `jest`. */
export function projectJest(cwd: string): ProjectJest {
	const fromProject = createRequire(path.join(cwd, "package.json"));
	const fromJest = createRequire(fromProject.resolve("jest"));
	const fromJestCli = createRequire(fromJest.resolve("jest-cli"));
	const fromJestConfig = createRequire(fromJestCli.resolve("jest-config"));
	const jestConfig = fromJestCli("jest-config") as Pick<
		ProjectJest,
		"normalize"
	>;
	const jestResolve = fromJestConfig("jest-resolve") as {
		resolveTestEnvironment: (options: {
			rootDir: string;
			testEnvironment: string;
			requireResolveFunction: (id: string) => string;
		}) => string;
	};
	return {
		normalize: (...args) => jestConfig.normalize(...args),
		resolveEnvironment: (rootDir, testEnvironment) =>
			jestResolve.resolveTestEnvironment({
				rootDir,
				testEnvironment,
				requireResolveFunction: (id) => fromJestConfig.resolve(id),
			}),
		load: (file) => fromProject(file),
	};
}

/**
 * The environment the config names, as the path Jest itself would load:
 * from the project first, then from Jest's install, a preset's included.
 * Undefined when it cannot tell, which leaves Stryker's own lookup.
 */
export async function resolvedEnvironment(
	config: JestConfig,
	cwd: string,
	jest: ProjectJest,
): Promise<string | undefined> {
	try {
		// A copy, as Jest is given it: Stryker passes the config on as JSON.
		const copy = JSON.parse(JSON.stringify(config)) as JestConfig;
		const { options } = await jest.normalize(
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

/** The names a `@jest-environment` comment gives Jest's own environments. */
const OWN_ENVIRONMENTS = ["node", "jsdom"];

/**
 * Wraps the environment class in place, in the module Jest will load, with
 * Stryker's coverage recording. Jest loads environments through Node's
 * module cache, so a test file that names this one gets the wrapped class.
 */
function recordCoverageIn(
	jest: ProjectJest,
	rootDir: string,
	name: string,
): void {
	try {
		const exports = jest.load(jest.resolveEnvironment(rootDir, name)) as Record<
			string,
			unknown
		>;
		const original = exports["default"] ?? exports["TestEnvironment"];
		if (typeof original !== "function") return;
		const wrapped = (mixinJestEnvironment as (environment: unknown) => unknown)(
			original,
		);
		for (const key of ["default", "TestEnvironment"]) {
			if (exports[key] === original) exports[key] = wrapped;
		}
	} catch {
		// Not installed (jsdom often is not), or exported in a way this does
		// not know: those files fall back to running without coverage.
	}
}

/**
 * Gives Stryker the environment by path, which its lookup cannot miss, and
 * makes Jest's own environments record coverage wherever a test file names
 * them.
 */
export async function prepareEnvironments(
	runner: WithJestConfig,
	cwd: string,
	loadJest: () => ProjectJest = () => projectJest(cwd),
): Promise<void> {
	const config = runner.jestConfig;
	if (config === undefined) return;
	let jest: ProjectJest;
	try {
		jest = loadJest();
	} catch {
		return;
	}
	const environment = await resolvedEnvironment(config, cwd, jest);
	if (environment !== undefined) {
		runner.jestConfig = { ...config, testEnvironment: environment };
	}
	const rootDir =
		typeof config["rootDir"] === "string" ? config["rootDir"] : cwd;
	for (const name of OWN_ENVIRONMENTS) recordCoverageIn(jest, rootDir, name);
}

/** Why these tests cannot be run as they are configured, if they cannot. */
export function unsupportedSetup(config: JestConfig): string | undefined {
	const projects = config["projects"];
	if (Array.isArray(projects) && projects.length > 0) {
		return "the Jest config runs several projects (`projects`). Run it from one project's directory, with that project's config.";
	}
	return undefined;
}

/**
 * Stryker 10's Jest runner fails the baseline with this when a test file
 * reported no coverage: its environment was not one that records it.
 */
const MISSING_COVERAGE = /^\s*Missing coverage results for:/;

export function coverageMissing(result: DryRunResult): boolean {
	return (
		result.status === DryRunStatus.Error &&
		MISSING_COVERAGE.test(result.errorMessage)
	);
}

/**
 * Stryker's runner verifies that every test file ran with coverage before it
 * returns a complete baseline. No coverage then means no mutated code ran,
 * which is coverage: of nothing.
 */
export function withMeasuredNothing(
	result: DryRunResult,
	coverageAnalysis: string,
): DryRunResult {
	return result.status === DryRunStatus.Complete &&
		coverageAnalysis !== "off" &&
		result.mutantCoverage === undefined
		? { ...result, mutantCoverage: { static: {}, perTest: {} } }
		: result;
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
	const baseline = async (options: DryRunOptions): Promise<DryRunResult> =>
		withLoadFailures(
			await runner.dryRun(options),
			lastResults(),
			process.cwd(),
		);
	return {
		capabilities: () => runner.capabilities(),
		init: async () => {
			await runner.init?.();
			const reason = unsupportedSetup(runner.jestConfig ?? {});
			if (reason !== undefined) throw new Error(`${UNSUPPORTED}${reason}`);
			await prepareEnvironments(runner, process.cwd());
		},
		dryRun: async (options) => {
			const result = await baseline(options);
			if (coverageMissing(result)) {
				return baseline({ ...options, coverageAnalysis: "off" });
			}
			return withMeasuredNothing(result, options.coverageAnalysis);
		},
		mutantRun: (options) => runner.mutantRun(options),
		dispose: async () => runner.dispose?.(),
	};
}
createJestRunner.inject = tokens(commonTokens.injector);

export const strykerPlugins = [
	declareFactoryPlugin(PluginKind.TestRunner, "variant-jest", createJestRunner),
];
