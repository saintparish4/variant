/**
 * Boundary: the `build`/`run` commands meeting real config loading, a real
 * task graph, and real child processes. These need a workspace on disk to
 * say anything true, which is what puts them in this tier rather than beside
 * their sources.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerBuildAction } from "../../cli/commands/build.js";
import { registerRunAction } from "../../cli/commands/run.js";
import { VariantError } from "../../core/errors.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createTempWorkspace,
	restoreGlobalPrinter,
	withCwd,
} from "../helpers/cli-harness.js";

function writeConfig(dir: string, config: Record<string, unknown>): void {
	writeFileSync(
		path.join(dir, "variant.config.json"),
		JSON.stringify({
			cache: { directory: path.join(dir, ".variant/cache") },
			...config,
		}),
	);
}

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
});

describe("build command", () => {
	it("runs the build task and reports it in the insight table", async () => {
		const dir = createTempWorkspace("build");
		writeConfig(dir, { tasks: { build: { command: "echo build-ok" } } });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerBuildAction());

		expect(output.stdout()).toContain("build");
	});

	it("fails with an VariantError when no build task is configured", async () => {
		const dir = createTempWorkspace("build");
		writeConfig(dir, { tasks: { lint: { command: "echo lint-ok" } } });
		captureGlobalOutput();

		await expect(
			withCwd(dir, () => registerBuildAction()),
		).rejects.toBeInstanceOf(VariantError);
	});

	it("prints the task plan without executing under --dry-run", async () => {
		const dir = createTempWorkspace("build");
		writeConfig(dir, {
			tasks: {
				lint: { command: "exit 1" },
				build: { command: "exit 1", dependsOn: ["lint"] },
			},
		});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerBuildAction({ dryRun: true }));

		expect(output.stdout()).toContain('[dry-run] Task plan for "build"');
		expect(output.stdout()).toContain("Level 1: lint");
		expect(output.stdout()).toContain("Level 2: build");
	});

	it("treats --affected as a no-op when git is unavailable", async () => {
		const dir = createTempWorkspace("build");
		writeConfig(dir, { tasks: { build: { command: "echo build-ok" } } });
		captureGlobalOutput();

		await expect(
			withCwd(dir, () => registerBuildAction({ affected: true })),
		).resolves.toBeUndefined();
	});

	it("--affected runs a changed package and its dependents, skipping the rest", async () => {
		const dir = createTempWorkspace("build");
		writeFileSync(
			path.join(dir, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n",
		);
		for (const name of ["utils", "web", "docs"]) {
			mkdirSync(path.join(dir, `packages/${name}/src`), { recursive: true });
			writeFileSync(
				path.join(dir, `packages/${name}/src/index.ts`),
				"export const value = 1;\n",
			);
		}
		writeFileSync(
			path.join(dir, "packages/utils/package.json"),
			JSON.stringify({ name: "utils", scripts: { build: "echo utils:build" } }),
		);
		writeFileSync(
			path.join(dir, "packages/web/package.json"),
			JSON.stringify({
				name: "web",
				scripts: { build: "echo web:build" },
				dependencies: { utils: "workspace:*" },
			}),
		);
		writeFileSync(
			path.join(dir, "packages/docs/package.json"),
			JSON.stringify({ name: "docs", scripts: { build: "echo docs:build" } }),
		);
		writeConfig(dir, {
			workspace: { enabled: true },
			tasks: { build: { command: "node -e 0" } },
		});

		const identity = "-c user.email=t@t.com -c user.name=T";
		const git = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "ignore" });
		git("git init");
		git(`git ${identity} commit --allow-empty -m base`);
		git("git add .");
		git(`git ${identity} commit -m initial`);
		writeFileSync(
			path.join(dir, "packages/utils/src/index.ts"),
			"export const value = 2;\n",
		);
		git("git add .");
		git(`git ${identity} commit -m "change utils"`);

		const output = captureGlobalOutput();
		await withCwd(dir, () => registerBuildAction({ affected: true }));

		const statusOf = (task: string): string | undefined =>
			output
				.stdout()
				.split("\n")
				.find((line) => line.includes(task) && /MISS|HIT|SKIP/.test(line));

		expect(statusOf("utils:build")).toMatch(/MISS|HIT/);
		expect(statusOf("web:build")).toMatch(/MISS|HIT/);
		expect(statusOf("docs:build")).toMatch(/SKIP/);
	});

	it("accepts an explicit concurrency limit", async () => {
		const dir = createTempWorkspace("build");
		writeConfig(dir, { tasks: { build: { command: "echo build-ok" } } });
		captureGlobalOutput();

		await expect(
			withCwd(dir, () => registerBuildAction({ concurrency: 1 })),
		).resolves.toBeUndefined();
	});
});

describe("run command", () => {
	it("runs a named task and reports it in the insight table", async () => {
		const dir = createTempWorkspace("run");
		writeConfig(dir, { tasks: { lint: { command: "echo lint-ok" } } });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerRunAction("lint"));

		expect(output.stdout()).toContain("lint");
	});

	it("fails with an VariantError for a task outside the graph", async () => {
		const dir = createTempWorkspace("run");
		writeConfig(dir, { tasks: { lint: { command: "echo lint-ok" } } });

		await expect(
			withCwd(dir, () => registerRunAction("nonexistent")),
		).rejects.toBeInstanceOf(VariantError);
	});

	it("accepts an explicit concurrency limit", async () => {
		const dir = createTempWorkspace("run");
		writeConfig(dir, { tasks: { lint: { command: "echo lint-ok" } } });
		captureGlobalOutput();

		await expect(
			withCwd(dir, () => registerRunAction("lint", { concurrency: 1 })),
		).resolves.toBeUndefined();
	});
});
