import { describe, expect, it } from "vitest";
import { buildImportGraph } from "../../graph/import-graph.js";
import type { FileImpact } from "../../semantic/blast-radius.js";
import { assembleBlastRadius } from "../../semantic/blast-radius.js";
import type { ImportEntry, SymbolGraph } from "../../semantic/symbol-graph.js";
import { computeTestImpact } from "../../semantic/test-impact.js";
import type { PlanInputs, VerificationPlan } from "../plan.js";
import { assemblePlan } from "../plan.js";

function graphOf(files: Record<string, string[]>, packageDirs = {}) {
	const out: SymbolGraph["files"] = {};
	for (const [file, modules] of Object.entries(files)) {
		const imports: ImportEntry[] = modules.map((module) => ({
			module,
			kind: "static",
			typeOnly: false,
			names: ["add"],
		}));
		out[file] = { contentHash: "", symbols: [], imports, notes: [] };
	}
	return buildImportGraph(
		{ version: 1, generatedAt: "", files: out },
		{ packageDirs },
	);
}

function changed(
	filePath: string,
	classification: FileImpact["classification"],
	impactedSymbols: string[] = [],
): FileImpact {
	return {
		filePath,
		classification,
		impactedSymbols,
		propagates: classification === "breaking",
		notes: [],
	};
}

const PACKAGES = [
	{ name: "root", dir: "", scripts: { lint: "biome check ." } },
	{
		name: "@x/math",
		dir: "packages/math",
		scripts: { build: "tsup", typecheck: "tsc" },
	},
	{
		name: "@x/web",
		dir: "packages/web",
		scripts: { build: "next build", typecheck: "tsc" },
	},
];

const GRAPH = graphOf(
	{
		"packages/math/src/add.ts": [],
		"packages/math/src/add.test.ts": ["./add.js"],
		"packages/math/src/unused.ts": [],
		"packages/web/src/cart.ts": ["@x/math"],
		"packages/web/src/cart.test.ts": ["./cart.js"],
		"packages/web/src/page.ts": [],
		"packages/math/src/index.ts": ["./add.js"],
	},
	{ "@x/math": "packages/math" },
);

function planFor(
	changes: FileImpact[],
	overrides: Partial<PlanInputs> = {},
): VerificationPlan {
	const packageRoots = PACKAGES.map((pkg) => pkg.dir);
	const radius = assembleBlastRadius("main", changes, GRAPH, { packageRoots });
	return assemblePlan({
		baseRef: "main",
		baseLabel: "main",
		radius,
		tests: computeTestImpact(radius, GRAPH, { packageRoots }),
		graph: GRAPH,
		packages: PACKAGES,
		runnerRoots: [
			{ dir: "packages/math", runner: "vitest" },
			{ dir: "packages/web", runner: "jest" },
		],
		style: { packageManager: "pnpm", taskRunner: null },
		...overrides,
	});
}

describe("the verification plan", () => {
	it("rates a body-only change that tests reach as low", () => {
		const plan = planFor([changed("packages/math/src/add.ts", "internal")]);

		expect(plan.changes).toMatchObject([
			{ filePath: "packages/math/src/add.ts", risk: "low", tests: 2 },
		]);
	});

	it("rates a changed export that another package imports as high", () => {
		const plan = planFor([
			changed("packages/math/src/add.ts", "breaking", ["add"]),
		]);

		expect(plan.changes[0]).toMatchObject({
			risk: "high",
			symbols: ["add"],
			crossesInto: ["@x/web"],
		});
	});

	it("rates a changed file no test reaches as high, and lists it as not verified", () => {
		const plan = planFor([changed("packages/math/src/unused.ts", "internal")]);

		expect(plan.changes[0]).toMatchObject({
			risk: "high",
			reason: "no test reaches it",
		});
		expect(plan.notVerified.map((entry) => entry.filePath)).toEqual([
			"packages/math/src/unused.ts",
		]);
	});

	it("rates comments and documentation as no risk, and never as not verified", () => {
		const plan = planFor([
			changed("packages/math/src/unused.ts", "non-impacting"),
			changed("README.md", "unanalyzed"),
		]);

		expect(plan.changes.map((change) => change.risk)).toEqual(["none", "none"]);
		expect(plan.notVerified).toEqual([]);
	});

	it("groups the selected tests by the runner each one runs under", () => {
		const plan = planFor([changed("packages/math/src/add.ts", "internal")]);

		expect(plan.tests.runs).toEqual([
			{
				runner: "vitest",
				dir: "packages/math",
				files: ["packages/math/src/add.test.ts"],
			},
			{
				runner: "jest",
				dir: "packages/web",
				files: ["packages/web/src/cart.test.ts"],
			},
		]);
	});

	it("says why each test is in the plan, as an import chain", () => {
		const plan = planFor([changed("packages/math/src/add.ts", "internal")]);

		expect(plan.tests.why["packages/web/src/cart.test.ts"]).toEqual([
			"packages/web/src/cart.test.ts",
			"packages/web/src/cart.ts",
			"packages/math/src/index.ts",
			"packages/math/src/add.ts",
		]);
	});

	it("plans the checks of the packages the change affects, and only those", () => {
		const internal = planFor([changed("packages/math/src/add.ts", "internal")]);
		const breaking = planFor([
			changed("packages/math/src/add.ts", "breaking", ["add"]),
		]);

		expect(internal.checks.map((check) => check.command)).toEqual([
			"pnpm --filter @x/math run typecheck",
			"pnpm --filter @x/math run build",
		]);
		expect(breaking.checks.map((check) => check.package)).toEqual([
			"@x/math",
			"@x/web",
			"@x/math",
			"@x/web",
		]);
	});

	it("plans every test and every package's checks when configuration changes, and says why", () => {
		const plan = planFor([changed("pnpm-lock.yaml", "unanalyzed")]);

		expect(plan.tests.all).toBe(true);
		expect(plan.checks).toHaveLength(5);
		expect(plan.widened).toEqual([
			expect.stringContaining("pnpm-lock.yaml changed: every test"),
		]);
		expect(plan.changes[0]?.risk).toBe("medium");
	});

	it("still names a file no test reaches when every test is selected", () => {
		const plan = planFor([
			changed("pnpm-lock.yaml", "unanalyzed"),
			changed("packages/web/src/page.ts", "internal"),
		]);

		expect(plan.notVerified.map((entry) => entry.filePath)).toEqual([
			"packages/web/src/page.ts",
		]);
	});

	it("names who imports a file that is not verified", () => {
		const graph = graphOf({
			"src/a.ts": [],
			"src/b.ts": ["./a.js"],
		});
		const radius = assembleBlastRadius(
			"main",
			[changed("src/a.ts", "breaking", ["add"])],
			graph,
		);
		const plan = assemblePlan({
			baseRef: "main",
			baseLabel: "main",
			radius,
			tests: computeTestImpact(radius, graph),
			graph,
			packages: [],
			runnerRoots: [],
			style: { packageManager: null, taskRunner: null },
		});

		expect(plan.notVerified).toMatchObject([
			{ filePath: "src/a.ts", symbols: ["add"], usedBy: ["src/b.ts"] },
		]);
	});
});
