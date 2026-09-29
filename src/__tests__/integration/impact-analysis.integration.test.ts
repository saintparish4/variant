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

	it("selects the loader's tests when a file behind a computed import() changes", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"src/i18n.ts": `export const load = (lang: string) => import(\`./locales/\${lang}.js\`);`,
			"src/locales/en.ts": 'export const hello = "hello";',
			"src/i18n.test.ts": 'import { load } from "./i18n.js";\nload("en");',
			"src/unrelated.test.ts": "export const u = 1;",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["src/locales/en.ts"],
			readBefore: async () => 'export const hello = "hi";',
		});

		expect(report.result.tests.affectedTests).toEqual(["src/i18n.test.ts"]);
	});

	it("selects the tests of a component whose stylesheet changed", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"src/button.css": ".button { color: red; }",
			"src/button.ts":
				'import "./button.css";\nexport const Button = (): string => "button";',
			"src/button.test.ts": 'import { Button } from "./button.js";\nButton();',
			"src/unrelated.test.ts": "export const u = 1;",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["src/button.css"],
			readBefore: async () => null,
		});

		expect(report.result.tests.affectedTests).toEqual(["src/button.test.ts"]);
		expect(report.result.tests.unreached).toEqual([]);
	});

	it("notes a workspace dependency that package discovery did not find", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"package.json": JSON.stringify({
				name: "root",
				private: true,
				workspaces: ["apps/*"],
			}),
			"apps/web/package.json": JSON.stringify({
				name: "@org/web",
				dependencies: { "@org/ui": "workspace:*" },
			}),
			"apps/web/src/page.ts":
				'import { Button } from "@org/ui";\nexport const page = Button;',
			"apps/web/src/page.test.ts":
				'import { page } from "./page.js";\nexport const t = page;',
			"libs/ui/package.json": JSON.stringify({ name: "@org/ui" }),
			"libs/ui/src/index.ts": "export const Button = 1;",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["libs/ui/src/index.ts"],
			readBefore: async () => "export const Button = 0;",
		});

		expect(report.packagesFound).toBe(1);
		expect(report.result.radius.notes).toContain(
			"1 dependency declared with a local protocol is not a workspace package variant found (@org/ui); imports of it count as external, so a change to it reaches no importer",
		);
	});

	it("fails instead of predicting over zero test files", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"src/app.ts": FIXTURE["src/app.ts"],
			// JavaScript is not indexed, so this is not a test variant can see.
			"src/app.test.js": 'import { boot } from "./app.js";\nboot();',
			"src/auth.ts":
				"export function login(name: string, strict: boolean): string { return name; }",
		});

		await expect(
			predictImpact(dir, { changedFiles: ["src/auth.ts"], readBefore }),
		).rejects.toMatchObject({ code: "NO_TEST_FILES" });
		expect(await readImpactPredictions(defaultHistoryDir(dir))).toEqual([]);
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
