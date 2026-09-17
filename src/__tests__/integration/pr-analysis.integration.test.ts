/**
 * Boundary: `core/pr` meeting a real git repository and a real trace file on
 * disk, plus the commands that render what it returns.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerPrCheckAction,
	registerPrReplayAction,
	registerPrReportAction,
} from "../../cli/commands/pr.js";
import { runPrCheck } from "../../core/pr/check.js";
import { runPrReplay } from "../../core/pr/replay.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createTempWorkspace,
	restoreGlobalPrinter,
	withCwd,
	writeFiles,
} from "../helpers/cli-harness.js";

function writeTrace(
	dir: string,
	sessionId: string,
	modules: Array<{ file: string }> = [],
	routes: Array<{ path: string; modules: string[] }> = [],
): void {
	writeFiles(dir, {
		[`.variant/traces/${sessionId}.json`]: JSON.stringify({
			schemaVersion: 1,
			sessionId,
			startedAt: Date.now(),
			endedAt: Date.now() + 100,
			framework: "next",
			modules,
			routes,
		}),
	});
}

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
});

describe("runPrCheck", () => {
	it("reports safe-to-skip with no changed files when git is unavailable", async () => {
		const dir = createTempWorkspace("pr");
		const result = await runPrCheck(dir, { base: "main" });

		expect(result.verdict).toBe("safe-to-skip");
		expect(result.tsFilesChanged).toBe(0);
		expect(result.files).toHaveLength(0);
		expect(result.baseRef).toBe("main");
	});

	it("defaults the base ref to main", async () => {
		const dir = createTempWorkspace("pr");
		expect((await runPrCheck(dir, {})).baseRef).toBe("main");
	});

	it("honors a custom base ref", async () => {
		const dir = createTempWorkspace("pr");
		expect((await runPrCheck(dir, { base: "origin/main" })).baseRef).toBe(
			"origin/main",
		);
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

describe("runPrReplay", () => {
	it("returns null when no trace session exists", async () => {
		const dir = createTempWorkspace("pr");
		expect(await runPrReplay(dir, { base: "main" })).toBeNull();
	});

	it("returns session metadata for an existing trace file", async () => {
		const dir = createTempWorkspace("pr");
		writeTrace(dir, "session-abc");

		const result = await runPrReplay(dir, {
			base: "main",
			session: "session-abc",
		});

		expect(result?.sessionId).toBe("session-abc");
		expect(result?.framework).toBe("next");
		expect(result?.baseRef).toBe("main");
	});

	it("touches nothing when git cannot supply a changed set", async () => {
		const dir = createTempWorkspace("pr");
		writeTrace(dir, "session-xyz");

		const result = await runPrReplay(dir, {
			base: "main",
			session: "session-xyz",
		});

		expect(result?.changedFiles).toHaveLength(0);
		expect(result?.touchedModules).toHaveLength(0);
		expect(result?.touchedRoutes).toHaveLength(0);
		expect(result?.touchedPackages).toHaveLength(0);
	});

	it("defaults to the last recorded session", async () => {
		const dir = createTempWorkspace("pr");
		writeTrace(dir, "session-last");
		expect((await runPrReplay(dir, { base: "main" }))?.sessionId).toBe(
			"session-last",
		);
	});

	it("intersects changed files with traced routes", async () => {
		const dir = createTempWorkspace("pr");
		const touched = path.join(dir, "src", "page.ts");
		writeTrace(
			dir,
			"session-routes",
			[{ file: touched }],
			[{ path: "/home", modules: [touched] }],
		);

		const result = await runPrReplay(dir, {
			base: "main",
			session: "session-routes",
			changedFiles: ["src/page.ts"],
		});

		expect(result?.touchedModules).toEqual([touched]);
		expect(result?.touchedRoutes.map((r) => r.path)).toEqual(["/home"]);
	});
});

describe("pr check command", () => {
	it("prints the base ref, file count, and verdict", async () => {
		const dir = createTempWorkspace("pr");
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerPrCheckAction({ base: "main" }));

		expect(output.stdout()).toContain("main");
		expect(output.stdout()).toContain("Changed .ts files: 0");
		expect(output.stdout()).toContain("safe to skip build");
	});
});

describe("pr replay command", () => {
	it("explains itself when no session has been recorded", async () => {
		const dir = createTempWorkspace("pr");
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerPrReplayAction({ base: "main" }));

		expect(output.stdout()).toContain("No trace session found");
	});

	it("prints session metadata when a trace file exists", async () => {
		const dir = createTempWorkspace("pr");
		writeTrace(dir, "session-print");
		const output = captureGlobalOutput();

		await withCwd(dir, () =>
			registerPrReplayAction({ base: "main", session: "session-print" }),
		);

		expect(output.stdout()).toContain("session-print");
		expect(output.stdout()).toContain("No traced routes");
	});
});

describe("pr report command", () => {
	it("emits parseable JSON by default", async () => {
		const dir = createTempWorkspace("pr");
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerPrReportAction({ base: "main" }));

		const parsed = JSON.parse(output.stdout()) as {
			check: { verdict: string };
			replay: unknown;
			generatedAt: string;
		};
		expect(parsed.check.verdict).toBe("safe-to-skip");
		expect(parsed.replay).toBeNull();
		expect(parsed.generatedAt).toBeTruthy();
	});

	it("emits a markdown summary with --markdown", async () => {
		const dir = createTempWorkspace("pr");
		const output = captureGlobalOutput();

		await withCwd(dir, () =>
			registerPrReportAction({ base: "main", markdown: true }),
		);

		expect(output.stdout()).toContain("## Variant PR Report");
		expect(output.stdout()).toContain("### Semantic Diff");
		expect(output.stdout()).toContain("Safe to skip build");
	});

	it("writes JSON to the path given by --output", async () => {
		const dir = createTempWorkspace("pr");
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
		const dir = createTempWorkspace("pr");
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
