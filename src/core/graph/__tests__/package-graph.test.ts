import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeAffectedPackages,
	loadPackageGraph,
	tasksFromPackageGraph,
} from "../package-graph.js";

const tmpDirs: string[] = [];

const makeTmpDir = () => {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-pg-"));
	tmpDirs.push(dir);
	return dir;
};

const fixture = () => {
	const root = makeTmpDir();
	writeFileSync(
		path.join(root, "pnpm-workspace.yaml"),
		"packages:\n  - 'packages/*'\n",
	);
	mkdirSync(path.join(root, "packages/utils"), { recursive: true });
	mkdirSync(path.join(root, "packages/web"), { recursive: true });
	writeFileSync(
		path.join(root, "packages/utils/package.json"),
		JSON.stringify({ name: "utils", scripts: { build: "tsc" } }),
	);
	writeFileSync(
		path.join(root, "packages/web/package.json"),
		JSON.stringify({
			name: "web",
			scripts: { build: "next build" },
			dependencies: { utils: "workspace:*" },
		}),
	);
	return root;
};

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

describe("loadPackageGraph", () => {
	it("discovers pnpm workspace packages", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		expect(g.packages.map((p) => p.name).sort()).toEqual(["utils", "web"]);
	});

	it("computes intra-workspace edges only", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		expect([...(g.edges.get("web") ?? [])]).toEqual(["utils"]);
		expect([...(g.edges.get("utils") ?? [])]).toEqual([]);
	});

	it("readWorkspaceGlobs: falls back to package.json workspaces array", async () => {
		const root = makeTmpDir();
		writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		mkdirSync(path.join(root, "packages/lib"), { recursive: true });
		writeFileSync(
			path.join(root, "packages/lib/package.json"),
			JSON.stringify({ name: "lib", scripts: { build: "tsc" } }),
		);
		const g = await loadPackageGraph(root);
		expect(g.packages.map((p) => p.name)).toContain("lib");
	});

	it("readWorkspaceGlobs: uses fallback when no config present", async () => {
		const root = makeTmpDir();
		writeFileSync(path.join(root, "package.json"), JSON.stringify({}));
		mkdirSync(path.join(root, "packages/x"), { recursive: true });
		writeFileSync(
			path.join(root, "packages/x/package.json"),
			JSON.stringify({ name: "x" }),
		);
		const g = await loadPackageGraph(root);
		expect(g.packages.map((p) => p.name)).toContain("x");
	});

	it("skips directories without package.json", async () => {
		const root = makeTmpDir();
		writeFileSync(
			path.join(root, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n",
		);
		mkdirSync(path.join(root, "packages/no-manifest"), { recursive: true });
		const g = await loadPackageGraph(root);
		expect(g.packages).toHaveLength(0);
	});

	it("skips packages with no name field in manifest", async () => {
		const root = makeTmpDir();
		writeFileSync(
			path.join(root, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n",
		);
		mkdirSync(path.join(root, "packages/anon"), { recursive: true });
		writeFileSync(
			path.join(root, "packages/anon/package.json"),
			JSON.stringify({ version: "1.0.0" }),
		);
		const g = await loadPackageGraph(root);
		expect(g.packages).toHaveLength(0);
	});
});

describe("computeAffectedPackages", () => {
	it("includes directly-changed packages", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		const affected = computeAffectedPackages(new Set(["utils"]), g);
		expect(affected.has("utils")).toBe(true);
	});

	it("cascades to packages that depend on the changed package", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		// web depends on utils; changing utils should include web
		const affected = computeAffectedPackages(new Set(["utils"]), g);
		expect(affected.has("web")).toBe(true);
	});

	it("excludes packages that do not depend on the changed package", async () => {
		const root = makeTmpDir();
		writeFileSync(
			path.join(root, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n",
		);
		mkdirSync(path.join(root, "packages/utils"), { recursive: true });
		mkdirSync(path.join(root, "packages/web"), { recursive: true });
		mkdirSync(path.join(root, "packages/docs"), { recursive: true });
		writeFileSync(
			path.join(root, "packages/utils/package.json"),
			JSON.stringify({ name: "utils", scripts: { build: "tsc" } }),
		);
		writeFileSync(
			path.join(root, "packages/web/package.json"),
			JSON.stringify({
				name: "web",
				scripts: { build: "next build" },
				dependencies: { utils: "workspace:*" },
			}),
		);
		// docs has no dependency on utils
		writeFileSync(
			path.join(root, "packages/docs/package.json"),
			JSON.stringify({ name: "docs", scripts: { build: "echo docs" } }),
		);
		const g = await loadPackageGraph(root);
		const affected = computeAffectedPackages(new Set(["utils"]), g);
		expect(affected.has("utils")).toBe(true);
		expect(affected.has("web")).toBe(true);
		expect(affected.has("docs")).toBe(false);
	});

	it("handles transitive cascade (A→B→C)", async () => {
		const root = makeTmpDir();
		writeFileSync(
			path.join(root, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n",
		);
		for (const name of ["a", "b", "c"]) {
			mkdirSync(path.join(root, `packages/${name}`), { recursive: true });
		}
		writeFileSync(
			path.join(root, "packages/a/package.json"),
			JSON.stringify({ name: "a", scripts: { build: "echo a" } }),
		);
		writeFileSync(
			path.join(root, "packages/b/package.json"),
			JSON.stringify({
				name: "b",
				scripts: { build: "echo b" },
				dependencies: { a: "workspace:*" },
			}),
		);
		writeFileSync(
			path.join(root, "packages/c/package.json"),
			JSON.stringify({
				name: "c",
				scripts: { build: "echo c" },
				dependencies: { b: "workspace:*" },
			}),
		);
		const g = await loadPackageGraph(root);
		const affected = computeAffectedPackages(new Set(["a"]), g);
		expect(affected.has("a")).toBe(true);
		expect(affected.has("b")).toBe(true); // b depends on a
		expect(affected.has("c")).toBe(true); // c depends on b which depends on a
	});

	it("returns only changed package when it has no dependents", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		// web has no dependents in this fixture
		const affected = computeAffectedPackages(new Set(["web"]), g);
		expect(affected.has("web")).toBe(true);
		expect(affected.has("utils")).toBe(false);
	});

	it("diamond: two packages depend on the same changed package", async () => {
		const root = makeTmpDir();
		writeFileSync(
			path.join(root, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n",
		);
		for (const name of ["base", "left", "right"]) {
			mkdirSync(path.join(root, `packages/${name}`), { recursive: true });
		}
		writeFileSync(
			path.join(root, "packages/base/package.json"),
			JSON.stringify({ name: "base", scripts: { build: "echo base" } }),
		);
		writeFileSync(
			path.join(root, "packages/left/package.json"),
			JSON.stringify({
				name: "left",
				scripts: { build: "echo left" },
				dependencies: { base: "workspace:*" },
			}),
		);
		writeFileSync(
			path.join(root, "packages/right/package.json"),
			JSON.stringify({
				name: "right",
				scripts: { build: "echo right" },
				dependencies: { base: "workspace:*" },
			}),
		);
		const g = await loadPackageGraph(root);
		const affected = computeAffectedPackages(new Set(["base"]), g);
		expect(affected.has("base")).toBe(true);
		expect(affected.has("left")).toBe(true);
		expect(affected.has("right")).toBe(true);
	});
});

describe("tasksFromPackageGraph", () => {
	it("auto-generates <pkg>:build tasks with cross-pkg deps", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		const tasks = tasksFromPackageGraph(g, {});
		expect(tasks["web:build"]).toBeDefined();
		expect(tasks["web:build"]?.dependsOn).toEqual(["utils:build"]);
	});

	it("user-defined tasks win over generated ones", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		const existing = { "web:build": { command: "echo override" } };
		const tasks = tasksFromPackageGraph(g, existing);
		expect(tasks["web:build"]?.command).toBe("echo override");
	});

	it("custom scripts filter", async () => {
		const root = fixture();
		const g = await loadPackageGraph(root);
		const tasks = tasksFromPackageGraph(g, {}, ["test"]);
		expect(tasks["web:build"]).toBeUndefined();
		expect(tasks["utils:build"]).toBeUndefined();
	});
});
