/**
 * Boundary: the full change-intelligence pipeline (symbol graph → blast radius → test
 * impact → shadow log) over a real source tree, and the command that renders
 * it. The symbol graph is built from files on disk, so this cannot be a unit
 * test.
 */

import { afterEach, describe, expect, it } from "vitest";
import { registerImpactAction } from "../../cli/commands/impact.js";
import {
	defaultHistoryDir,
	readImpactPredictions,
} from "../../core/history/impact-log.js";
import { predictImpact } from "../../core/impact/predict.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createGitWorkspace,
	createTempWorkspace,
	restoreGlobalPrinter,
	withCwd,
	writeFiles,
} from "../helpers/cli-harness.js";

const AUTH_BEFORE =
	"export function login(name: string): string { return name; }";

const FIXTURE = {
	"src/app.ts":
		'import { login } from "./auth.js";\nexport const boot = (): string => login("a");',
	"src/app.test.ts":
		'import { boot } from "./app.js";\nexport const t = boot();',
	"src/unrelated.test.ts": "export const u = 1;",
};

const readBefore = async (): Promise<string> => AUTH_BEFORE;

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
});

describe("predictImpact", () => {
	it("requires a build for a signature change and logs the prediction", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			...FIXTURE,
			"src/auth.ts":
				"export function login(name: string, strict: boolean): string { return name; }",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["src/auth.ts"],
			readBefore,
		});

		expect(report?.verdict).toBe("build-required");
		expect(report?.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
		expect(report?.result.tests.totalTests).toBe(2);
		expect(report?.historyLogged).toBe(true);

		const records = await readImpactPredictions(defaultHistoryDir(dir));
		expect(records).toHaveLength(1);
		expect(records[0]?.verdict).toBe("build-required");
		expect(records[0]?.affectedTests).toEqual(["src/app.test.ts"]);
		expect(records[0]?.changedFiles).toEqual(["src/auth.ts"]);
	});

	it("selects no tests for a comment-only change", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			...FIXTURE,
			"src/auth.ts": `${AUTH_BEFORE}\n// clarifying comment`,
		});

		const report = await predictImpact(dir, {
			changedFiles: ["src/auth.ts"],
			readBefore,
		});

		expect(report?.verdict).toBe("safe-to-skip");
		expect(report?.result.tests.affectedTests).toEqual([]);
	});

	it("recommends a build for a body-only change", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			...FIXTURE,
			"src/auth.ts":
				"export function login(name: string): string { return name.trim(); }",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["src/auth.ts"],
			readBefore,
		});

		expect(report?.verdict).toBe("build-recommended");
		expect(report?.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
	});

	it("escalates a config change to build-required via select-all", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, { ...FIXTURE, "src/auth.ts": AUTH_BEFORE });

		const report = await predictImpact(dir, {
			changedFiles: ["package.json"],
			readBefore: async () => null,
		});

		expect(report?.verdict).toBe("build-required");
		expect(report?.result.tests.selectAll).toBe(true);
		expect(report?.result.tests.affectedTests).toHaveLength(2);
	});

	it("rejects a base ref outside a git repository", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, { "src/a.ts": "export const a = 1;" });

		await expect(predictImpact(dir)).rejects.toMatchObject({
			code: "GIT_REF_ERROR",
		});
	});

	it("rejects the default HEAD~1 in a repository with one commit", async () => {
		const dir = createGitWorkspace("impact", {
			"src/a.ts": "export const a = 1;",
		});

		await expect(predictImpact(dir)).rejects.toMatchObject({
			code: "GIT_REF_ERROR",
		});
	});
});

describe("impact command", () => {
	it("prints the run/skip block with the report-only disclaimer", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			...FIXTURE,
			"src/auth.ts":
				"export function login(name: string, strict: boolean): string { return name; }",
		});
		const output = captureGlobalOutput();

		await withCwd(dir, () =>
			registerImpactAction({ changedFiles: ["src/auth.ts"], readBefore }),
		);

		expect(output.stdout()).toContain("You changed 1 file.");
		expect(output.stdout()).toContain("breaking");
		expect(output.stdout()).toContain("Run:   1 test file");
		expect(output.stdout()).toContain("Skip:  1 test file (of 2 total)");
		expect(output.stdout()).toContain("Verdict:    build required");
		expect(output.stdout()).toContain("report-only");
	});

	it("emits parseable JSON with --json", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			...FIXTURE,
			"src/auth.ts": `${AUTH_BEFORE}\n// comment`,
		});
		const output = captureGlobalOutput();

		await withCwd(dir, () =>
			registerImpactAction({
				json: true,
				changedFiles: ["src/auth.ts"],
				readBefore,
			}),
		);

		const parsed = JSON.parse(output.stdout()) as {
			verdict: string;
			tests: { affectedTests: string[] };
		};
		expect(parsed.verdict).toBe("safe-to-skip");
		expect(parsed.tests.affectedTests).toEqual([]);
	});

	it("fails outside a git repository instead of reporting no changes", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, { "src/a.ts": "export const a = 1;" });
		const output = captureGlobalOutput();

		await expect(
			withCwd(dir, () => registerImpactAction()),
		).rejects.toMatchObject({ code: "GIT_REF_ERROR" });
		expect(output.stdout()).toBe("");
	});
});
