/**
 * Boundary: the full change-intelligence pipeline (symbol graph → blast radius → test
 * impact → shadow log) over a real source tree, and the command that renders
 * it. The symbol graph is built from files on disk, so this cannot be a unit
 * test.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerImpactAction } from "../../cli/commands/impact.js";
import {
	defaultHistoryDir,
	readImpactPredictions,
} from "../../core/history/impact-log.js";
import { predictImpact } from "../../core/impact/predict.js";
import { changeBaseDeps } from "../../core/vcs/change-base.js";
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

	// A dependency update that touches no package.json changes the lockfile
	// alone. In a workspace it sits at the root, above the package whose tests
	// it affects.
	it.each([
		["the workspace root", "."],
		["the package below it", "web"],
	])("selects every test for a lockfile-only change, run from %s", async (_, from) => {
		const dir = createGitWorkspace("impact", {
			"package.json": JSON.stringify({ name: "root", workspaces: ["web"] }),
			"bun.lock": JSON.stringify({ lockfileVersion: 2 }),
			"web/package.json": JSON.stringify({ name: "web" }),
			"web/src/app.ts": 'export const boot = (): string => "a";',
			"web/src/app.test.ts": FIXTURE["src/app.test.ts"],
			"web/src/unrelated.test.ts": FIXTURE["src/unrelated.test.ts"],
		});
		writeFiles(dir, {
			"bun.lock": JSON.stringify({ lockfileVersion: 2, bumped: true }),
		});

		const report = await predictImpact(path.join(dir, from), { base: "HEAD" });

		expect(report.result.tests.selectAll).toBe(true);
		expect(report.result.tests.affectedTests).toHaveLength(2);
		expect(report.verdict).toBe("build-required");
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
		expect(report.result.radius.repositoryNotes).toContain(
			"1 dependency declared with a local protocol is not a workspace package variant found (@org/ui); imports of it count as external, so a change to it reaches no importer",
		);
		// This change is inside that package, so here the gap is about the change.
		expect(report.result.radius.notes).toContain(
			"1 changed file belongs to @org/ui, a local package variant did not find as a workspace package (libs/ui/src/index.ts); files importing it by name are not reached",
		);
	});

	it("fails instead of predicting over zero test files", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"src/app.ts": FIXTURE["src/app.ts"],
			"src/auth.ts":
				"export function login(name: string, strict: boolean): string { return name; }",
		});

		await expect(
			predictImpact(dir, { changedFiles: ["src/auth.ts"], readBefore }),
		).rejects.toMatchObject({ code: "NO_TEST_FILES" });
		expect(await readImpactPredictions(defaultHistoryDir(dir))).toEqual([]);
	});

	// Git names paths from the repository root. Read as relative to a project
	// kept in a subdirectory, a changed file looked deleted and matched nothing
	// in the import graph: `breaking`, and no test selected.
	it("selects the same tests from a subdirectory as from the repository root", async () => {
		const dir = createGitWorkspace("impact", {
			"web/src/auth.ts": AUTH_BEFORE,
			"web/src/app.ts": FIXTURE["src/app.ts"],
			"web/src/app.test.ts": FIXTURE["src/app.test.ts"],
			"web/src/unrelated.test.ts": FIXTURE["src/unrelated.test.ts"],
		});
		writeFiles(dir, {
			"web/src/auth.ts":
				"export function login(name: string): string { return name.trim(); }",
		});

		const report = await predictImpact(path.join(dir, "web"), { base: "HEAD" });

		expect(report.result.radius.changed).toMatchObject([
			{ filePath: "src/auth.ts", classification: "internal" },
		]);
		expect(report.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
	});

	it("reaches the importers of a file changed outside the directory it runs in", async () => {
		const dir = createGitWorkspace("impact", {
			"shared/format.ts": "export const format = (s: string): string => s;",
			"shared/unused.ts": "export const unused = 1;",
			"web/src/app.ts":
				'import { format } from "../../shared/format.js";\nexport const boot = (): string => format("a");',
			"web/src/app.test.ts": FIXTURE["src/app.test.ts"],
			"web/src/unrelated.test.ts": FIXTURE["src/unrelated.test.ts"],
		});
		writeFiles(dir, {
			"shared/format.ts":
				"export const format = (s: string): string => s.trim();",
			"shared/unused.ts": "export const unused = 2;",
		});

		const report = await predictImpact(path.join(dir, "web"), { base: "HEAD" });

		expect(report.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
		expect(report.result.tests.unreached).toEqual(["../shared/unused.ts"]);
	});

	// Only the tsconfig in the directory variant ran in was read. From a
	// workspace root, an app's own `@/*` named nothing: no edge, no test.
	it("follows an alias declared in a package's own tsconfig", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"apps/web/tsconfig.json": JSON.stringify({
				compilerOptions: { paths: { "@/*": ["./src/*"] } },
			}),
			"apps/web/src/lib/price.ts":
				"export const price = (n: number): number => n * 3;",
			"apps/web/src/page.ts":
				'import { price } from "@/lib/price";\nexport const page = (): number => price(1);',
			"apps/web/src/page.test.ts":
				'import { page } from "./page";\nexport const t = page();',
			"apps/web/src/unrelated.test.ts": "export const u = 1;",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["apps/web/src/lib/price.ts"],
			readBefore: async () =>
				"export const price = (n: number): number => n * 2;",
		});

		expect(report.result.tests.affectedTests).toEqual([
			"apps/web/src/page.test.ts",
		]);
	});

	// The shape that selected nothing on a real repository: TypeScript source
	// whose only tests are `*.test.mjs` run by Node's own test runner.
	it("selects a package's JavaScript tests", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"apps/factory/package.json": JSON.stringify({ name: "factory" }),
			"apps/factory/src/models.ts": 'export const model = (): string => "b";',
			"apps/factory/tests/models.test.mjs":
				'import { model } from "../src/models.ts";\nmodel();',
			"apps/web/package.json": JSON.stringify({ name: "web" }),
			"apps/web/src/page.ts": "export const page = 1;",
			"apps/web/src/page.test.ts":
				'import { page } from "./page";\nexport const t = page;',
		});

		const report = await predictImpact(dir, {
			changedFiles: ["apps/factory/src/models.ts"],
			readBefore: async () => 'export const model = (): string => "a";',
		});

		const { tests } = report.result;
		expect(tests.affectedTests).toEqual(["apps/factory/tests/models.test.mjs"]);
		expect(tests.totalTests).toBe(2);
		expect(tests.unreached).toEqual([]);
		expect(tests.javascriptTests).toBe(0);
		expect(tests.resolution).toBe("high");
	});

	it("follows imports between JavaScript files, extension or not", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"src/price.js": "export const total = (a, b) => a + b + 0;\n",
			"src/cart.mjs":
				'import { total } from "./price.js";\nexport const cart = () => total(1, 2);\n',
			"src/cart.test.js": 'import { cart } from "./cart.mjs";\ncart();\n',
			"src/other.test.js": "export {};\n",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["src/price.js"],
			readBefore: async () => "export const total = (a, b) => a + b;\n",
		});

		expect(report.result.radius.changed).toMatchObject([
			{ filePath: "src/price.js", classification: "internal" },
		]);
		expect(report.result.tests.affectedTests).toEqual(["src/cart.test.js"]);
	});

	// `module.exports` has no export list to compare, so nothing proves an
	// importer unaffected.
	it("treats a changed CommonJS module as reaching everything that requires it", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"lib/config.cjs": "module.exports = { retries: 3 };\n",
			"lib/client.js":
				'const config = require("./config.cjs");\nexport const retries = config.retries;\n',
			"lib/client.test.js":
				'import { retries } from "./client.js";\nretries;\n',
		});

		const report = await predictImpact(dir, {
			changedFiles: ["lib/config.cjs"],
			readBefore: async () => "module.exports = { retries: 2 };\n",
		});

		expect(report.result.radius.changed).toMatchObject([
			{ filePath: "lib/config.cjs", classification: "breaking", ungated: true },
		]);
		expect(report.result.radius.affectedFiles).toContain("lib/client.js");
		expect(report.result.tests.affectedTests).toEqual(["lib/client.test.js"]);
	});

	// Build output and vendored bundles are JavaScript too. Git knows which
	// JavaScript is the repository's own.
	it("leaves out JavaScript that git ignores", async () => {
		const dir = createGitWorkspace("impact", {
			".gitignore": "build/\n",
			// Committed build output and bundles are still not source.
			"packages/a/dist/a.test.js": "export {};\n",
			"vendor/lib.min.js": "export {};\n",
			"vendor/lib.test.min.js": "export {};\n",
			"src/app.ts": "export const app = 1;\n",
			"src/app.test.ts":
				'import { app } from "./app";\nexport const t = app;\n',
		});
		writeFiles(dir, {
			"build/app.test.js": "export {};\n",
			"src/new.test.js": "export {};\n",
			"src/app.ts": "export const app = 2;\n",
		});

		const report = await predictImpact(dir, { base: "HEAD" });

		// The new, not yet committed test counts; the ignored build output
		// does not.
		expect(report.result.tests.totalTests).toBe(2);
		expect(report.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
	});

	it("follows a subpath import declared in the package's own package.json", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"apps/factory/package.json": JSON.stringify({
				name: "factory",
				imports: { "#image": "./agent/lib/image.ts" },
			}),
			"apps/factory/agent/lib/image.ts":
				'export const image = (): string => "b";',
			"apps/factory/agent/sandbox.ts":
				'import { image } from "#image";\nexport const run = (): string => image();',
			"apps/factory/agent/sandbox.test.ts":
				'import { run } from "./sandbox";\nexport const t = run();',
			"apps/factory/agent/unrelated.test.ts": "export const u = 1;",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["apps/factory/agent/lib/image.ts"],
			readBefore: async () => 'export const image = (): string => "a";',
		});

		expect(report.result.tests.affectedTests).toEqual([
			"apps/factory/agent/sandbox.test.ts",
		]);
		expect(report.result.radius.notes).toEqual([]);
	});

	// The usual monorepo layout: aliases live in a shared base config that
	// each package extends, and their targets are relative to that base.
	it("follows an alias a package inherits from a base tsconfig", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"tsconfig.base.json": JSON.stringify({
				compilerOptions: {
					paths: { "@shared/*": ["./packages/shared/src/*"] },
				},
			}),
			"apps/web/tsconfig.json": JSON.stringify({
				extends: "../../tsconfig.base.json",
			}),
			"packages/shared/src/price.ts":
				"export const price = (n: number): number => n * 3;",
			"apps/web/src/page.ts":
				'import { price } from "@shared/price";\nexport const page = (): number => price(1);',
			"apps/web/src/page.test.ts":
				'import { page } from "./page";\nexport const t = page();',
			"apps/web/src/unrelated.test.ts": "export const u = 1;",
		});

		const report = await predictImpact(dir, {
			changedFiles: ["packages/shared/src/price.ts"],
			readBefore: async () =>
				"export const price = (n: number): number => n * 2;",
		});

		expect(report.result.tests.affectedTests).toEqual([
			"apps/web/src/page.test.ts",
		]);
	});

	it('selects a test that imports the code it tests as ".." or "."', async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"src/logger/index.ts":
				"export const log = (s: string): string => s.trim();",
			"src/logger/__tests__/log.test.ts":
				'import { log } from "..";\nexport const t = log("a");',
			"src/button/index.ts": "export const press = (): number => 2;",
			"src/button/index.test.ts":
				'import { press } from ".";\nexport const t = press();',
			"src/unrelated.test.ts": FIXTURE["src/unrelated.test.ts"],
		});

		const report = await predictImpact(dir, {
			changedFiles: ["src/button/index.ts", "src/logger/index.ts"],
			readBefore: async (file) =>
				file === "src/button/index.ts"
					? "export const press = (): number => 1;"
					: "export const log = (s: string): string => s;",
		});

		expect(report.result.tests.affectedTests).toEqual([
			"src/button/index.test.ts",
			"src/logger/__tests__/log.test.ts",
		]);
	});

	it("selects the tests of a file that still imports a deleted one", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, FIXTURE);

		const report = await predictImpact(dir, {
			changedFiles: ["src/auth.ts"],
			readBefore,
		});

		expect(report.result.radius.changed).toMatchObject([
			{ filePath: "src/auth.ts", classification: "breaking" },
		]);
		expect(report.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
	});

	it("selects the tests of a file that still imports a renamed one by its old name", async () => {
		const dir = createGitWorkspace("impact", {
			...FIXTURE,
			"src/auth.ts": AUTH_BEFORE,
		});
		git(dir, "mv", "src/auth.ts", "src/session.ts");
		git(dir, "commit", "-q", "-m", "rename auth, importer left behind");

		const report = await predictImpact(dir, { base: "HEAD~1" });

		expect(
			report.result.radius.changed.map((change) => change.filePath),
		).toEqual(["src/auth.ts", "src/session.ts"]);
		expect(report.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
	});

	// `dist/` is not indexed, so a file there has no node to walk from. Read
	// as ordinary code it reached nothing and said nothing.
	it("does not skip silently for a changed TypeScript file in an ignored directory", async () => {
		const dir = createTempWorkspace("impact");
		writeFiles(dir, {
			"dist/built.ts": "export const built = (): number => 2;",
			"dist/orphan.ts": "export const orphan = 2;",
			"src/app.ts":
				'import { built } from "../dist/built.js";\nexport const boot = (): number => built();',
			"src/app.test.ts": FIXTURE["src/app.test.ts"],
			"src/unrelated.test.ts": FIXTURE["src/unrelated.test.ts"],
		});

		const report = await predictImpact(dir, {
			changedFiles: ["dist/built.ts", "dist/orphan.ts"],
			readBefore: async () => "export const built = (): number => 1;",
		});

		expect(report.result.tests.affectedTests).toEqual(["src/app.test.ts"]);
		expect(report.result.tests.unreached).toEqual(["dist/orphan.ts"]);
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

// With no --base, a branch is measured from where it left the default branch:
// everything it changed, not only its last commit.
describe("impact with no base named", () => {
	const noCi = { env: {} };

	function branchWithTwoCommits(): string {
		const dir = createGitWorkspace("impact", {
			...FIXTURE,
			"src/auth.ts": AUTH_BEFORE,
			"src/other.ts": "export const other = 1;",
			"src/other.test.ts":
				'import { other } from "./other.js";\nexport const t = other;',
		});
		git(dir, "checkout", "-q", "-b", "feature");
		writeFiles(dir, {
			"src/auth.ts":
				"export function login(name: string): string { return name.trim(); }",
		});
		git(dir, "commit", "-q", "-am", "first");
		writeFiles(dir, { "src/other.ts": "export const other = 2;" });
		git(dir, "commit", "-q", "-am", "second");
		return dir;
	}

	it("measures a branch from its merge base with the default branch", async () => {
		const dir = branchWithTwoCommits();

		const report = await predictImpact(dir, {
			changeBaseDeps: { ...changeBaseDeps(dir), ...noCi },
		});

		expect(report.baseSource).toBe("default-branch");
		expect(report.baseLabel).toBe("merge base with main");
		expect(
			report.result.radius.changed.map((change) => change.filePath),
		).toEqual(["src/auth.ts", "src/other.ts"]);
		expect(report.result.tests.affectedTests).toEqual([
			"src/app.test.ts",
			"src/other.test.ts",
		]);
	});

	it("measures the last commit on the default branch itself", async () => {
		const dir = branchWithTwoCommits();
		git(dir, "checkout", "-q", "main");
		git(dir, "merge", "-q", "--ff-only", "feature");

		const report = await predictImpact(dir, {
			changeBaseDeps: { ...changeBaseDeps(dir), ...noCi },
		});

		expect(report.baseSource).toBe("previous-commit");
		expect(
			report.result.radius.changed.map((change) => change.filePath),
		).toEqual(["src/other.ts"]);
	});

	it("records the pushed commit of a pull request, not the one checked out", async () => {
		const dir = branchWithTwoCommits();
		const pushed = "c".repeat(40);

		const report = await predictImpact(dir, {
			changeBaseDeps: {
				...changeBaseDeps(dir),
				env: {
					GITHUB_ACTIONS: "true",
					GITHUB_EVENT_NAME: "pull_request",
					GITHUB_BASE_REF: "main",
					GITHUB_EVENT_PATH: "/event.json",
				},
				// A local `main` stands in for the remote-tracking branch.
				resolveCommit: (ref) =>
					changeBaseDeps(dir).resolveCommit(ref.replace("origin/", "")),
				mergeBase: (a, b) =>
					changeBaseDeps(dir).mergeBase(a, b.replace("origin/", "")),
				readEvent: async () => ({ pull_request: { head: { sha: pushed } } }),
			},
		});

		const records = await readImpactPredictions(defaultHistoryDir(dir));
		expect(records.at(-1)?.headSha).toBe(pushed);
		// A caller that reconciles later needs to know which prediction is its own.
		expect(report.headSha).toBe(pushed);
	});
});

describe("impact command", () => {
	it("reports a push with no previous commit and does not fail", async () => {
		const dir = createGitWorkspace("impact", {
			"src/a.ts": "export const a = 1;",
		});
		const output = captureGlobalOutput();
		const saved = { ...process.env };
		Object.assign(process.env, {
			GITHUB_ACTIONS: "true",
			GITHUB_EVENT_NAME: "push",
			GITHUB_EVENT_PATH: "",
			VARIANT_BASE: "",
		});
		try {
			await withCwd(dir, () => registerImpactAction({}));
		} finally {
			process.env = saved;
		}

		expect(output.stdout()).toContain("no prediction was made");
		expect(await readImpactPredictions(defaultHistoryDir(dir))).toEqual([]);
	});

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
