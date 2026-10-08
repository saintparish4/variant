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
			'reporters: ["default", variant()]',
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
		expect(output.stdout()).toContain(
			'+ \t\treporters: ["default", variant()],',
		);
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

		expect(read(dir, "packages/b/vitest.config.ts")).toContain("variant()");
		expect(output.stdout()).toContain("Wrote .github/workflows/variant.yml");
		expect(output.stdout()).toContain(
			"pnpm add --save-dev --workspace-root @blzsky/variant",
		);
	});
});
