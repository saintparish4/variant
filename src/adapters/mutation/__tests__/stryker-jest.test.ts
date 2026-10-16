import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	DryRunResult,
	TestResult,
} from "@stryker-mutator/api/test-runner";
import { DryRunStatus, TestStatus } from "@stryker-mutator/api/test-runner";
import { afterEach, describe, expect, it } from "vitest";
import type {
	JestResults,
	ProjectJest,
	WithJestConfig,
} from "../stryker-jest.js";
import {
	coverageMissing,
	filesToRun,
	prepareJest,
	runOnly,
	sharedTestFiles,
	shareTestFiles,
	testFiles,
	unsupportedSetup,
	withLoadFailures,
	withMeasuredNothing,
} from "../stryker-jest.js";

class NodeEnvironment {}

/** A project's Jest, with its Node environment module in `modules`. */
function projectJest(
	normalize: ProjectJest["normalize"],
	modules: Record<string, Record<string, unknown>> = {},
): () => ProjectJest {
	return () => ({
		normalize,
		resolveEnvironment: (_, name) => `/store/jest-environment-${name}.js`,
		load: (file) => {
			const found = modules[file];
			if (found === undefined) throw new Error(`Cannot find ${file}`);
			return found;
		},
	});
}

describe("the test environment Stryker is given", () => {
	// pnpm: `jest-environment-node` is Jest's dependency, not the project's,
	// and Stryker looks for it in the project.
	it("is the path Jest itself resolves", async () => {
		const runner: WithJestConfig = { jestConfig: { rootDir: "/repo" } };

		await prepareJest(
			runner,
			"/repo",
			projectJest(async (options) => ({
				options: {
					testEnvironment: `/store/${String(options["rootDir"])}/env.js`,
				},
			})),
		);

		expect(runner.jestConfig).toEqual({
			rootDir: "/repo",
			testEnvironment: "/store//repo/env.js",
		});
	});

	it("is resolved from cwd where the config names no root", async () => {
		const seen: unknown[] = [];
		await prepareJest(
			{ jestConfig: {} },
			"/repo",
			projectJest(async (options) => {
				seen.push(options["rootDir"]);
				return { options: {} };
			}),
		);

		expect(seen).toEqual(["/repo"]);
	});

	it("is left to Stryker where Jest cannot resolve it", async () => {
		const runner: WithJestConfig = { jestConfig: { testEnvironment: "x" } };

		await prepareJest(
			runner,
			"/repo",
			projectJest(async () => {
				throw new Error("Test environment x cannot be found");
			}),
		);

		expect(runner.jestConfig).toEqual({ testEnvironment: "x" });
	});

	// A `@jest-environment node` comment makes Jest load Node's environment
	// itself, not the one Stryker set, and that file reported no coverage.
	it("records coverage in Jest's own environments wherever they load", async () => {
		const node = { default: NodeEnvironment, TestEnvironment: NodeEnvironment };

		await prepareJest(
			{ jestConfig: { rootDir: "/repo" } },
			"/repo",
			projectJest(async () => ({ options: {} }), {
				"/store/jest-environment-node.js": node,
			}),
		);

		expect(node.default).not.toBe(NodeEnvironment);
		expect(Object.getPrototypeOf(node.default)).toBe(NodeEnvironment);
		expect(node.TestEnvironment).toBe(node.default);
	});
});

describe("a Jest baseline's coverage", () => {
	it("counts no mutated code run as coverage of nothing", () => {
		const complete: DryRunResult = { status: DryRunStatus.Complete, tests: [] };

		expect(withMeasuredNothing(complete, "perTest")).toEqual({
			...complete,
			mutantCoverage: { static: {}, perTest: {} },
		});
		// Run without coverage on purpose: there is nothing to read.
		expect(withMeasuredNothing(complete, "off")).toBe(complete);
	});

	it("knows Stryker's error for a test file that reported no coverage", () => {
		// Stryker 10's message, as it begins.
		const missing: DryRunResult = {
			status: DryRunStatus.Error,
			errorMessage:
				"\nMissing coverage results for:\n  * src/route.test.ts\n\nYou probably configured a test environment in jest that is not reporting code coverage to Stryker.",
		};

		expect(coverageMissing(missing)).toBe(true);
		expect(
			coverageMissing({ status: DryRunStatus.Error, errorMessage: "boom" }),
		).toBe(false);
	});
});

describe("a Jest setup check does not run", () => {
	const repo = path.resolve("/repo");

	it("is a config with projects", () => {
		expect(unsupportedSetup({ projects: ["<rootDir>/a"] }, repo)).toMatch(
			/projects/,
		);
		expect(unsupportedSetup({ projects: [] }, repo)).toBeUndefined();
		expect(unsupportedSetup({}, repo)).toBeUndefined();
	});

	// check runs the tests in a copy of the package: tests found outside it
	// would run the real files, and write snapshots beside them.
	it("is a config whose rootDir is outside the package", () => {
		expect(unsupportedSetup({ rootDir: path.dirname(repo) }, repo)).toMatch(
			/outside the package \(`rootDir`\)/,
		);
		expect(
			unsupportedSetup({ rootDir: path.join(repo, "src") }, repo),
		).toBeUndefined();
	});

	it("is a config with a root outside the package", () => {
		expect(
			unsupportedSetup({ rootDir: repo, roots: ["<rootDir>/../shared"] }, repo),
		).toMatch(/outside the package \(`roots`\)/);
		expect(
			unsupportedSetup(
				{ rootDir: repo, roots: ["<rootDir>/src", path.join(repo, "test")] },
				repo,
			),
		).toBeUndefined();
	});

	it("is read from Jest's own reading of the config, a preset's roots included", () => {
		expect(
			unsupportedSetup({ rootDir: repo, preset: "shared" }, repo, {
				rootDir: repo,
				roots: [path.resolve("/elsewhere")],
			}),
		).toMatch(/`roots`/);
	});

	it("does not take a directory named like a parent for one", () => {
		expect(
			unsupportedSetup({ rootDir: repo, roots: ["<rootDir>/..cache"] }, repo),
		).toBeUndefined();
	});

	it("is found before the environments are touched", async () => {
		const outside = path.dirname(repo);
		const runner: WithJestConfig = { jestConfig: { rootDir: outside } };

		const reason = await prepareJest(
			runner,
			repo,
			projectJest(async () => ({
				options: { rootDir: outside, testEnvironment: "/store/env.js" },
			})),
		);

		expect(reason).toMatch(/`rootDir`/);
		expect(runner.jestConfig).toEqual({ rootDir: outside });
	});
});

describe("a Jest baseline with files that did not load", () => {
	const cwd = path.resolve("/sandbox");
	const file = (name: string) => path.join(cwd, "src", name);
	// What Stryker 10's Jest runner returns when a suite fails to run.
	const error: DryRunResult = {
		status: DryRunStatus.Error,
		errorMessage:
			"MODULE_NOT_FOUND Cannot find module './missing' from 'src/broken.test.ts' Error: ...",
	};
	// Jest 30's aggregated results for the same run, as far as they are read.
	const results: JestResults = {
		testResults: [
			{
				testFilePath: file("discount.test.ts"),
				testResults: [
					{ fullName: "q accepts 150", status: "passed", duration: 2 },
					{ fullName: "q is pending", status: "pending" },
					{
						fullName: "q rejects 50",
						status: "failed",
						failureMessages: ["expected false"],
					},
				],
			},
			{
				testFilePath: file("broken.test.ts"),
				testExecError: {
					message:
						"Cannot find module './missing' from 'src/broken.test.ts'\n\n  at ...",
				},
				testResults: [],
			},
			{
				testFilePath: file("empty.test.ts"),
				testExecError: {
					message: "Your test suite must contain at least one test.",
				},
				testResults: [],
			},
		],
	};

	it("adds each file as a failed test named for it, beside the other tests", () => {
		const result = withLoadFailures(error, results, cwd);

		expect(result.status).toBe(DryRunStatus.Complete);
		if (result.status !== DryRunStatus.Complete) return;
		expect(result.tests.map((test) => [test.name, test.status])).toEqual([
			["q accepts 150", TestStatus.Success],
			["q is pending", TestStatus.Skipped],
			["q rejects 50", TestStatus.Failed],
			["src/broken.test.ts (did not load)", TestStatus.Failed],
			["src/empty.test.ts (did not load)", TestStatus.Failed],
		]);
		expect(result.tests[3]).toMatchObject({
			failureMessage:
				"Cannot find module './missing' from 'src/broken.test.ts'",
		});
	});

	it("leaves any other error to Stryker", () => {
		const clean: JestResults = {
			testResults: [{ testFilePath: file("a.test.ts"), testResults: [] }],
		};

		expect(withLoadFailures(error, clean, cwd)).toBe(error);
		expect(withLoadFailures(error, undefined, cwd)).toBe(error);
	});

	it("leaves a baseline that completed alone", () => {
		const complete: DryRunResult = { status: DryRunStatus.Complete, tests: [] };

		expect(withLoadFailures(complete, results, cwd)).toBe(complete);
	});
});

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("the test files a mutant runs", () => {
	const passed = (id: string, fileName: string): TestResult => ({
		id,
		name: id,
		status: TestStatus.Success,
		timeSpentMs: 1,
		fileName,
	});
	const files = testFiles([
		passed("q accepts 150", "/repo/a.test.ts"),
		passed("q rejects 50", "/repo/a.test.ts"),
		// The same full name in two files: Stryker cannot tell them apart.
		passed("setup works", "/repo/a.test.ts"),
		passed("setup works", "/repo/b.test.ts"),
		passed("other", "/repo/c.test.ts"),
	]);

	it("are the files holding the tests that reach it, each once", () => {
		expect(filesToRun(["q accepts 150", "q rejects 50"], files)).toEqual([
			"/repo/a.test.ts",
		]);
		expect(filesToRun(["setup works"], files)).toEqual([
			"/repo/a.test.ts",
			"/repo/b.test.ts",
		]);
	});

	it("are every file where there is no filter or a test cannot be placed", () => {
		// No filter: a mutant reached as a module loads.
		expect(filesToRun(undefined, files)).toBeUndefined();
		expect(filesToRun([], files)).toBeUndefined();
		expect(filesToRun(["q accepts 150", "unknown"], files)).toBeUndefined();
		// A worker that found no baseline to read.
		expect(filesToRun(["q accepts 150"], undefined)).toBeUndefined();
	});

	it("reach the workers that did not run the baseline", () => {
		const cacheDirectory = path.join(
			mkdtempSync(path.join(tmpdir(), "variant-jest-")),
			"jest-cache",
		);
		directories.push(path.dirname(cacheDirectory));

		shareTestFiles(files, { cacheDirectory });

		expect(sharedTestFiles({ cacheDirectory })).toEqual(files);
		expect(sharedTestFiles({})).toBeUndefined();
		expect(
			sharedTestFiles({ cacheDirectory: path.join(cacheDirectory, "none") }),
		).toBeUndefined();
	});

	it("are given to Jest by path, with the rest of what Stryker asked for", async () => {
		const seen: Record<string, unknown>[] = [];
		const runner: WithJestConfig = {
			jestWrapper: {
				runCLI: async (argv) => {
					seen.push(argv);
					return {};
				},
			},
		};
		let only: string[] | undefined = ["/repo/a.test.ts"];
		runOnly(runner, () => only);
		const asked = {
			_: [],
			findRelatedTests: false,
			testNamePattern: "(q accepts 150)",
		};

		await runner.jestWrapper?.runCLI(asked, ["/repo"]);
		only = undefined;
		await runner.jestWrapper?.runCLI(asked, ["/repo"]);

		expect(seen).toEqual([
			{ ...asked, _: ["/repo/a.test.ts"], runTestsByPath: true },
			asked,
		]);
	});
});
