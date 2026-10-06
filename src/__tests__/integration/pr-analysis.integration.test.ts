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
		expect(output.stdout()).toContain("### Semantic Diff");
		expect(output.stdout()).toContain("Safe to skip build");
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
