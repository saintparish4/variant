/**
 * Boundary: the contract between config loading, graph planning, and the
 * runner. Each is unit-tested in isolation; what only shows up here is whether
 * the loader hands the planner something the planner accepts, and whether the
 * graph it produces is something the runner can execute.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, toRunOptions } from "../../cli/context.js";
import { loadConfig } from "../../core/config/loader.js";
import { runTasksWithDeps } from "../../core/execution/runner.js";
import { buildGraph } from "../../core/graph/planner.js";
import type { TaskConfig } from "../../types/index.js";
import {
	cleanupTempWorkspaces,
	createTempWorkspace,
	withCwd,
	writeFiles,
} from "../helpers/cli-harness.js";

function workspace(config: Record<string, unknown>): string {
	const dir = createTempWorkspace("seam");
	writeFiles(dir, {
		"variant.config.json": JSON.stringify({
			cache: { directory: ".variant/cache" },
			...config,
		}),
	});
	return dir;
}

afterEach(cleanupTempWorkspaces);

describe("config loader → planner", () => {
	it("produces a graph whose levels honor the config's dependsOn edges", async () => {
		const dir = workspace({
			tasks: {
				lint: { command: "echo lint" },
				typecheck: { command: "echo typecheck" },
				build: { command: "echo build", dependsOn: ["lint", "typecheck"] },
			},
		});

		const config = await loadConfig(dir);
		const levels = buildGraph(config).toLevels("build");

		expect(levels).toHaveLength(2);
		expect([...(levels[0] ?? [])].sort()).toEqual(["lint", "typecheck"]);
		expect(levels[1]).toEqual(["build"]);
	});

	it("applies schema defaults the planner and runner depend on", async () => {
		const dir = workspace({ tasks: { build: { command: "echo build" } } });

		const config = await loadConfig(dir);

		expect(config.strategy).toBeDefined();
		expect(config.cache.directory).toBeTruthy();
		expect(buildGraph(config).toLevels("build")).toEqual([["build"]]);
	});
});

describe("context → runner", () => {
	it("lifts a loaded context into run options the runner executes", async () => {
		const dir = workspace({
			tasks: {
				lint: { command: "echo lint" },
				build: { command: "echo build", dependsOn: ["lint"] },
			},
		});

		const results = await withCwd(dir, async () => {
			const ctx = await createContext(dir);
			return runTasksWithDeps("build", ctx.graph, toRunOptions(ctx));
		});

		expect(results.map((r) => r.task)).toEqual(["lint", "build"]);
		expect(results.every((r) => r.cacheHit === false)).toBe(true);
	});

	it("writes a cache file the next run reads back as a hit", async () => {
		const dir = workspace({
			tasks: { build: { command: "echo build", inputs: ["src/**"] } },
		});
		writeFiles(dir, { "src/index.ts": "export const value = 1;\n" });

		const run = async () =>
			withCwd(dir, async () => {
				const ctx = await createContext(dir);
				return runTasksWithDeps("build", ctx.graph, toRunOptions(ctx));
			});

		expect((await run())[0]?.cacheHit).toBe(false);
		expect((await run())[0]?.cacheHit).toBe(true);
	});

	it("invalidates the cache when a hashed input changes", async () => {
		const dir = workspace({
			tasks: { build: { command: "echo build", inputs: ["src/**"] } },
		});
		writeFiles(dir, { "src/index.ts": "export const value = 1;\n" });

		const run = async () =>
			withCwd(dir, async () => {
				const ctx = await createContext(dir);
				return runTasksWithDeps("build", ctx.graph, toRunOptions(ctx));
			});

		await run();
		writeFiles(dir, { "src/index.ts": "export const value = 2;\n" });

		expect((await run())[0]?.cacheHit).toBe(false);
	});

	it("carries workspace tasks from the package graph into the plan", async () => {
		const dir = createTempWorkspace("seam");
		writeFiles(dir, {
			"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
			"packages/utils/package.json": JSON.stringify({
				name: "utils",
				scripts: { build: "echo utils" },
			}),
			"packages/web/package.json": JSON.stringify({
				name: "web",
				scripts: { build: "echo web" },
				dependencies: { utils: "workspace:*" },
			}),
			"variant.config.json": JSON.stringify({
				workspace: { enabled: true },
				tasks: { build: { command: "echo root" } },
				cache: { directory: path.join(dir, ".variant/cache") },
			}),
		});

		const ctx = await withCwd(dir, () => createContext(dir));
		const tasks: Record<string, TaskConfig> = ctx.config.tasks;

		expect(Object.keys(tasks)).toContain("utils:build");
		expect(Object.keys(tasks)).toContain("web:build");
		expect(tasks["web:build"]?.dependsOn).toContain("utils:build");
	});
});
