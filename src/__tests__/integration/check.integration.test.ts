/**
 * Boundary: `variant check` meeting real git, a real StrykerJS and a real
 * Vitest or Jest, on a copy of `examples/check-demo` or its Jest twin. These
 * run the engine for real, so each takes seconds, not milliseconds.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStrykerBackend } from "../../adapters/mutation/stryker.js";
import type { CheckOptions } from "../../core/check/run.js";
import { checkDeps, runCheck } from "../../core/check/run.js";
import { BaselineFailedError, CheckRunnerError } from "../../core/errors.js";
import {
	cleanupTempWorkspaces,
	createTempWorkspace,
} from "../helpers/cli-harness.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ADAPTER = path.join(REPO, "src", "adapters", "mutation");
const TIMEOUT = 120_000;

// The host is TypeScript here, not the build: Stryker runs it, and loads the
// reporter, through tsx.
const backend = createStrykerBackend({
	hostPath: path.join(ADAPTER, "stryker-host.ts"),
	plugins: {
		reporter: path.join(ADAPTER, "stryker-reporter.ts"),
		vitest: path.join(ADAPTER, "stryker-vitest.ts"),
		jest: path.join(ADAPTER, "stryker-jest.ts"),
	},
	execArgv: ["--import", import.meta.resolve("tsx")],
	env: {
		// Stryker's workers load the plugins too, and do not inherit execArgv.
		NODE_OPTIONS: `--import ${import.meta.resolve("tsx")}`,
		// pnpm's command shims point this at every package in its store, which
		// a user running variant some other way does not have.
		NODE_PATH: "",
	},
});

interface Demo {
	runner: "vitest" | "jest";
	example: string;
	/** Linked into the copy's `node_modules` from variant's own install. */
	packages: string[];
	/** Committed before the change. */
	setup: string[];
	/** What a test file starts with to use the runner's API. */
	header: string;
}

const VITEST: Demo = {
	runner: "vitest",
	example: "check-demo",
	packages: ["vitest"],
	setup: ["package.json", "vitest.config.ts", ".gitignore"],
	header: 'import { it } from "vitest";\n',
};

// Only Jest and the transform are linked, as pnpm would install them: the
// test environment, among others, is Jest's dependency and not the project's.
const JEST: Demo = {
	runner: "jest",
	example: "check-demo-jest",
	packages: [
		"jest",
		"@babel/core",
		"@babel/preset-typescript",
		"@babel/plugin-transform-modules-commonjs",
	],
	setup: ["package.json", "babel.config.js", ".gitignore"],
	header: "",
};

/** git in `dir`, with a fixed identity, returning what it printed. */
function git(dir: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=variant",
			"-c",
			"user.email=variant@example.com",
			...args,
		],
		{ cwd: dir, encoding: "utf8" },
	);
}

afterEach(() => {
	cleanupTempWorkspaces();
	vi.unstubAllEnvs();
});

/**
 * The demo with its setup committed and the discount rule staged: the change
 * a developer is about to commit. `node_modules` is a real directory holding
 * links to the runner and a sentinel, so a cleanup that followed a link out
 * of the sandbox would show.
 */
function demoRepository(demo: Demo = VITEST): string {
	const dir = createTempWorkspace("check");
	cpSync(path.join(REPO, "examples", demo.example), dir, { recursive: true });
	for (const name of demo.packages) {
		const link = path.join(dir, "node_modules", name);
		mkdirSync(path.dirname(link), { recursive: true });
		symlinkSync(
			realpathSync(path.join(REPO, "node_modules", name)),
			link,
			process.platform === "win32" ? "junction" : "dir",
		);
	}
	writeFileSync(path.join(dir, "node_modules", ".sentinel"), "keep\n");
	writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", ...demo.setup);
	git(dir, "commit", "-qm", "setup");
	git(dir, "add", "src");
	return dir;
}

function check(dir: string, options: Partial<CheckOptions> = {}) {
	return runCheck(
		dir,
		{ maxMutants: 50, budgetMs: 100_000, ...options },
		checkDeps(dir, backend),
	);
}

function addBoundaryTest(dir: string): void {
	const file = path.join(dir, "src", "discount.test.ts");
	writeFileSync(
		file,
		readFileSync(file, "utf8").replace(
			`	it("accepts a large order", () => {`,
			`	it("accepts an order of exactly 100", () => {
		expect(qualifiesForDiscount(100)).toBe(true);
	});

	it("accepts a large order", () => {`,
		),
	);
}

/** Every file under `dir` but git's and node_modules', with its hash. */
function treeHashes(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (sub: string): void => {
		for (const name of readdirSync(path.join(dir, sub))) {
			const rel = path.join(sub, name);
			if (name === ".git" || name === "node_modules") continue;
			const full = path.join(dir, rel);
			if (statSync(full).isDirectory()) walk(rel);
			else {
				out[rel.replace(/\\/g, "/")] = createHash("sha256")
					.update(readFileSync(full))
					.digest("hex");
			}
		}
	};
	walk("");
	return out;
}

function gitState(dir: string) {
	return {
		status: git(dir, "status", "--porcelain=v2", "--untracked-files=all"),
		unstaged: git(dir, "diff"),
		staged: git(dir, "diff", "--cached"),
		files: treeHashes(dir),
	};
}

describe.each([
	["Vitest", VITEST],
	["Jest", JEST],
])("variant check with %s", (_, demo) => {
	it(
		"reports the boundary mutation the tests did not notice",
		async () => {
			const dir = demoRepository(demo);

			const result = await check(dir);

			expect(result.base.ref).toBe("HEAD");
			expect(result.baseline).toEqual({ tests: 2, files: 1, skipped: 0 });
			const undetected = result.mutants.filter(
				(m) => m.outcome === "undetected",
			);
			expect(undetected).toHaveLength(1);
			expect(undetected[0]).toMatchObject({
				file: "src/discount.ts",
				start: { line: 3, column: 9 },
				original: "total >= 100",
				replacement: "total > 100",
				symbol: "qualifiesForDiscount",
				explanation:
					"Changing >= to > went undetected. Review the behavior at total = 100.",
			});
			// Only the groups variant keeps: no block or string mutations.
			expect(new Set(result.mutants.map((m) => m.mutator))).toEqual(
				new Set(["ConditionalExpression", "EqualityOperator"]),
			);
			expect(result.status).toBe("complete");
		},
		TIMEOUT,
	);

	it(
		"detects that mutation once a test checks the boundary",
		async () => {
			const dir = demoRepository(demo);
			addBoundaryTest(dir);

			const result = await check(dir);

			expect(result.counts.undetected).toBe(0);
			expect(result.counts.detected).toBe(result.counts.attempted);
			expect(result.status).toBe("complete");
		},
		TIMEOUT,
	);

	it(
		"interprets nothing when a test fails before any mutation",
		async () => {
			const dir = demoRepository(demo);
			const file = path.join(dir, "src", "discount.test.ts");
			writeFileSync(
				file,
				readFileSync(file, "utf8").replace(
					"qualifiesForDiscount(50)).toBe(false)",
					"qualifiesForDiscount(50)).toBe(true)",
				),
			);

			const error = await check(dir).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(BaselineFailedError);
			expect((error as BaselineFailedError).failingTests).toEqual([
				expect.objectContaining({
					name: "qualifiesForDiscount rejects a small order",
				}),
			]);
		},
		TIMEOUT,
	);

	// pyra: a test file importing a module that did not exist yet produced no
	// tests, and the baseline read as passing without it.
	it.each([
		[
			"imports a module that does not exist",
			'import { missing } from "./not-written-yet";\n\nit("uses it", () => missing());\n',
		],
		["holds no test", 'import "./discount";\n'],
	])(
		"counts a test file that %s as a failing baseline",
		async (_, body) => {
			const dir = demoRepository(demo);
			writeFileSync(
				path.join(dir, "src", "broken.test.ts"),
				`${demo.header}${body}`,
			);
			git(dir, "add", "src/broken.test.ts");

			const error = await check(dir).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(BaselineFailedError);
			expect((error as BaselineFailedError).failingTests).toEqual([
				expect.objectContaining({ name: "src/broken.test.ts (did not load)" }),
			]);
		},
		TIMEOUT,
	);

	// dearly: the engine reads a file it is given as a glob, so `[id]`, a
	// Next.js dynamic route, was a character class, and naming it with the
	// changed lines failed the whole run.
	it(
		"mutates a changed file under a Next.js dynamic route directory",
		async () => {
			const dir = demoRepository(demo);
			const route = path.join(dir, "src", "letters", "[id]");
			mkdirSync(route, { recursive: true });
			writeFileSync(
				path.join(route, "limit.ts"),
				"export const overLimit = (n: number): boolean => n > 10;\n",
			);
			writeFileSync(
				path.join(route, "limit.test.ts"),
				[
					`${demo.header}import { overLimit } from "./limit";`,
					"",
					'it("flags a large count", () => {',
					'\tif (!overLimit(20)) throw new Error("expected 20 to be over");',
					"});",
					"",
				].join("\n"),
			);
			git(dir, "add", "src/letters");

			const result = await check(dir);

			const inRoute = result.mutants.filter(
				(m) => m.file === "src/letters/[id]/limit.ts",
			);
			expect(inRoute.length).toBeGreaterThan(0);
			// `n >= 10`: the test checks 20 only.
			expect(inRoute.some((m) => m.outcome === "undetected")).toBe(true);
		},
		TIMEOUT,
	);

	// Filtering a mutant's tests by name alone still has the runner load and
	// set up every test file to find them: 2.1 s a mutant against 70 ms by
	// file, in a 41-file suite.
	it(
		"runs each mutation against only the test files whose tests reach it",
		async () => {
			const dir = demoRepository(demo);
			const log = path.join(createTempWorkspace("check-log"), "loads.log");
			writeFileSync(
				path.join(dir, "src", "other.test.ts"),
				[
					`import { appendFileSync } from "node:fs";\n${demo.header}`,
					`appendFileSync(${JSON.stringify(log)}, "loaded\\n");`,
					"",
					'it("checks something else", () => {});',
					"",
				].join("\n"),
			);
			git(dir, "add", "src/other.test.ts");

			const result = await check(dir);

			expect(result.counts.undetected).toBe(1);
			expect(result.mutants.length).toBeGreaterThan(1);
			// Once, in the baseline; no mutated line runs in it.
			expect(readFileSync(log, "utf8")).toBe("loaded\n");
		},
		TIMEOUT,
	);

	// pyra: when no mutated code ran in the baseline, Stryker read the empty
	// coverage as "coverage analysis off", ran every mutation against every
	// test and called code no test imports "undetected".
	it(
		"reports a changed file no test imports as reached by no test",
		async () => {
			const dir = demoRepository(demo);
			git(dir, "commit", "-qm", "discount");
			writeFileSync(
				path.join(dir, "src", "shipping.ts"),
				"export const heavy = (kg: number): boolean => kg > 20;\n",
			);

			const result = await check(dir);

			expect(result.mutants.length).toBeGreaterThan(0);
			expect(new Set(result.mutants.map((m) => m.outcome))).toEqual(
				new Set(["no-coverage"]),
			);
		},
		TIMEOUT,
	);

	it(
		"stops at --max-mutants, says so, and picks the same mutants every time",
		async () => {
			const dir = demoRepository(demo);

			const first = await check(dir, { maxMutants: 1 });
			const second = await check(dir, { maxMutants: 1 });

			expect(first.status).toBe("incomplete");
			expect(first.stopReason).toBe("limit");
			expect(first.counts.attempted).toBe(1);
			const tried = (result: typeof first) =>
				result.mutants
					.filter((m) => m.outcome !== "not-run")
					.map((m) => `${m.start.line}:${m.start.column} ${m.replacement}`);
			expect(tried(second)).toEqual(tried(first));
		},
		TIMEOUT,
	);

	it(
		"reports a run the budget cut short as incomplete, never as clean",
		async () => {
			const dir = demoRepository(demo);

			const result = await check(dir, { budgetMs: 1_000 });

			expect(result.status).toBe("incomplete");
			expect(result.stopReason).toBe("budget");
		},
		TIMEOUT,
	);

	it(
		"leaves staged, unstaged and untracked work exactly as it was",
		async () => {
			const dir = demoRepository(demo);
			addBoundaryTest(dir); // unstaged, on top of the staged change
			writeFileSync(
				path.join(dir, "src", "draft.ts"),
				"export const big = (n: number) => n > 10;\n",
			);
			const before = gitState(dir);

			const result = await check(dir);

			expect(gitState(dir)).toEqual(before);
			expect(existsSync(path.join(dir, ".variant"))).toBe(false);
			// A new file git does not track yet is mutated, not ignored.
			expect(result.files).toContainEqual(
				expect.objectContaining({ file: "src/draft.ts", untracked: true }),
			);
		},
		TIMEOUT,
	);

	// Windows CI could not remove a project after a normal run: a test worker
	// or esbuild process outlived it, because the host exited by itself and
	// cut the tree. Linux shows the same thing through /proc.
	it.skipIf(process.platform !== "linux")(
		"leaves no process running in the project after a normal run",
		async () => {
			const dir = demoRepository(demo);

			await check(dir);

			const real = realpathSync(dir);
			const inside = readdirSync("/proc")
				.filter((entry) => /^\d+$/.test(entry))
				.filter((pid) => {
					try {
						return realpathSync(`/proc/${pid}/cwd`).startsWith(real);
					} catch {
						return false;
					}
				});
			expect(inside).toEqual([]);
		},
		TIMEOUT,
	);

	it(
		"keeps the real node_modules intact when a run is killed part-way",
		async () => {
			const dir = demoRepository(demo);

			const result = await check(dir, { budgetMs: 2_500 });

			expect(result.status).toBe("incomplete");
			expect(
				readFileSync(path.join(dir, "node_modules", ".sentinel"), "utf8"),
			).toBe("keep\n");
			for (const name of demo.packages) {
				expect(existsSync(path.join(dir, "node_modules", name))).toBe(true);
			}
			expect(existsSync(path.join(dir, ".variant"))).toBe(false);
		},
		TIMEOUT,
	);

	// A pre-commit hook runs with these set, pointing at the real repository.
	// A test that runs git inside the sandbox must not reach it.
	it(
		"keeps git run by the tests away from the real repository's index",
		async () => {
			const dir = demoRepository(demo);
			writeFileSync(
				path.join(dir, "src", "uses-git.test.ts"),
				[
					`import { execSync } from "node:child_process";\n${demo.header}`,
					'it("stages whatever it can see", () => {',
					"\ttry {",
					'\t\texecSync("git add -A", { stdio: "ignore" });',
					"\t} catch {}",
					"});",
					"",
				].join("\n"),
			);
			git(dir, "add", "src/uses-git.test.ts");
			const staged = git(dir, "diff", "--cached", "--name-only");
			vi.stubEnv("GIT_DIR", path.join(dir, ".git"));
			vi.stubEnv("GIT_INDEX_FILE", path.join(dir, ".git", "index"));

			await check(dir);

			vi.unstubAllEnvs();
			expect(git(dir, "diff", "--cached", "--name-only")).toBe(staged);
		},
		TIMEOUT,
	);

	it(
		"ignores a Stryker config in the project",
		async () => {
			const dir = demoRepository(demo);
			writeFileSync(
				path.join(dir, "stryker.config.json"),
				JSON.stringify({ mutate: ["nothing/**"], reporters: ["html"] }),
			);

			const result = await check(dir);

			expect(result.counts.undetected).toBe(1);
			expect(existsSync(path.join(dir, "reports"))).toBe(false);
		},
		TIMEOUT,
	);
});

describe("variant check with Jest only", () => {
	/** Puts a `@jest-environment` comment at the top of the demo's test file. */
	function withEnvironmentComment(dir: string, environment: string): void {
		const file = path.join(dir, "src", "discount.test.ts");
		writeFileSync(
			file,
			`/**\n * @jest-environment ${environment}\n */\n${readFileSync(file, "utf8")}`,
		);
	}

	function withUnreachedFile(dir: string): void {
		writeFileSync(
			path.join(dir, "src", "shipping.ts"),
			"export const heavy = (kg: number): boolean => kg > 20;\n",
		);
	}

	// Next.js route tests name their environment this way. Jest then loads
	// that environment instead of the one Stryker set, and those files
	// reported no coverage.
	it(
		"measures coverage through a test file that names its environment",
		async () => {
			const dir = demoRepository(JEST);
			withEnvironmentComment(dir, "node");
			withUnreachedFile(dir);

			const result = await check(dir);

			expect(result.coverageMeasured).toBe(true);
			expect(result.counts.undetected).toBe(1);
			expect(
				result.mutants
					.filter((m) => m.file === "src/shipping.ts")
					.every((m) => m.outcome === "no-coverage"),
			).toBe(true);
		},
		TIMEOUT,
	);

	it(
		"runs every mutation against every test where coverage cannot be measured, and says so",
		async () => {
			const dir = demoRepository(JEST);
			// Jest's Node environment, loaded as a copy of its own: an
			// environment variant has no way into.
			writeFileSync(
				path.join(dir, "env.js"),
				[
					'const { createRequire } = require("node:module");',
					'const fromJest = createRequire(require.resolve("jest"));',
					'const fromCli = createRequire(fromJest.resolve("jest-cli"));',
					'const fromConfig = createRequire(fromCli.resolve("jest-config"));',
					'const file = fromConfig.resolve("jest-environment-node");',
					"delete require.cache[file];",
					"module.exports = require(file).TestEnvironment;",
					"",
				].join("\n"),
			);
			withEnvironmentComment(dir, "./env.js");

			const result = await check(dir);

			expect(result.coverageMeasured).toBe(false);
			expect(result.notes).toContainEqual(expect.stringMatching(/coverage/i));
			expect(result.counts.undetected).toBe(1);
			expect(result.status).toBe("complete");
		},
		TIMEOUT,
	);

	it(
		"refuses a Jest config that runs several projects, before running any test",
		async () => {
			const dir = demoRepository(JEST);
			writeFileSync(
				path.join(dir, "jest.config.js"),
				'module.exports = { projects: [{ displayName: "unit" }] };\n',
			);

			const error = await check(dir).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(CheckRunnerError);
			expect((error as CheckRunnerError).message).toMatch(/projects/);
			expect(existsSync(path.join(dir, ".variant"))).toBe(false);
		},
		TIMEOUT,
	);

	// An absolute rootDir names the real package from inside the copy: Jest
	// would run the real, unmutated files, and write snapshots beside them.
	it(
		"refuses a Jest config that looks for tests outside the package, before running any test",
		async () => {
			const dir = demoRepository(JEST);
			writeFileSync(
				path.join(dir, "jest.config.js"),
				`module.exports = { rootDir: ${JSON.stringify(dir)} };\n`,
			);

			const error = await check(dir).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(CheckRunnerError);
			expect((error as CheckRunnerError).message).toMatch(
				/outside the package \(`rootDir`\)/,
			);
			expect(existsSync(path.join(dir, ".variant"))).toBe(false);
		},
		TIMEOUT,
	);
});
