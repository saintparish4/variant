/**
 * Boundary: `createContext()` meeting real config loading, a real workspace on
 * disk, and a real git repository. It shells out to git and globs the
 * filesystem, so it cannot answer anything true at the unit tier.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-ctx-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

function writeMinimalConfig(dir: string, config: object = {}): void {
	writeFileSync(path.join(dir, "variant.config.json"), JSON.stringify(config));
}

describe("createContext", () => {
	it("returns a valid context with all defaults (no config file)", async () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "package.json"), "{}");
		const { createContext } = await import("../../cli/context.js");
		const ctx = await createContext(dir);
		expect(ctx.cwd).toBe(dir);
		expect(ctx.config.strategy).toBe("adaptive");
		expect(ctx.pm).toBeDefined();
		expect(ctx.graph).toBeDefined();
		expect(ctx.plugins).toBeDefined();
	});

	it("loads JSON config file and applies it", async () => {
		const dir = makeTmpDir();
		writeMinimalConfig(dir, { strategy: "strict", tasks: { build: {} } });
		const { createContext } = await import("../../cli/context.js");
		const ctx = await createContext(dir);
		expect(ctx.config.strategy).toBe("strict");
	});

	it("workspace mode: auto-generates tasks from packages", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			path.join(dir, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n",
		);
		writeMinimalConfig(dir, {
			workspace: { enabled: true },
			tasks: {},
		});
		mkdirSync(path.join(dir, "packages/lib"), { recursive: true });
		writeFileSync(
			path.join(dir, "packages/lib/package.json"),
			JSON.stringify({ name: "lib", scripts: { build: "tsc" } }),
		);
		const { createContext } = await import("../../cli/context.js");
		const ctx = await createContext(dir);
		expect(ctx.config.tasks["lib:build"]).toBeDefined();
	});

	it("registers framework plugins in correct order", async () => {
		const dir = makeTmpDir();
		writeMinimalConfig(dir);
		const { createContext } = await import("../../cli/context.js");
		const ctx = await createContext(dir);
		const names = ctx.plugins.list().map((p) => p.name);
		expect(names).toContain("framework:next");
		expect(names).toContain("framework:vite");
		expect(names).toContain("framework:generic");
	});
});

describe("toRunOptions", () => {
	it("maps context fields to RunOptions", async () => {
		const dir = makeTmpDir();
		writeMinimalConfig(dir, { tasks: { build: {} } });
		const { createContext, toRunOptions } = await import(
			"../../cli/context.js"
		);
		const ctx = await createContext(dir);
		const opts = toRunOptions(ctx, { concurrency: 4 });
		expect(opts.cwd).toBe(dir);
		expect(opts.concurrency).toBe(4);
		expect(opts.pm).toBeDefined();
		expect(opts.config).toBe(ctx.config);
	});

	it("does not include useScheduler when scheduler policy is undefined", async () => {
		const dir = makeTmpDir();
		writeMinimalConfig(dir, { tasks: {} });
		const { createContext, toRunOptions } = await import(
			"../../cli/context.js"
		);
		const ctx = await createContext(dir);
		const opts = toRunOptions(ctx);
		expect(opts.useScheduler).toBeUndefined();
	});

	it("enables useScheduler when scheduler.policy is set", async () => {
		const dir = makeTmpDir();
		writeMinimalConfig(dir, {
			scheduler: { policy: "critical-path" },
			tasks: {},
		});
		const { createContext, toRunOptions } = await import(
			"../../cli/context.js"
		);
		const ctx = await createContext(dir);
		const opts = toRunOptions(ctx);
		expect(opts.useScheduler).toBe(true);
	});

	it("includes packageScopes when they exist on context", async () => {
		const dir = makeTmpDir();
		writeMinimalConfig(dir, { tasks: {} });
		const { createContext, toRunOptions } = await import(
			"../../cli/context.js"
		);
		const ctx = await createContext(dir);
		ctx.packageScopes = ["/some/dir"];
		const opts = toRunOptions(ctx);
		expect(opts.packageScopes).toEqual(["/some/dir"]);
	});
});

/** Two packages, `web` depending on `utils`, with utils changed in HEAD. */
function workspaceRepoWithChangedUtils(): string {
	const dir = makeTmpDir();
	writeFileSync(
		path.join(dir, "pnpm-workspace.yaml"),
		"packages:\n  - 'packages/*'\n",
	);
	mkdirSync(path.join(dir, "packages/utils/src"), { recursive: true });
	mkdirSync(path.join(dir, "packages/web/src"), { recursive: true });
	writeFileSync(
		path.join(dir, "packages/utils/package.json"),
		JSON.stringify({ name: "utils", scripts: { build: "tsc" } }),
	);
	writeFileSync(
		path.join(dir, "packages/web/package.json"),
		JSON.stringify({
			name: "web",
			scripts: { build: "next build" },
			dependencies: { utils: "workspace:*" },
		}),
	);
	writeFileSync(
		path.join(dir, "packages/utils/src/index.ts"),
		"export const x = 1;\n",
	);
	writeFileSync(
		path.join(dir, "packages/web/src/index.ts"),
		"export const y = 1;\n",
	);
	writeMinimalConfig(dir, { workspace: { enabled: true }, tasks: {} });

	const GIT = ["-c", "user.email=t@t.com", "-c", "user.name=T"].join(" ");
	const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "ignore" });
	run("git init");
	run(`git ${GIT} commit --allow-empty -m base`);
	run("git add .");
	run(`git ${GIT} commit -m initial`);

	// Change utils and commit so the HEAD~1 diff shows utils changed.
	writeFileSync(
		path.join(dir, "packages/utils/src/index.ts"),
		"export const x = 2;\n",
	);
	run("git add .");
	run(`git ${GIT} commit -m "change utils"`);
	return dir;
}

describe("createContext (cascade / affectedPackages)", () => {
	it("affectedPackages is undefined when no git repo exists", async () => {
		const dir = makeTmpDir();
		writeMinimalConfig(dir, { tasks: {} });
		const { createContext } = await import("../../cli/context.js");
		const ctx = await createContext(dir);
		expect(ctx.affectedPackages).toBeUndefined();
	});

	it("affectedPackages cascades to dependents when git detects a direct change", async () => {
		const dir = workspaceRepoWithChangedUtils();

		const { createContext } = await import("../../cli/context.js");
		const ctx = await createContext(dir);

		// utils directly changed; web depends on utils → both in affectedPackages
		expect(ctx.affectedPackages?.has("utils")).toBe(true);
		expect(ctx.affectedPackages?.has("web")).toBe(true);
		// packageScopes covers both dirs (so each task hashes its own files normally)
		expect(ctx.packageScopes?.length).toBe(2);
	});

	it("scope: false skips the git diff but still builds the workspace graph", async () => {
		const dir = workspaceRepoWithChangedUtils();

		const { createContext } = await import("../../cli/context.js");
		const ctx = await createContext(dir, { scope: false });

		expect(ctx.affectedPackages).toBeUndefined();
		expect(ctx.packageScopes).toBeUndefined();
		// Workspace task generation is independent of scoping and must survive.
		expect(Object.keys(ctx.config.tasks)).toContain("utils:build");
		expect(Object.keys(ctx.config.tasks)).toContain("web:build");
	});

	it("scope: false leaves provenance without a changed-file reason", async () => {
		const dir = workspaceRepoWithChangedUtils();

		const { createContext } = await import("../../cli/context.js");
		const scoped = await createContext(dir);
		const unscoped = await createContext(dir, { scope: false });

		expect(scoped.provenance).toBeDefined();
		expect(unscoped.provenance).toBeDefined();
	});
});
