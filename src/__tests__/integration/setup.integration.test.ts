/**
 * Boundary: `variant init` against real repositories on disk. What it finds,
 * what it proposes, and what is there afterwards can only be checked with
 * files and a git repository to read.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerInitAction } from "../../cli/commands/init.js";
import { writeGlobalColorChoice } from "../../cli/visuals/color.js";
import { applySetup } from "../../core/setup/apply.js";
import { discoverRepository } from "../../core/setup/discover.js";
import { planSetup } from "../../core/setup/plan.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createGitWorkspace,
	restoreGlobalPrinter,
	withCwd,
} from "../helpers/cli-harness.js";

// Color is on wherever `CI` is set, and the assertions read plain text.
beforeEach(() => {
	writeGlobalColorChoice("never");
});

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
	writeGlobalColorChoice("auto");
});

const VITEST_CONFIG =
	'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n\ttest: {\n\t\tglobals: true,\n\t},\n});\n';

const CI_WORKFLOW = [
	"name: CI",
	"on: [push]",
	"jobs:",
	"  test:",
	"    runs-on: ubuntu-latest",
	"    steps:",
	"      - uses: actions/checkout@v6",
	"      - uses: pnpm/action-setup@v4",
	"      - run: pnpm install --frozen-lockfile",
	"      - run: pnpm test",
	"",
].join("\n");

/** A pnpm workspace with Turborepo, one Vitest per package, and a CI workflow. */
function pnpmWorkspace(): string {
	return createGitWorkspace("init", {
		"package.json": JSON.stringify({ name: "root", private: true }),
		"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
		"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
		"turbo.json": "{}",
		".gitignore": "node_modules\n",
		".github/workflows/ci.yml": CI_WORKFLOW,
		"packages/a/package.json": JSON.stringify({ name: "@x/a" }),
		"packages/a/vitest.config.ts": VITEST_CONFIG,
		"packages/b/package.json": JSON.stringify({ name: "@x/b" }),
		"packages/b/vitest.config.ts": VITEST_CONFIG,
		"fixtures/sample/vitest.config.ts": VITEST_CONFIG,
	});
}

const read = (dir: string, file: string): string =>
	readFileSync(path.join(dir, file), "utf8");

describe("discoverRepository", () => {
	it("finds how a workspace installs, tests and runs CI", async () => {
		const facts = await discoverRepository(pnpmWorkspace());

		expect(facts).toMatchObject({
			packageManager: "pnpm",
			workspacePackages: 2,
			taskRunner: "turborepo",
			vitestConfigs: [
				"packages/a/vitest.config.ts",
				"packages/b/vitest.config.ts",
			],
			jestConfigs: [],
			defaultBranch: "main",
			installed: false,
			ignoresVariantDir: false,
		});
		expect(facts.workflows).toMatchObject([
			{ file: ".github/workflows/ci.yml", runsTests: true, shallow: true },
		]);
	});

	it("reads a bun workspace whose app and Jest config sit in a subdirectory", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({ name: "dearly", workspaces: ["web"] }),
			"bun.lock": "{}",
			"web/package.json": JSON.stringify({ name: "dearly-web" }),
			"web/jest.config.ts": "export default {};\n",
		});

		expect(await discoverRepository(dir)).toMatchObject({
			packageManager: "bun",
			workspacePackages: 1,
			vitestConfigs: [],
			jestConfigs: ["web/jest.config.ts"],
		});
	});
});

describe("planSetup and applySetup", () => {
	it("wires variant into a workspace, and has nothing left to do afterwards", async () => {
		const dir = pnpmWorkspace();
		const commands: string[][] = [];

		const actions = await planSetup(dir, await discoverRepository(dir));
		const result = await applySetup(dir, actions, {
			run: async (command) => void commands.push([...command]),
		});

		expect(commands).toEqual([
			["pnpm", "add", "--save-dev", "--workspace-root", "@blzsky/variant"],
		]);
		expect(result.written.sort()).toEqual([
			".github/workflows/ci.yml",
			".github/workflows/variant.yml",
			".gitignore",
			"packages/a/vitest.config.ts",
			"packages/b/vitest.config.ts",
		]);
		expect(read(dir, "packages/a/vitest.config.ts")).toContain(
			"reporters: variantReporters()",
		);
		expect(read(dir, ".gitignore")).toBe("node_modules\n.variant/\n");
		expect(read(dir, ".github/workflows/ci.yml")).toContain("fetch-depth: 0");
		expect(read(dir, ".github/workflows/variant.yml")).toContain(
			"pnpm exec variant pr report",
		);
		// A sample project's config is not one of this repository's test runs.
		expect(read(dir, "fixtures/sample/vitest.config.ts")).toBe(VITEST_CONFIG);

		// Run again on the result: only the install is still owed, because the
		// fake did not add the dependency to package.json.
		const again = await planSetup(dir, await discoverRepository(dir));
		expect(again.filter((action) => action.kind === "write")).toEqual([]);
	});

	// pyra: `VARIANT_SHADOW=0 pnpm test` left the adapter on, because Turbo
	// never handed the variable to the test task.
	it("says that Turborepo has to be told to pass the adapter's variables on", async () => {
		const dir = pnpmWorkspace();

		const actions = await planSetup(dir, await discoverRepository(dir));

		expect(
			actions.some(
				(action) =>
					action.kind === "note" &&
					action.lines.some((line) => line.includes("globalPassThroughEnv")),
			),
		).toBe(true);
	});

	it("keeps the files it wrote when the install fails, and says what to run", async () => {
		const dir = pnpmWorkspace();
		const actions = await planSetup(dir, await discoverRepository(dir));

		const result = await applySetup(dir, actions, {
			run: async () => {
				throw new Error("ERR_PNPM_NO_NETWORK\nmore");
			},
		});

		expect(result.installed).toBe(false);
		expect(result.installError).toBe("ERR_PNPM_NO_NETWORK");
		expect(result.written).toContain(".gitignore");
	});

	it("says there is no Jest adapter yet instead of pretending to set one up", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({ name: "app" }),
			"jest.config.ts": "export default {};\n",
		});

		const actions = await planSetup(dir, await discoverRepository(dir));

		expect(
			actions.some(
				(action) =>
					action.kind === "note" &&
					action.lines.some((line) => line.includes("no Jest adapter yet")),
			),
		).toBe(true);
	});

	// dearly: `init` once edited the CI checkout "for the adapter" and closed
	// with "variant is configured" in a repository that has no adapter.
	it("claims nothing about an adapter in a repository that only runs Jest", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({ name: "app" }),
			"jest.config.ts": "export default {};\n",
			".github/workflows/ci.yml": CI_WORKFLOW,
		});
		const output = captureGlobalOutput();

		const actions = await planSetup(dir, await discoverRepository(dir));
		await withCwd(dir, () => registerInitAction({ yes: true, install: false }));

		expect(
			actions.some(
				(action) =>
					action.kind === "write" && action.file === ".github/workflows/ci.yml",
			),
		).toBe(false);
		expect(read(dir, ".github/workflows/ci.yml")).toBe(CI_WORKFLOW);
		expect(output.stdout()).not.toContain("variant is configured");
		expect(output.stdout()).toContain("Test runs are not checked yet");
	});

	// pyra: one Vitest per package through Turbo, and no config file anywhere.
	it("gives a package that runs Vitest without a config one that only adds the adapter", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({ name: "root", private: true }),
			"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"packages/a/package.json": JSON.stringify({
				name: "@x/a",
				devDependencies: { vitest: "^4.0.0" },
			}),
			"packages/b/package.json": JSON.stringify({ name: "@x/b" }),
		});

		const facts = await discoverRepository(dir);
		const actions = await planSetup(dir, facts);
		await applySetup(dir, actions, { run: async () => {} });

		expect(facts.vitestWithoutConfig).toEqual(["packages/a"]);
		expect(read(dir, "packages/a/vitest.config.mts")).toBe(
			'import { variantReporters } from "@blzsky/variant/vitest";\n\nexport default {\n\ttest: {\n\t\treporters: variantReporters(),\n\t},\n};\n',
		);
		expect(existsSync(path.join(dir, "packages/b/vitest.config.mts"))).toBe(
			false,
		);
		const again = await discoverRepository(dir);
		expect(again.vitestWithoutConfig).toEqual([]);
		expect(again.vitestConfigs).toEqual(["packages/a/vitest.config.mts"]);
	});

	// pyra's api: Vitest is a dependency, and the only script that runs it
	// names its own config. A default config there was never loaded, and the
	// config in use got no adapter.
	it("puts the adapter in the config a test script names, not in one nothing loads", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({ name: "root", private: true }),
			"pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"apps/api/package.json": JSON.stringify({
				name: "@x/api",
				scripts: {
					"test:integration":
						"vitest run --config vitest.integration.config.ts",
				},
				devDependencies: { vitest: "^4.0.0" },
			}),
			"apps/api/vitest.integration.config.ts": VITEST_CONFIG,
			"apps/unit/package.json": JSON.stringify({
				name: "@x/unit",
				scripts: { test: "vitest run" },
				devDependencies: { vitest: "^4.0.0" },
			}),
		});

		const facts = await discoverRepository(dir);
		await applySetup(dir, await planSetup(dir, facts), {
			run: async () => {},
		});

		expect(facts.vitestConfigs).toEqual([
			"apps/api/vitest.integration.config.ts",
		]);
		expect(facts.vitestWithoutConfig).toEqual(["apps/unit"]);
		expect(existsSync(path.join(dir, "apps/api/vitest.config.mts"))).toBe(
			false,
		);
		expect(read(dir, "apps/api/vitest.integration.config.ts")).toContain(
			"reporters: variantReporters()",
		);
	});

	// A Vitest config beside a Vite config replaces it, plugins and aliases
	// included: the package's tests would stop resolving their imports.
	it("creates nothing beside a Vite config, and says what to add to it", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({
				name: "app",
				devDependencies: { vitest: "^4.0.0" },
			}),
			"vite.config.ts": "export default { plugins: [] };\n",
		});

		const actions = await planSetup(dir, await discoverRepository(dir));

		expect(
			actions.some(
				(action) =>
					action.kind === "write" && action.file.startsWith("vitest.config."),
			),
		).toBe(false);
		expect(
			actions.some(
				(action) =>
					action.kind === "note" &&
					action.lines[0]?.includes("vite.config.ts was left alone"),
			),
		).toBe(true);
	});

	it("warns when a test script's --reporter flag would keep the adapter from loading", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({
				name: "app",
				scripts: { test: "vitest run --reporter=dot" },
				devDependencies: { vitest: "^4.0.0" },
			}),
		});

		const actions = await planSetup(dir, await discoverRepository(dir));

		expect(
			actions.some(
				(action) =>
					action.kind === "note" &&
					action.lines[0]?.includes("passes --reporter to Vitest"),
			),
		).toBe(true);
	});

	it("writes the pull-request workflow with the versions the test workflow uses", async () => {
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({ name: "app" }),
			"bun.lock": "{}",
			"jest.config.ts": "export default {};\n",
			".github/workflows/ci.yml": [
				"jobs:",
				"  test:",
				"    steps:",
				"      - uses: actions/checkout@v6",
				"      - uses: oven-sh/setup-bun@v2",
				"        with:",
				"          bun-version: 1.4.2",
				"      - uses: actions/setup-node@v6",
				"        with:",
				"          node-version: 24",
				"      - run: bun run test",
				"",
			].join("\n"),
		});

		const actions = await planSetup(dir, await discoverRepository(dir));
		const workflow = actions.find(
			(action) =>
				action.kind === "write" &&
				action.file === ".github/workflows/variant.yml",
		);

		expect(workflow?.kind === "write" && workflow.after).toContain(
			"bun-version: 1.4.2",
		);
		expect(workflow?.kind === "write" && workflow.after).toContain(
			"node-version: 24",
		);
	});

	it("leaves a config it cannot edit safely exactly as it is", async () => {
		const config =
			'const reporters = ["default"];\nexport default { test: { reporters } };\n';
		const dir = createGitWorkspace("init", {
			"package.json": JSON.stringify({ name: "app" }),
			"vitest.config.ts": config,
		});

		const actions = await planSetup(dir, await discoverRepository(dir));
		await applySetup(dir, actions, { run: async () => {} });

		expect(read(dir, "vitest.config.ts")).toBe(config);
		expect(
			actions.some(
				(action) =>
					action.kind === "note" && action.lines[0]?.includes("was left alone"),
			),
		).toBe(true);
	});
});

describe("init command", () => {
	it("shows what it found and would change, and changes nothing on a dry run", async () => {
		const dir = pnpmWorkspace();
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInitAction({ dryRun: true }));

		expect(output.stdout()).toContain("pnpm detected");
		expect(output.stdout()).toContain("2 workspace packages discovered");
		expect(output.stdout()).toContain("Edit packages/a/vitest.config.ts");
		expect(output.stdout()).toContain("+ \t\treporters: variantReporters(),");
		// A new file is shown whole: its line count is nothing to agree to.
		expect(output.stdout()).toContain("  + name: variant");
		expect(output.stdout()).toContain("pnpm exec variant pr report");
		expect(output.stdout()).toContain("Dry run: nothing was changed.");
		expect(read(dir, "packages/a/vitest.config.ts")).toBe(VITEST_CONFIG);
		expect(existsSync(path.join(dir, ".github/workflows/variant.yml"))).toBe(
			false,
		);
	});

	it("changes nothing without a terminal to confirm in, unless told --yes", async () => {
		const dir = pnpmWorkspace();
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInitAction({}));

		expect(output.stdout()).toContain("Run `variant init --yes`");
		expect(read(dir, "packages/a/vitest.config.ts")).toBe(VITEST_CONFIG);
	});

	it("applies the changes with --yes, leaving the install to the user with --no-install", async () => {
		const dir = pnpmWorkspace();
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInitAction({ yes: true, install: false }));

		expect(read(dir, "packages/b/vitest.config.ts")).toContain(
			"variantReporters()",
		);
		expect(output.stdout()).toContain("variant is configured.");
		expect(output.stdout()).toContain("Wrote .github/workflows/variant.yml");
		expect(output.stdout()).toContain(
			"pnpm add --save-dev --workspace-root @blzsky/variant",
		);
	});
});
