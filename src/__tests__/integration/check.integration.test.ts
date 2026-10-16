/**
 * Boundary: `variant check` meeting real git, a real StrykerJS and a real
 * Vitest, on a copy of `examples/check-demo`. These run the engine for real,
 * so each takes seconds, not milliseconds.
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
import { BaselineFailedError } from "../../core/errors.js";
import {
	cleanupTempWorkspaces,
	createTempWorkspace,
} from "../helpers/cli-harness.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DEMO = path.join(REPO, "examples", "check-demo");
const ADAPTER = path.join(REPO, "src", "adapters", "mutation");
const TIMEOUT = 120_000;

// The host is TypeScript here, not the build: Stryker runs it, and loads the
// reporter, through tsx.
const backend = createStrykerBackend({
	hostPath: path.join(ADAPTER, "stryker-host.ts"),
	pluginsPath: path.join(ADAPTER, "stryker-plugins.ts"),
	execArgv: ["--import", import.meta.resolve("tsx")],
	// Stryker's workers load the plugins too, and do not inherit execArgv.
	env: { NODE_OPTIONS: `--import ${import.meta.resolve("tsx")}` },
});

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
 * a link to Vitest and a sentinel, so a cleanup that followed the link out of
 * the sandbox would show.
 */
function demoRepository(): string {
	const dir = createTempWorkspace("check");
	cpSync(DEMO, dir, { recursive: true });
	mkdirSync(path.join(dir, "node_modules"));
	symlinkSync(
		realpathSync(path.join(REPO, "node_modules", "vitest")),
		path.join(dir, "node_modules", "vitest"),
		process.platform === "win32" ? "junction" : "dir",
	);
	writeFileSync(path.join(dir, "node_modules", ".sentinel"), "keep\n");
	writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "package.json", "vitest.config.ts", ".gitignore");
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

describe("variant check", () => {
	it(
		"reports the boundary mutation the tests did not notice",
		async () => {
			const dir = demoRepository();

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
			const dir = demoRepository();
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
			const dir = demoRepository();
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
	it(
		"counts a test file that fails to load as a failing baseline",
		async () => {
			const dir = demoRepository();
			writeFileSync(
				path.join(dir, "src", "broken.test.ts"),
				[
					'import { it } from "vitest";',
					'import { missing } from "./not-written-yet";',
					"",
					'it("uses it", () => missing());',
					"",
				].join("\n"),
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

	// pyra: when no mutated code ran in the baseline, Stryker read the empty
	// coverage as "coverage analysis off", ran every mutation against every
	// test and called code no test imports "undetected".
	it(
		"reports a changed file no test imports as reached by no test",
		async () => {
			const dir = demoRepository();
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
			const dir = demoRepository();

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
			const dir = demoRepository();

			const result = await check(dir, { budgetMs: 1_000 });

			expect(result.status).toBe("incomplete");
			expect(result.stopReason).toBe("budget");
		},
		TIMEOUT,
	);

	it(
		"leaves staged, unstaged and untracked work exactly as it was",
		async () => {
			const dir = demoRepository();
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
			const dir = demoRepository();

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
			const dir = demoRepository();

			const result = await check(dir, { budgetMs: 2_500 });

			expect(result.status).toBe("incomplete");
			expect(
				readFileSync(path.join(dir, "node_modules", ".sentinel"), "utf8"),
			).toBe("keep\n");
			expect(existsSync(path.join(dir, "node_modules", "vitest"))).toBe(true);
			expect(existsSync(path.join(dir, ".variant"))).toBe(false);
		},
		TIMEOUT,
	);

	// A pre-commit hook runs with these set, pointing at the real repository.
	// A test that runs git inside the sandbox must not reach it.
	it(
		"keeps git run by the tests away from the real repository's index",
		async () => {
			const dir = demoRepository();
			writeFileSync(
				path.join(dir, "src", "uses-git.test.ts"),
				[
					'import { execSync } from "node:child_process";',
					'import { it } from "vitest";',
					"",
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
			const dir = demoRepository();
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
