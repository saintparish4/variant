import { describe, expect, it } from "vitest";
import type { ImportEntry, SymbolGraph } from "../../semantic/symbol-graph.js";
import type { WorkspacePackageInfo } from "../workspace-check.js";
import { checkWorkspace } from "../workspace-check.js";

function makeSymbolGraph(files: Record<string, ImportEntry[]>): SymbolGraph {
	const out: SymbolGraph["files"] = {};
	for (const [file, imports] of Object.entries(files)) {
		out[file] = { contentHash: "", symbols: [], imports, notes: [] };
	}
	return { version: 1, generatedAt: "", files: out };
}

function bare(module: string): ImportEntry {
	return { module, kind: "static", typeOnly: false, names: ["x"] };
}

function pkg(
	name: string,
	dir: string,
	declared: string[] = [],
): WorkspacePackageInfo {
	return { name, dir, declared: new Set(declared) };
}

function run(
	files: Record<string, ImportEntry[]>,
	packages: WorkspacePackageInfo[],
	rootDeclared: string[] = [],
) {
	return checkWorkspace({
		symbolGraph: makeSymbolGraph(files),
		packages,
		rootDeclared: new Set(rootDeclared),
	});
}

describe("checkWorkspace", () => {
	it("flags a bare workspace import that is not declared", () => {
		const result = run(
			{
				"packages/auth/src/index.ts": [],
				"apps/web/src/page.ts": [bare("@org/auth")],
			},
			[pkg("@org/auth", "packages/auth"), pkg("@org/web", "apps/web")],
		);
		expect(result.packagesChecked).toBe(2);
		expect(result.violations).toEqual([
			{
				kind: "undeclared-workspace-dep",
				package: "@org/web",
				target: "@org/auth",
				files: ["apps/web/src/page.ts"],
			},
		]);
	});

	it("does not read a computed specifier's prefix as a package name", () => {
		const result = run(
			{
				"apps/web/src/page.ts": [
					{ module: "@org/", kind: "pattern", typeOnly: false, names: [] },
				],
			},
			[pkg("@org/web", "apps/web")],
		);
		expect(result.violations).toEqual([]);
	});

	it("accepts a declared workspace dependency", () => {
		const result = run(
			{
				"packages/auth/src/index.ts": [],
				"apps/web/src/page.ts": [bare("@org/auth")],
			},
			[
				pkg("@org/auth", "packages/auth"),
				pkg("@org/web", "apps/web", ["@org/auth"]),
			],
		);
		expect(result.violations).toEqual([]);
	});

	it("flags relative reach-ins even when the dependency is declared", () => {
		const result = run(
			{
				"packages/auth/src/session.ts": [],
				"apps/web/src/page.ts": [
					bare("@org/auth"),
					{
						module: "../../../packages/auth/src/session.js",
						kind: "static",
						typeOnly: false,
						names: ["session"],
					},
				],
			},
			[
				pkg("@org/auth", "packages/auth"),
				pkg("@org/web", "apps/web", ["@org/auth"]),
			],
		);
		expect(result.violations).toEqual([
			{
				kind: "cross-package-relative-import",
				package: "@org/web",
				target: "@org/auth",
				files: ["apps/web/src/page.ts"],
			},
		]);
	});

	it("reports both findings when a sibling is imported by name and by path", () => {
		const result = run(
			{
				"packages/auth/src/session.ts": [],
				"apps/web/src/page.ts": [
					bare("@org/auth"),
					{
						module: "../../../packages/auth/src/session.js",
						kind: "static",
						typeOnly: false,
						names: ["session"],
					},
				],
			},
			[pkg("@org/auth", "packages/auth"), pkg("@org/web", "apps/web")],
		);
		expect(result.violations.map((v) => v.kind).sort()).toEqual([
			"cross-package-relative-import",
			"undeclared-workspace-dep",
		]);
	});

	it("flags undeclared externals unless the package or root declares them", () => {
		const files = {
			"apps/web/src/page.ts": [bare("react"), bare("@scope/util/deep")],
		};
		const packages = [pkg("@org/web", "apps/web")];

		const undeclared = run(files, packages);
		expect(undeclared.violations.map((v) => v.target).sort()).toEqual([
			"@scope/util",
			"react",
		]);
		expect(undeclared.violations[0]?.kind).toBe("undeclared-external-dep");

		expect(
			run(files, [pkg("@org/web", "apps/web", ["react", "@scope/util"])])
				.violations,
		).toEqual([]);
		expect(run(files, packages, ["react", "@scope/util"]).violations).toEqual(
			[],
		);
	});

	it("exempts node builtins with and without the node: prefix", () => {
		const result = run(
			{
				"apps/web/src/page.ts": [bare("node:fs"), bare("path"), bare("fs")],
			},
			[pkg("@org/web", "apps/web")],
		);
		expect(result.violations).toEqual([]);
	});

	it("exempts self-imports", () => {
		const result = run({ "packages/auth/src/index.ts": [bare("@org/auth")] }, [
			pkg("@org/auth", "packages/auth"),
		]);
		expect(result.violations).toEqual([]);
	});

	it("groups repeated violations and sorts their files", () => {
		const result = run(
			{
				"packages/auth/src/index.ts": [],
				"apps/web/src/b.ts": [bare("@org/auth")],
				"apps/web/src/a.ts": [bare("@org/auth")],
			},
			[pkg("@org/auth", "packages/auth"), pkg("@org/web", "apps/web")],
		);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.files).toEqual([
			"apps/web/src/a.ts",
			"apps/web/src/b.ts",
		]);
	});

	it("flags workspace imports even when no entry file resolves", () => {
		const result = run({ "apps/web/src/page.ts": [bare("@org/db")] }, [
			pkg("@org/db", "packages/db"),
			pkg("@org/web", "apps/web"),
		]);
		expect(result.violations).toEqual([
			{
				kind: "undeclared-workspace-dep",
				package: "@org/web",
				target: "@org/db",
				files: ["apps/web/src/page.ts"],
			},
		]);
	});

	it("ignores files not owned by any workspace package", () => {
		const result = run({ "scripts/tool.ts": [bare("react")] }, [
			pkg("@org/web", "apps/web"),
		]);
		expect(result.violations).toEqual([]);
	});

	it("ignores relative imports inside the same package", () => {
		const result = run(
			{
				"apps/web/src/util.ts": [],
				"apps/web/src/page.ts": [
					{
						module: "./util.js",
						kind: "static",
						typeOnly: false,
						names: ["u"],
					},
				],
			},
			[pkg("@org/web", "apps/web")],
		);
		expect(result.violations).toEqual([]);
	});
});
