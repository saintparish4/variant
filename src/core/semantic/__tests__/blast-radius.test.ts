import { describe, expect, it } from "vitest";
import { buildImportGraph } from "../../graph/import-graph.js";
import type { FileImpact } from "../blast-radius.js";
import { assembleBlastRadius, toFileImpact } from "../blast-radius.js";
import type { ImportEntry, SymbolGraph } from "../symbol-graph.js";

function makeSymbolGraph(files: Record<string, ImportEntry[]>): SymbolGraph {
	const out: SymbolGraph["files"] = {};
	for (const [file, imports] of Object.entries(files)) {
		out[file] = { contentHash: "", symbols: [], imports, notes: [] };
	}
	return { version: 1, generatedAt: "", files: out };
}

function namedImport(module: string, names: string[]): ImportEntry {
	return { module, kind: "static", typeOnly: false, names };
}

function breaking(filePath: string, impactedSymbols: string[]): FileImpact {
	return {
		filePath,
		classification: "breaking",
		impactedSymbols,
		propagates: true,
		notes: [],
	};
}

/**
 * auth.ts is imported four ways; uses-login/uses-version each have one
 * further dependent so second-hop behavior is observable.
 */
const GATING_GRAPH = buildImportGraph(
	makeSymbolGraph({
		"src/auth.ts": [],
		"src/uses-login.ts": [namedImport("./auth.js", ["login"])],
		"src/uses-version.ts": [namedImport("./auth.js", ["VERSION"])],
		"src/star.ts": [namedImport("./auth.js", ["*"])],
		"src/dynamic.ts": [
			{ module: "./auth.js", kind: "dynamic", typeOnly: false, names: [] },
		],
		"src/downstream.ts": [namedImport("./uses-login.js", ["boot"])],
		"src/gated-child.ts": [namedImport("./uses-version.js", ["v"])],
	}),
);

describe("assembleBlastRadius", () => {
	it("non-impacting changes are not seeds", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[
				{
					filePath: "src/auth.ts",
					classification: "non-impacting",
					impactedSymbols: [],
					propagates: false,
					notes: [],
				},
			],
			GATING_GRAPH,
		);
		expect(radius.affectedFiles).toEqual([]);
		expect(radius.affectedPackages).toEqual([]);
		expect(radius.confidence).toBe(1);
	});

	it("internal (body-only) changes affect the file but do not propagate", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[
				{
					filePath: "src/auth.ts",
					classification: "internal",
					impactedSymbols: [],
					propagates: false,
					notes: [],
				},
			],
			GATING_GRAPH,
		);
		expect(radius.affectedFiles).toEqual(["src/auth.ts"]);
	});

	it("gates the first hop per symbol and walks structurally after it", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/auth.ts", ["login"])],
			GATING_GRAPH,
		);

		// uses-login imports the changed symbol; star imports everything;
		// dynamic is unknowable; downstream follows uses-login structurally.
		expect(radius.affectedFiles).toEqual([
			"src/auth.ts",
			"src/downstream.ts",
			"src/dynamic.ts",
			"src/star.ts",
			"src/uses-login.ts",
		]);
		// uses-version imports only an untouched symbol — gated out, and its
		// own dependent is never visited.
		expect(radius.affectedFiles).not.toContain("src/uses-version.ts");
		expect(radius.affectedFiles).not.toContain("src/gated-child.ts");
		expect(
			radius.notes.some((n) => n.includes("dynamic import of src/auth.ts")),
		).toBe(true);
		expect(radius.confidence).toBeLessThan(1);
	});

	it("pure export additions reach only wildcard importers", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/auth.ts", [])],
			GATING_GRAPH,
		);
		expect(radius.affectedFiles).toContain("src/star.ts");
		expect(radius.affectedFiles).toContain("src/dynamic.ts");
		expect(radius.affectedFiles).not.toContain("src/uses-login.ts");
		expect(radius.affectedFiles).not.toContain("src/uses-version.ts");
	});

	it("an ungated change reaches every importer", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[{ ...breaking("src/auth.ts", []), ungated: true }],
			GATING_GRAPH,
		);
		expect(radius.affectedFiles).toContain("src/uses-login.ts");
		expect(radius.affectedFiles).toContain("src/gated-child.ts");
	});

	it("a changed export-star reaches every importer, whatever names it takes", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/auth.ts", ["* from ./a"])],
			GATING_GRAPH,
		);
		expect(radius.affectedFiles).toEqual([
			"src/auth.ts",
			"src/downstream.ts",
			"src/dynamic.ts",
			"src/gated-child.ts",
			"src/star.ts",
			"src/uses-login.ts",
			"src/uses-version.ts",
		]);
	});

	it("a changed non-TypeScript file reaches the files that import it", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/button.ts": [namedImport("./button.css", [])],
				"src/page.ts": [namedImport("./button.js", ["Button"])],
				"src/other.ts": [],
			}),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[
				{
					filePath: "src/button.css",
					classification: "unanalyzed",
					impactedSymbols: [],
					propagates: false,
					notes: [],
				},
			],
			graph,
		);
		expect(radius.affectedFiles).toEqual([
			"src/button.css",
			"src/button.ts",
			"src/page.ts",
		]);
	});

	it("an unanalyzed file nothing imports goes nowhere", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/a.ts": [],
				"src/b.ts": [namedImport("./a.js", ["x"])],
			}),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[
				{
					filePath: "package.json",
					classification: "unanalyzed",
					impactedSymbols: [],
					propagates: false,
					notes: [],
				},
			],
			graph,
		);
		expect(radius.affectedFiles).toEqual(["package.json"]);
		expect(radius.notes).toEqual([
			"1 changed file is not TypeScript and was not analyzed (package.json)",
		]);
		expect(radius.confidence).toBe(0.9);
	});

	it("says a changed file above the working directory is outside it, not that it is not TypeScript", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/app.ts": [namedImport("../../shared/format.js", ["format"])],
				"src/other.ts": [],
			}),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[
				{
					filePath: "../shared/format.ts",
					classification: "unanalyzed",
					impactedSymbols: [],
					propagates: false,
					notes: [],
				},
			],
			graph,
		);
		expect(radius.affectedFiles).toEqual(["../shared/format.ts", "src/app.ts"]);
		expect(radius.notes).toContain(
			"1 changed file is outside the directory variant ran in and was not analyzed (../shared/format.ts)",
		);
	});

	it("says a changed TypeScript file the index leaves out is unindexed, not that it is not TypeScript", () => {
		const graph = buildImportGraph(makeSymbolGraph({ "src/app.ts": [] }));
		const radius = assembleBlastRadius(
			"HEAD~1",
			[
				{
					filePath: "dist/built.ts",
					classification: "unanalyzed",
					impactedSymbols: [],
					propagates: false,
					notes: [],
				},
			],
			graph,
		);
		expect(radius.notes).toEqual([
			"1 changed TypeScript file is in a directory variant does not index and was not analyzed (dist/built.ts)",
		]);
	});

	// A graph built from the working tree has no node for a deleted file, so
	// nothing walks from it; the files still importing it are found by path.
	it("a deleted file reaches the files whose imports still name it", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/app.ts": [namedImport("./auth.js", ["login"])],
				"src/page.ts": [namedImport("./app.js", ["boot"])],
				"src/other.ts": [],
			}),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/auth.ts", ["login"])],
			graph,
		);
		expect(radius.affectedFiles).toEqual([
			"src/app.ts",
			"src/auth.ts",
			"src/page.ts",
		]);
	});

	it("notes unresolved imports on affected files", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/a.ts": [namedImport("./missing.js", ["gone"])],
			}),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/a.ts", ["x"])],
			graph,
		);
		expect(radius.notes).toEqual([
			"1 affected file has unresolved imports: src/a.ts (./missing.js)",
		]);
	});

	it("counts unresolved imports across affected files as one note", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/a.ts": [namedImport("./a.css", [])],
				"src/b.ts": [namedImport("./a.js", ["x"]), namedImport("./b.svg", [])],
				"src/c.ts": [namedImport("./b.js", ["y"]), namedImport("./c.json", [])],
				"src/d.ts": [namedImport("./c.js", ["z"]), namedImport("./d.png", [])],
			}),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/a.ts", ["x"])],
			graph,
		);
		expect(radius.notes).toEqual([
			"4 affected files have unresolved imports: src/a.ts (./a.css), src/b.ts (./b.svg), src/c.ts (./c.json), … 1 more",
		]);
		expect(radius.confidence).toBe(0.9);
	});

	it("notes files whose computed specifiers could name anything", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/a.ts": [],
				"src/loader.ts": [
					{ module: "", kind: "pattern", typeOnly: false, names: [] },
				],
			}),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/a.ts", ["x"])],
			graph,
		);
		expect(radius.repositoryNotes).toEqual([
			"1 file(s) load a module through a fully computed import() or require() specifier (src/loader.ts); a change reached only that way selects no tests",
		]);
		// With nothing to tell packages apart, the loader and the change share one.
		expect(radius.notes).toEqual([
			"1 file(s) in a package this change touches load a module through a fully computed import() or require() specifier (src/loader.ts); a changed file reached only that way selects no tests",
		]);
		expect(radius.confidence).toBe(0.9);
	});

	// The gap stands on every run, but it is a fact about the repository. It
	// should cost a change only where what the loader loads is likely to live.
	describe("a fully computed loader in another package", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"packages/a/src/loader.ts": [
					{ module: "", kind: "pattern", typeOnly: false, names: [] },
				],
				"packages/a/src/x.ts": [],
				"packages/b/src/y.ts": [],
			}),
		);
		const packageRoots = ["", "packages/a", "packages/b"];

		it("does not lower the confidence of a change elsewhere", () => {
			const radius = assembleBlastRadius(
				"HEAD~1",
				[breaking("packages/b/src/y.ts", ["y"])],
				graph,
				{ packageRoots },
			);
			expect(radius.notes).toEqual([]);
			expect(radius.confidence).toBe(1);
			expect(radius.repositoryNotes).toHaveLength(1);
		});

		it("counts against a change in the loader's own package", () => {
			const radius = assembleBlastRadius(
				"HEAD~1",
				[breaking("packages/a/src/x.ts", ["x"])],
				graph,
				{ packageRoots },
			);
			expect(radius.notes).toHaveLength(1);
			expect(radius.confidence).toBe(0.9);
		});

		it("does not count against a changed file a loader could not load", () => {
			const radius = assembleBlastRadius(
				"HEAD~1",
				[
					{
						...breaking("packages/a/native/build.rs", []),
						classification: "unanalyzed",
					},
				],
				graph,
				{ packageRoots },
			);
			expect(radius.notes).toEqual([
				"1 changed file is not TypeScript and was not analyzed (packages/a/native/build.rs)",
			]);
		});

		it("does not count against a change that is comments only", () => {
			const radius = assembleBlastRadius(
				"HEAD~1",
				[
					{
						...breaking("packages/a/src/x.ts", []),
						classification: "non-impacting",
					},
				],
				graph,
				{ packageRoots },
			);
			expect(radius.notes).toEqual([]);
		});
	});

	it("keeps workspace blind spots as standing notes", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("src/a.ts", ["x"])],
			buildImportGraph(makeSymbolGraph({ "src/a.ts": [] })),
			{ workspaceNotes: ["a dependency was not found"] },
		);
		expect(radius.repositoryNotes).toEqual(["a dependency was not found"]);
		expect(radius.notes).toEqual([]);
		expect(radius.confidence).toBe(1);
	});

	it("notes a change inside a local package the graph could not place", () => {
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("libs/ui/src/index.ts", ["Button"])],
			buildImportGraph(makeSymbolGraph({ "libs/ui/src/index.ts": [] })),
			{ undiscoveredPackages: new Map([["@org/ui", "libs/ui"]]) },
		);
		expect(radius.notes).toEqual([
			"1 changed file belongs to @org/ui, a local package variant did not find as a workspace package (libs/ui/src/index.ts); files importing it by name are not reached",
		]);
		expect(radius.confidence).toBe(0.9);
	});

	it("maps affected files to packages and tasks", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"packages/auth/src/index.ts": [],
				"apps/web/src/page.ts": [namedImport("@org/auth", ["login"])],
			}),
			{ packageDirs: { "@org/auth": "packages/auth", "@org/web": "apps/web" } },
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("packages/auth/src/index.ts", ["login"])],
			graph,
			{
				packageDirs: { "@org/auth": "packages/auth", "@org/web": "apps/web" },
				tasks: {
					"@org/auth:build": { command: "b" },
					"@org/web:build": { command: "b" },
					"@org/web:test": { command: "t" },
					"@org/db:build": { command: "b" },
					build: { command: "b" },
				},
			},
		);

		expect(radius.affectedPackages).toEqual(["@org/auth", "@org/web"]);
		expect(radius.affectedTasks).toEqual([
			"@org/auth:build",
			"@org/web:build",
			"@org/web:test",
		]);
	});

	it("maps files outside every package dir to a root package", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({ "scripts/build.ts": [], "packages/a/src/x.ts": [] }),
		);
		const radius = assembleBlastRadius(
			"HEAD~1",
			[breaking("scripts/build.ts", []), breaking("packages/a/src/x.ts", [])],
			graph,
			{ packageDirs: { root: "", "@org/a": "packages/a" } },
		);
		expect(radius.affectedPackages).toEqual(["@org/a", "root"]);
	});

	it("clamps confidence at the floor", () => {
		const impacts: FileImpact[] = Array.from({ length: 10 }, (_, i) => ({
			filePath: `src/f${i}.ts`,
			classification: "unanalyzed" as const,
			impactedSymbols: [],
			propagates: false,
			notes: [`src/f${i}.ts: note`],
		}));
		const radius = assembleBlastRadius(
			"HEAD~1",
			impacts,
			buildImportGraph(makeSymbolGraph({})),
		);
		expect(radius.confidence).toBe(0.3);
	});
});

describe("toFileImpact", () => {
	it("collects removed and shape-changed symbols, excluding body edits", () => {
		const impact = toFileImpact({
			filePath: "src/a.ts",
			classification: "breaking",
			exportedSymbols: {
				added: ["fresh"],
				removed: ["gone"],
				changed: [
					{ name: "resized", kind: "signature" },
					{ name: "retyped", kind: "type" },
					{ name: "tweaked", kind: "body" },
				],
			},
			confidence: 0.85,
			confidenceNotes: ['export * from "./x" hides which names are exported'],
			syntaxErrors: false,
		});

		expect(impact.impactedSymbols).toEqual(["gone", "resized", "retyped"]);
		expect(impact.propagates).toBe(true);
		expect(impact.notes).toEqual([
			'src/a.ts: export * from "./x" hides which names are exported',
		]);
	});

	it("counts an added export-star as impacted, since it can shadow names", () => {
		const impact = toFileImpact({
			filePath: "src/index.ts",
			classification: "breaking",
			exportedSymbols: {
				added: ["* from ./b", "fresh"],
				removed: [],
				changed: [],
			},
			confidence: 0.85,
			confidenceNotes: [],
			syntaxErrors: false,
		});
		expect(impact.impactedSymbols).toEqual(["* from ./b"]);
	});

	it("does not gate a file that does not parse", () => {
		const impact = toFileImpact({
			filePath: "src/a.ts",
			classification: "breaking",
			exportedSymbols: { added: [], removed: [], changed: [] },
			confidence: 0.85,
			confidenceNotes: [],
			syntaxErrors: true,
		});
		expect(impact.ungated).toBe(true);
	});

	it("internal results do not propagate", () => {
		const impact = toFileImpact({
			filePath: "src/a.ts",
			classification: "internal",
			exportedSymbols: {
				added: [],
				removed: [],
				changed: [{ name: "f", kind: "body" }],
			},
			confidence: 1,
			confidenceNotes: [],
			syntaxErrors: false,
		});
		expect(impact.propagates).toBe(false);
		expect(impact.impactedSymbols).toEqual([]);
	});
});
