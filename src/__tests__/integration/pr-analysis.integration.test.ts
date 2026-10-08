/**
 * Boundary: `core/pr` meeting a real git repository on disk, plus the commands
 * that render what it returns.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerPrCheckAction,
	registerPrReportAction,
} from "../../cli/commands/pr.js";
import { runPrCheck } from "../../core/pr/check.js";
import { buildPrReport } from "../../core/pr/report.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createGitWorkspace,
	createTempWorkspace,
	git,
	restoreGlobalPrinter,
	withCwd,
	writeFiles,
} from "../helpers/cli-harness.js";

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
});

describe("runPrCheck", () => {
	// Reporting "no changes" here once produced "safe to skip build" for a
	// mistyped or unfetched ref: a narrow verdict from a wrong input.
	it("rejects a base ref outside a git repository", async () => {
		const dir = createTempWorkspace("pr");

		await expect(runPrCheck(dir, { base: "main" })).rejects.toMatchObject({
			code: "GIT_REF_ERROR",
		});
	});

	it("rejects a base ref that names no commit", async () => {
		const dir = createGitWorkspace("pr", {});

		await expect(
			runPrCheck(dir, { base: "does-not-exist" }),
		).rejects.toMatchObject({ code: "GIT_REF_ERROR" });
	});

	it("reports no changes on a branch that has not diverged from its base", async () => {
		const dir = createGitWorkspace("pr", {});
		const result = await runPrCheck(dir, { base: "main" });

		expect(result.verdict).toBe("safe-to-skip");
		expect(result.tsFilesChanged).toBe(0);
		expect(result.baseRef).toBe("main");
	});

	it("defaults the base ref to main", async () => {
		const dir = createGitWorkspace("pr", {});
		expect((await runPrCheck(dir, {})).baseRef).toBe("main");
	});

	it("honors a custom base ref", async () => {
		const dir = createTempWorkspace("pr");
		const result = await runPrCheck(dir, {
			base: "origin/main",
			changedFiles: [],
		});
		expect(result.baseRef).toBe("origin/main");
	});

	it("classifies a new exported symbol as breaking and requires a build", async () => {
		const dir = createTempWorkspace("pr");
		writeFiles(dir, {
			"src/api.ts": "export function added(): number { return 1; }\n",
		});

		const result = await runPrCheck(dir, {
			base: "main",
			changedFiles: ["src/api.ts"],
		});

		expect(result.tsFilesChanged).toBe(1);
		expect(result.files[0]?.classification).toBe("breaking");
		expect(result.verdict).toBe("build-required");
	});

	// From a subdirectory git still lists the file by its path from the
	// repository root, which names nothing below that directory: the file read
	// as deleted and every export as removed.
	it("classifies a branch's change the same from a subdirectory", async () => {
		const dir = createGitWorkspace("pr", {
			"web/src/api.ts": "export function get(): number { return 1; }\n",
		});
		git(dir, "checkout", "-q", "-b", "feature");
		writeFiles(dir, {
			"web/src/api.ts": "export function get(): number { return 2; }\n",
		});
		git(dir, "commit", "-q", "-am", "change the body");

		const result = await runPrCheck(path.join(dir, "web"), { base: "main" });

		expect(result.files).toMatchObject([
			{ filePath: "src/api.ts", classification: "internal" },
		]);
	});

	it("ignores non-TypeScript files in the changed set", async () => {
		const dir = createTempWorkspace("pr");
		writeFiles(dir, { "README.md": "# docs\n" });

		const result = await runPrCheck(dir, {
			base: "main",
			changedFiles: ["README.md"],
		});

		expect(result.tsFilesChanged).toBe(0);
		expect(result.verdict).toBe("safe-to-skip");
	});
});

describe("buildPrReport", () => {
	const WORKSPACE = {
		"package.json": JSON.stringify({
			name: "app",
			scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
		}),
		"package-lock.json": "{}\n",
		"vitest.config.ts": "export default {};\n",
		"src/price.ts":
			"export function total(a: number, b: number): number { return a + b; }\n",
		"src/cart.ts":
			'import { total } from "./price.js";\nexport const cart = (): number => total(1, 2);\n',
		"src/cart.test.ts": 'import { cart } from "./cart.js";\ncart();\n',
		"src/legacy.ts": "export const legacy = (): number => 1;\n",
	};

	it("plans a branch's change: its tests and why, its checks, and what nothing verifies", async () => {
		const dir = createGitWorkspace("pr", WORKSPACE);
		git(dir, "checkout", "-q", "-b", "feature");
		writeFiles(dir, {
			"src/price.ts":
				"export function total(a: number, b: number): number { return a + b + 0; }\n",
			"src/legacy.ts": "export const legacy = (): number => 2;\n",
		});
		git(dir, "commit", "-q", "-am", "change two bodies");

		const { plan } = await buildPrReport(dir, { base: "main" });

		expect(plan.tests).toMatchObject({
			selected: 1,
			total: 1,
			runs: [{ runner: "vitest", dir: "", files: ["src/cart.test.ts"] }],
			why: {
				"src/cart.test.ts": ["src/cart.test.ts", "src/cart.ts", "src/price.ts"],
			},
		});
		expect(plan.checks).toMatchObject([
			{ kind: "typecheck", command: "npm run typecheck" },
		]);
		expect(plan.notVerified.map((entry) => entry.filePath)).toEqual([
			"src/legacy.ts",
		]);
		expect(
			plan.changes.map((change) => [change.filePath, change.risk]),
		).toEqual([
			["src/legacy.ts", "high"],
			["src/price.ts", "low"],
		]);
	});

	// A report describes a change; only a test run's own prediction is ever
	// reconciled, so one left behind here would count as a run that never was.
	it("records no prediction", async () => {
		const dir = createGitWorkspace("pr", WORKSPACE);

		await buildPrReport(dir, { base: "main" });

		await expect(
			readFile(path.join(dir, ".variant/history/impact.jsonl"), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reports on a repository with no tests instead of failing", async () => {
		const dir = createGitWorkspace("pr", {
			"src/a.ts": "export const a = 1;\n",
		});
		git(dir, "checkout", "-q", "-b", "feature");
		writeFiles(dir, { "src/a.ts": "export const a = 2;\n" });
		git(dir, "commit", "-q", "-am", "change");

		const { plan } = await buildPrReport(dir, { base: "main" });

		expect(plan.tests.total).toBe(0);
		expect(plan.notVerified.map((entry) => entry.filePath)).toEqual([
			"src/a.ts",
		]);
	});
});

describe("pr check command", () => {
	it("prints the base ref, file count, and verdict", async () => {
		const dir = createGitWorkspace("pr", {});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerPrCheckAction({ base: "main" }));

		expect(output.stdout()).toContain("main");
		expect(output.stdout()).toContain("Changed .ts files: 0");
		expect(output.stdout()).toContain("safe to skip build");
	});
});

describe("pr report command", () => {
	it("emits parseable JSON by default", async () => {
		const dir = createGitWorkspace("pr", {});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerPrReportAction({ base: "main" }));

		const parsed = JSON.parse(output.stdout()) as {
			check: { verdict: string };
			generatedAt: string;
		};
		expect(parsed.check.verdict).toBe("safe-to-skip");
		expect(parsed.generatedAt).toBeTruthy();
	});

	it("emits a markdown summary with --markdown", async () => {
		const dir = createGitWorkspace("pr", {});
		const output = captureGlobalOutput();

		await withCwd(dir, () =>
			registerPrReportAction({ base: "main", markdown: true }),
		);

		expect(output.stdout()).toContain("## Variant PR Report");
		expect(output.stdout()).toContain("_Nothing changed against the base._");
	});

	it("writes JSON to the path given by --output", async () => {
		const dir = createGitWorkspace("pr", {});
		captureGlobalOutput();

		await withCwd(dir, () =>
			registerPrReportAction({ base: "main", output: "report.json" }),
		);

		const parsed = JSON.parse(
			await readFile(path.join(dir, "report.json"), "utf8"),
		) as { check: unknown };
		expect(parsed.check).toBeDefined();
	});

	it("writes markdown to the path given by --output", async () => {
		const dir = createGitWorkspace("pr", {});
		captureGlobalOutput();

		await withCwd(dir, () =>
			registerPrReportAction({
				base: "main",
				markdown: true,
				output: "report.md",
			}),
		);

		expect(await readFile(path.join(dir, "report.md"), "utf8")).toContain(
			"## Variant PR Report",
		);
	});
});
