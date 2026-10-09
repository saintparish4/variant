import { describe, expect, it } from "vitest";
import type { ImportEntry, SymbolGraph } from "../../semantic/symbol-graph.js";
import { buildImportGraph } from "../import-graph.js";
import { pathsToward } from "../import-paths.js";

function graphOf(files: Record<string, string[]>) {
	const out: SymbolGraph["files"] = {};
	for (const [file, modules] of Object.entries(files)) {
		const imports: ImportEntry[] = modules.map((module) => ({
			module,
			kind: "static",
			typeOnly: false,
			names: ["x"],
		}));
		out[file] = { contentHash: "", symbols: [], imports, notes: [] };
	}
	return buildImportGraph({ version: 1, generatedAt: "", files: out });
}

const GRAPH = graphOf({
	"src/core.ts": [],
	"src/mid.ts": ["./core.js"],
	"src/app.ts": ["./mid.js", "./theme.css"],
	"src/app.test.ts": ["./app.js"],
	"src/core.test.ts": ["./core.js"],
	"src/alone.test.ts": [],
});

describe("pathsToward", () => {
	it("gives the import chain from a test to the changed file", () => {
		const chain = pathsToward(GRAPH, ["src/core.ts"]);

		expect(chain("src/app.test.ts")).toEqual([
			"src/app.test.ts",
			"src/app.ts",
			"src/mid.ts",
			"src/core.ts",
		]);
		expect(chain("src/core.test.ts")).toEqual([
			"src/core.test.ts",
			"src/core.ts",
		]);
	});

	it("ends at the nearest changed file when several are reachable", () => {
		const chain = pathsToward(GRAPH, ["src/core.ts", "src/app.ts"]);

		expect(chain("src/app.test.ts")).toEqual(["src/app.test.ts", "src/app.ts"]);
	});

	it("is one file long for a file that is itself changed", () => {
		expect(
			pathsToward(GRAPH, ["src/alone.test.ts"])("src/alone.test.ts"),
		).toEqual(["src/alone.test.ts"]);
	});

	it("has no chain for a file that reaches nothing changed", () => {
		expect(pathsToward(GRAPH, ["src/core.ts"])("src/alone.test.ts")).toBeNull();
	});

	it("reaches a file the index does not cover through the import naming it", () => {
		const chain = pathsToward(GRAPH, ["src/theme.css"]);

		expect(chain("src/app.test.ts")).toEqual([
			"src/app.test.ts",
			"src/app.ts",
			"src/theme.css",
		]);
	});
});
