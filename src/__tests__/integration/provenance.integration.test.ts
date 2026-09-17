/**
 * Boundary: `createContext()` wiring the real DAG builder and the real git
 * layer into a provenance map. The claim under test — that a task's recorded
 * dependents and changed files match what the workspace actually contains —
 * needs a real repo and a real dependency graph to mean anything.
 */

import { execSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../../cli/context.js";
import {
	cleanupTempWorkspaces,
	createTempWorkspace,
	writeFiles,
} from "../helpers/cli-harness.js";

const IDENTITY = "-c user.email=t@t.com -c user.name=T";

function git(dir: string, command: string): void {
	execSync(`git ${command}`, { cwd: dir, stdio: "ignore" });
}

/**
 * web depends on utils; docs stands alone. One commit of baseline, so the
 * caller's edit becomes the diff against HEAD~1.
 */
function workspaceWithBaseline(): string {
	const dir = createTempWorkspace("provenance");
	writeFiles(dir, {
		"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
		"variant.config.json": JSON.stringify({
			workspace: { enabled: true, scripts: ["build"] },
			tasks: {},
		}),
		"packages/utils/package.json": JSON.stringify({
			name: "utils",
			scripts: { build: "echo utils" },
		}),
		"packages/utils/src/index.ts": "export const value = 1;\n",
		"packages/web/package.json": JSON.stringify({
			name: "web",
			scripts: { build: "echo web" },
			dependencies: { utils: "workspace:*" },
		}),
		"packages/web/src/index.ts": "export const web = 1;\n",
		"packages/docs/package.json": JSON.stringify({
			name: "docs",
			scripts: { build: "echo docs" },
		}),
		"packages/docs/src/index.ts": "export const doc = 1;\n",
	});
	git(dir, "init");
	git(dir, "add .");
	git(dir, `${IDENTITY} commit -m baseline`);
	return dir;
}

afterEach(cleanupTempWorkspaces);

describe("createContext provenance", () => {
	it("records an entry for every task in the graph", async () => {
		const dir = workspaceWithBaseline();
		const ctx = await createContext(dir);

		// Includes the bare `build`/`dev` that the framework plugin's onDetect
		// auto-registers — provenance covers the graph as finally assembled,
		// not just the tasks the config file spelled out.
		expect([...ctx.provenance.keys()].sort()).toEqual([
			"build",
			"dev",
			"docs:build",
			"utils:build",
			"web:build",
		]);
		expect([...ctx.provenance.keys()].sort()).toEqual(
			Object.keys(ctx.config.tasks).sort(),
		);
	});

	it("reports an uncacheable task as always-run", async () => {
		const dir = workspaceWithBaseline();
		const ctx = await createContext(dir);

		// The auto-registered `build` declares no inputs, so it never reaches a
		// hash comparison and no more specific reason exists for it.
		expect(ctx.provenance.get("build")?.reason).toEqual({ kind: "always" });
	});

	it("derives upstream tasks from the real workspace dependency graph", async () => {
		const dir = workspaceWithBaseline();
		const ctx = await createContext(dir);

		expect(ctx.provenance.get("web:build")?.upstreamTasks).toEqual([
			"utils:build",
		]);
		expect(ctx.provenance.get("utils:build")?.upstreamTasks).toEqual([]);
	});

	it("names the dependent a change actually cascades to", async () => {
		const dir = workspaceWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/index.ts": "export const value = 2;\n",
		});
		git(dir, "add .");
		git(dir, `${IDENTITY} commit -m "change utils"`);

		const ctx = await createContext(dir);

		// web depends on utils and is therefore invalidated with it; docs does
		// not and must not be listed.
		expect(ctx.provenance.get("utils:build")?.dirtyDependents).toEqual([
			"web:build",
		]);
	});

	it("carries the real changed-file list on an affected task", async () => {
		const dir = workspaceWithBaseline();
		writeFiles(dir, {
			"packages/utils/src/index.ts": "export const value = 2;\n",
		});
		git(dir, "add .");
		git(dir, `${IDENTITY} commit -m "change utils"`);

		const ctx = await createContext(dir);
		const reason = ctx.provenance.get("utils:build")?.reason;

		expect(reason?.kind).toBe("affected-by");
		if (reason?.kind !== "affected-by") throw new Error("unreachable");
		expect(reason.changedFiles).toContain("packages/utils/src/index.ts");
	});
});
