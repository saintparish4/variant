import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ImportEntry, SymbolGraph } from "../../semantic/symbol-graph.js";
import {
	buildImportGraph,
	computeAffectedFiles,
	getDependents,
} from "../import-graph.js";
import { toPathAliases } from "../tsconfig-paths.js";

function staticImport(module: string): ImportEntry {
	return { module, kind: "static", typeOnly: false, names: [] };
}

/** SymbolGraph literal where each file maps to its import entries. */
function makeGraph(files: Record<string, ImportEntry[]>): SymbolGraph {
	const out: SymbolGraph["files"] = {};
	for (const [file, imports] of Object.entries(files)) {
		out[file] = { contentHash: "", symbols: [], imports, notes: [] };
	}
	return { version: 1, generatedAt: "", files: out };
}

function sorted(set: ReadonlySet<string> | undefined): string[] {
	return [...(set ?? [])].sort();
}

describe("buildImportGraph", () => {
	it("resolves .js specifiers to .ts sources and inverts them", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/auth.ts": [],
				"src/app.ts": [staticImport("./auth.js")],
				"src/cli.ts": [staticImport("./app.js")],
			}),
		);

		expect(sorted(graph.imports.get("src/app.ts"))).toEqual(["src/auth.ts"]);
		expect(sorted(graph.dependents.get("src/auth.ts"))).toEqual(["src/app.ts"]);
		expect(sorted(graph.dependents.get("src/app.ts"))).toEqual(["src/cli.ts"]);
		expect(sorted(graph.dependents.get("src/cli.ts"))).toEqual([]);
	});

	it("resolves extensionless, index, tsx, and dotted-name specifiers", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/a.ts": [],
				"src/widgets/index.tsx": [],
				"src/button.styles.ts": [],
				"src/m.ts": [
					staticImport("./a"),
					staticImport("./widgets"),
					staticImport("./button.styles.js"),
				],
			}),
		);

		expect(sorted(graph.imports.get("src/m.ts"))).toEqual([
			"src/a.ts",
			"src/button.styles.ts",
			"src/widgets/index.tsx",
		]);
		expect(sorted(graph.unresolved.get("src/m.ts"))).toEqual([]);
	});

	it("resolves ../ specifiers across directories", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/core/util.ts": [],
				"src/cli/run.ts": [staticImport("../core/util.js")],
			}),
		);
		expect(sorted(graph.imports.get("src/cli/run.ts"))).toEqual([
			"src/core/util.ts",
		]);
	});

	it("reports missing files and non-TS assets as unresolved", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/m.ts": [
					staticImport("./missing.js"),
					staticImport("./styles.css"),
					staticImport("../../outside.js"),
				],
			}),
		);
		expect(sorted(graph.unresolved.get("src/m.ts"))).toEqual([
			"../../outside.js",
			"./missing.js",
			"./styles.css",
		]);
		expect(sorted(graph.imports.get("src/m.ts"))).toEqual([]);
	});

	it("classifies bare and node: specifiers as externals", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/m.ts": [
					staticImport("node:path"),
					staticImport("react"),
					staticImport("@scope/pkg/deep"),
				],
			}),
		);
		expect(sorted(graph.externals.get("src/m.ts"))).toEqual([
			"@scope/pkg/deep",
			"node:path",
			"react",
		]);
	});

	it("resolves workspace package imports through packageDirs", () => {
		const graph = buildImportGraph(
			makeGraph({
				"packages/auth/src/index.ts": [],
				"packages/auth/src/session.ts": [],
				"apps/web/src/page.ts": [
					staticImport("@org/auth"),
					staticImport("@org/auth/session.js"),
				],
			}),
			{ packageDirs: { "@org/auth": "packages/auth" } },
		);

		expect(sorted(graph.imports.get("apps/web/src/page.ts"))).toEqual([
			"packages/auth/src/index.ts",
			"packages/auth/src/session.ts",
		]);
		expect(sorted(graph.dependents.get("packages/auth/src/index.ts"))).toEqual([
			"apps/web/src/page.ts",
		]);
	});

	it("marks workspace package imports with no matching file as unresolved", () => {
		const graph = buildImportGraph(
			makeGraph({
				"apps/web/src/page.ts": [staticImport("@org/auth")],
			}),
			{ packageDirs: { "@org/auth": "packages/auth" } },
		);
		expect(sorted(graph.unresolved.get("apps/web/src/page.ts"))).toEqual([
			"@org/auth",
		]);
	});

	it("records per-edge names, type-only-ness, and dynamic flags", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/a.ts": [],
				"src/b.ts": [],
				"src/m.ts": [
					{ module: "./a.js", kind: "static", typeOnly: true, names: ["T"] },
					{
						module: "./a.js",
						kind: "static",
						typeOnly: false,
						names: ["login"],
					},
					{ module: "./b.js", kind: "dynamic", typeOnly: false, names: [] },
				],
			}),
		);

		const toA = graph.edges.get("src/m.ts")?.get("src/a.ts");
		expect(sorted(toA?.names)).toEqual(["T", "login"]);
		// One contributing import is a value import, so the edge is not type-only.
		expect(toA?.typeOnly).toBe(false);
		expect(toA?.dynamic).toBe(false);

		const toB = graph.edges.get("src/m.ts")?.get("src/b.ts");
		expect(toB?.dynamic).toBe(true);
	});

	it("creates edges for type-only, re-export, and dynamic imports", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/a.ts": [],
				"src/b.ts": [],
				"src/c.ts": [],
				"src/m.ts": [
					{ module: "./a.js", kind: "static", typeOnly: true, names: ["T"] },
					{ module: "./b.js", kind: "reexport", typeOnly: false, names: ["*"] },
					{ module: "./c.js", kind: "dynamic", typeOnly: false, names: [] },
				],
			}),
		);
		expect(sorted(graph.imports.get("src/m.ts"))).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
	});
});

describe("computeAffectedFiles", () => {
	const chain = buildImportGraph(
		makeGraph({
			"src/a.ts": [],
			"src/b.ts": [staticImport("./a.js")],
			"src/c.ts": [staticImport("./b.js")],
			"src/d.ts": [],
		}),
	);

	it("walks transitive dependents", () => {
		const affected = computeAffectedFiles(new Set(["src/a.ts"]), chain);
		expect([...affected].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});

	it("leaves unrelated files untouched", () => {
		const affected = computeAffectedFiles(new Set(["src/d.ts"]), chain);
		expect([...affected].sort()).toEqual(["src/d.ts"]);
	});

	it("terminates on import cycles", () => {
		const cyclic = buildImportGraph(
			makeGraph({
				"src/a.ts": [staticImport("./b.js")],
				"src/b.ts": [staticImport("./a.js")],
			}),
		);
		const affected = computeAffectedFiles(new Set(["src/a.ts"]), cyclic);
		expect([...affected].sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("normalizes Windows-style separators in changed paths", () => {
		const affected = computeAffectedFiles(new Set(["src\\a.ts"]), chain);
		expect(affected.has("src/b.ts")).toBe(true);
	});
});

describe("getDependents", () => {
	it("returns direct dependents and empty sets for unknown files", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/a.ts": [],
				"src/b.ts": [staticImport("./a.js")],
			}),
		);
		expect(sorted(getDependents(graph, "src/a.ts"))).toEqual(["src/b.ts"]);
		expect(sorted(getDependents(graph, "src\\a.ts"))).toEqual(["src/b.ts"]);
		expect(sorted(getDependents(graph, "src/nope.ts"))).toEqual([]);
	});
});

describe("buildImportGraph with tsconfig paths", () => {
	const root = path.resolve("/repo");
	const aliases = toPathAliases(
		root,
		{
			"@/*": [path.resolve(root, "src/*")],
			"#config": [path.resolve(root, "src/config/index.ts")],
		},
		root,
	);

	it("follows an alias to the file it names", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/lib/date.ts": [],
				"src/app.ts": [staticImport("@/lib/date")],
			}),
			{ pathAliases: aliases },
		);

		expect(sorted(graph.imports.get("src/app.ts"))).toEqual([
			"src/lib/date.ts",
		]);
		expect(sorted(graph.dependents.get("src/lib/date.ts"))).toEqual([
			"src/app.ts",
		]);
	});

	it("resolves an alias onto an index file", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/lib/index.ts": [],
				"src/app.ts": [staticImport("@/lib")],
			}),
			{ pathAliases: aliases },
		);

		expect(sorted(graph.imports.get("src/app.ts"))).toEqual([
			"src/lib/index.ts",
		]);
	});

	it("resolves an exact alias", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/config/index.ts": [],
				"src/app.ts": [staticImport("#config")],
			}),
			{ pathAliases: aliases },
		);

		expect(sorted(graph.imports.get("src/app.ts"))).toEqual([
			"src/config/index.ts",
		]);
	});

	it("propagates a change through an alias-only edge", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/lib/date.ts": [],
				"src/app.ts": [staticImport("@/lib/date")],
				"src/__tests__/app.test.ts": [staticImport("../app.js")],
			}),
			{ pathAliases: aliases },
		);

		expect(
			[...computeAffectedFiles(new Set(["src/lib/date.ts"]), graph)].sort(),
		).toEqual(["src/__tests__/app.test.ts", "src/app.ts", "src/lib/date.ts"]);
	});

	it("calls an alias naming no indexed file unresolved, not external", () => {
		const graph = buildImportGraph(
			makeGraph({ "src/app.ts": [staticImport("@/missing")] }),
			{ pathAliases: aliases },
		);

		expect(sorted(graph.unresolved.get("src/app.ts"))).toEqual(["@/missing"]);
		expect(sorted(graph.externals.get("src/app.ts"))).toEqual([]);
	});

	it("still treats a real package as external", () => {
		const graph = buildImportGraph(
			makeGraph({ "src/app.ts": [staticImport("react")] }),
			{ pathAliases: aliases },
		);

		expect(sorted(graph.externals.get("src/app.ts"))).toEqual(["react"]);
		expect(sorted(graph.unresolved.get("src/app.ts"))).toEqual([]);
	});

	it("lets a workspace package win over an alias sharing its prefix", () => {
		const graph = buildImportGraph(
			makeGraph({
				"packages/ui/src/index.ts": [],
				"src/ui/index.ts": [],
				"src/app.ts": [staticImport("@/ui")],
			}),
			{
				packageDirs: { "@/ui": "packages/ui" },
				pathAliases: aliases,
			},
		);

		expect(sorted(graph.imports.get("src/app.ts"))).toEqual([
			"packages/ui/src/index.ts",
		]);
	});

	it("is unchanged when no aliases are configured", () => {
		const graph = buildImportGraph(
			makeGraph({
				"src/lib/date.ts": [],
				"src/app.ts": [staticImport("@/lib/date")],
			}),
		);

		expect(sorted(graph.imports.get("src/app.ts"))).toEqual([]);
		expect(sorted(graph.externals.get("src/app.ts"))).toEqual(["@/lib/date"]);
	});
});
