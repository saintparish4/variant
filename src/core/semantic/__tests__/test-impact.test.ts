import { describe, expect, it } from "vitest";
import { buildImportGraph } from "../../graph/import-graph.js";
import type { FileImpact } from "../blast-radius.js";
import type { ImportEntry, SymbolGraph } from "../symbol-graph.js";
import {
	buildCoverageMap,
	buildTestTrace,
	computeTestImpact,
	defaultIsTestFile,
} from "../test-impact.js";

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

function unanalyzed(filePath: string): FileImpact {
	return {
		filePath,
		classification: "unanalyzed",
		impactedSymbols: [],
		propagates: false,
		notes: [],
	};
}

const GRAPH = buildImportGraph(
	makeSymbolGraph({
		"src/auth.ts": [],
		"src/app.ts": [namedImport("./auth.js", ["login"])],
		"src/other.ts": [],
		"src/__tests__/auth.test.ts": [namedImport("../auth.js", ["login"])],
		"src/__tests__/app.test.ts": [namedImport("../app.js", ["boot"])],
		"src/__tests__/other.test.ts": [namedImport("../other.js", ["other"])],
	}),
);

describe("defaultIsTestFile", () => {
	it("matches __tests__ dirs and .test/.spec suffixes", () => {
		expect(defaultIsTestFile("src/__tests__/x.ts")).toBe(true);
		expect(defaultIsTestFile("src/x.test.ts")).toBe(true);
		expect(defaultIsTestFile("src/x.spec.tsx")).toBe(true);
		expect(defaultIsTestFile("src/x.ts")).toBe(false);
		expect(defaultIsTestFile("src/latest.ts")).toBe(false);
	});
});

describe("buildTestTrace / buildCoverageMap", () => {
	it("closures include the test itself and its transitive imports", () => {
		const trace = buildTestTrace(GRAPH);
		expect([...trace.closures.keys()].sort()).toEqual([
			"src/__tests__/app.test.ts",
			"src/__tests__/auth.test.ts",
			"src/__tests__/other.test.ts",
		]);
		expect(
			[...(trace.closures.get("src/__tests__/app.test.ts") ?? [])].sort(),
		).toEqual(["src/__tests__/app.test.ts", "src/app.ts", "src/auth.ts"]);
	});

	it("coverage map inverts closures", () => {
		const coverage = buildCoverageMap(buildTestTrace(GRAPH));
		expect([...(coverage.testsFor.get("src/auth.ts") ?? [])].sort()).toEqual([
			"src/__tests__/app.test.ts",
			"src/__tests__/auth.test.ts",
		]);
		expect([...(coverage.testsFor.get("src/other.ts") ?? [])].sort()).toEqual([
			"src/__tests__/other.test.ts",
		]);
	});
});

describe("computeTestImpact", () => {
	it("selects tests whose closure intersects the affected set", () => {
		const impact = computeTestImpact(
			{ changed: [], affectedFiles: ["src/auth.ts"], confidence: 1 },
			GRAPH,
		);
		expect(impact.affectedTests).toEqual([
			"src/__tests__/app.test.ts",
			"src/__tests__/auth.test.ts",
		]);
		expect(impact.totalTests).toBe(3);
		expect(impact.selectAll).toBe(false);
		expect(impact.confidence).toBe(1);
	});

	it("a changed test file selects itself", () => {
		const impact = computeTestImpact(
			{
				changed: [],
				affectedFiles: ["src/__tests__/other.test.ts"],
				confidence: 1,
			},
			GRAPH,
		);
		expect(impact.affectedTests).toEqual(["src/__tests__/other.test.ts"]);
	});

	it("an empty affected set selects no tests", () => {
		const impact = computeTestImpact(
			{ changed: [], affectedFiles: [], confidence: 1 },
			GRAPH,
		);
		expect(impact.affectedTests).toEqual([]);
	});

	it("configuration changes trigger select-all", () => {
		const impact = computeTestImpact(
			{
				changed: [unanalyzed("package.json")],
				affectedFiles: ["package.json"],
				confidence: 0.9,
			},
			GRAPH,
		);
		expect(impact.selectAll).toBe(true);
		expect(impact.affectedTests).toHaveLength(3);
		expect(impact.notes.some((n) => n.includes("running all tests"))).toBe(
			true,
		);
	});

	it.each([
		"vitest.workspace.ts",
		"vitest.projects.mjs",
		"babel.config.js",
		"packages/web/babel.config.cjs",
		".babelrc",
		".babelrc.json",
		// What the installed dependencies are, or how they are laid out, with
		// no edit to a package.json. `../` is a lockfile at the repository root
		// seen from a package below it.
		"bun.lock",
		"bun.lockb",
		"web/bun.lock",
		"../bun.lock",
		"bunfig.toml",
		"npm-shrinkwrap.json",
		"pnpm-workspace.yaml",
		"next.config.mjs",
		"apps/web/next.config.js",
	])("%s triggers select-all", (file) => {
		const impact = computeTestImpact(
			{ changed: [unanalyzed(file)], affectedFiles: [file], confidence: 1 },
			GRAPH,
		);
		expect(impact.selectAll).toBe(true);
	});

	it("vitest config changes also trigger select-all", () => {
		const impact = computeTestImpact(
			{
				changed: [unanalyzed("vitest.config.mts")],
				affectedFiles: ["vitest.config.mts"],
				confidence: 1,
			},
			GRAPH,
		);
		expect(impact.selectAll).toBe(true);
	});

	it.each([
		["a TypeScript runner config", "vitest.config.ts", "breaking"],
		["a Jest config", "packages/web/jest.config.ts", "internal"],
		// `next/jest` loads it to configure the transform every test is
		// compiled with, and no test imports it.
		["a Next.js config", "web/next.config.ts", "internal"],
		["a Vitest setup file", "vitest.setup.ts", "internal"],
		["a Jest setup file", "jest.setup.js", "internal"],
		["a setupTests file", "src/setupTests.ts", "internal"],
		["a test/setup file", "packages/web/test/setup.ts", "internal"],
		["a global setup file", "e2e/global-setup.ts", "internal"],
	] as const)("%s selects all even when it classifies as code", (_, filePath, classification) => {
		const impact = computeTestImpact(
			{
				changed: [{ ...unanalyzed(filePath), classification }],
				affectedFiles: [filePath],
				confidence: 1,
			},
			GRAPH,
		);
		expect(impact.selectAll).toBe(true);
		expect(impact.affectedTests).toHaveLength(3);
	});

	it("a source file named setup does not select-all", () => {
		const impact = computeTestImpact(
			{
				changed: [
					{ ...unanalyzed("src/setup.ts"), classification: "internal" },
				],
				affectedFiles: ["src/setup.ts"],
				confidence: 1,
			},
			GRAPH,
		);
		expect(impact.selectAll).toBe(false);
	});

	it("non-config unanalyzed changes do not select-all", () => {
		const impact = computeTestImpact(
			{
				changed: [unanalyzed("docs/README.md")],
				affectedFiles: ["docs/README.md"],
				confidence: 0.9,
			},
			GRAPH,
		);
		expect(impact.selectAll).toBe(false);
		expect(impact.affectedTests).toEqual([]);
	});

	it("lists changed non-TypeScript files that reach no test", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/button.ts": [namedImport("./button.css", [])],
				"src/__tests__/button.test.ts": [
					namedImport("../button.js", ["Button"]),
				],
			}),
		);
		const impact = computeTestImpact(
			{
				changed: [unanalyzed("src/button.css"), unanalyzed("src/orphan.css")],
				affectedFiles: ["src/button.css", "src/button.ts", "src/orphan.css"],
				confidence: 1,
			},
			graph,
		);
		expect(impact.affectedTests).toEqual(["src/__tests__/button.test.ts"]);
		expect(impact.unreached).toEqual(["src/orphan.css"]);
	});

	it("does not report prose as unreached", () => {
		const impact = computeTestImpact(
			{
				changed: [unanalyzed("CHANGELOG.md"), unanalyzed("docs/guide.md")],
				affectedFiles: ["CHANGELOG.md", "docs/guide.md"],
				confidence: 1,
			},
			GRAPH,
		);
		expect(impact.unreached).toEqual([]);
	});

	it("a select-all trigger is never unreached", () => {
		const impact = computeTestImpact(
			{
				changed: [unanalyzed("package.json")],
				affectedFiles: ["package.json"],
				confidence: 1,
			},
			GRAPH,
		);
		expect(impact.unreached).toEqual([]);
	});

	it("unresolved imports in a selected closure lower confidence with one note", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/auth.ts": [namedImport("./fixture.json", [])],
				"src/__tests__/auth.test.ts": [namedImport("../auth.js", ["login"])],
			}),
		);
		const impact = computeTestImpact(
			{ changed: [], affectedFiles: ["src/auth.ts"], confidence: 1 },
			graph,
		);
		expect(impact.affectedTests).toEqual(["src/__tests__/auth.test.ts"]);
		expect(impact.notes).toEqual([
			"1 selected test file(s) have unresolved imports in their closure — fixtures or assets may be missed",
		]);
		expect(impact.confidence).toBe(0.9);
	});

	it("reports a resolution bucket beside the confidence score", () => {
		const high = computeTestImpact(
			{ changed: [], affectedFiles: [], confidence: 1 },
			GRAPH,
		);
		const low = computeTestImpact(
			{ changed: [], affectedFiles: [], confidence: 0.5 },
			GRAPH,
		);
		expect(high.resolution).toBe("high");
		expect(low.resolution).toBe("low");
	});

	it("honors a custom isTestFile predicate", () => {
		const graph = buildImportGraph(
			makeSymbolGraph({
				"src/a.ts": [],
				"checks/a.check.ts": [namedImport("../src/a.js", ["a"])],
			}),
		);
		const impact = computeTestImpact(
			{ changed: [], affectedFiles: ["src/a.ts"], confidence: 1 },
			graph,
			{ isTestFile: (f) => f.endsWith(".check.ts") },
		);
		expect(impact.affectedTests).toEqual(["checks/a.check.ts"]);
		expect(impact.totalTests).toBe(1);
	});
});
