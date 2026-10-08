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
		scripts: { build: "tsup", typecheck: "tsc", test: "vitest run" },
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

	// A new file, or a file that only gained an export, breaks no importer:
	// nothing could have been using a name that did not exist.
	it("rates a file that only gained exports like a body change, not a breaking one", () => {
		const plan = planFor([changed("packages/math/src/add.ts", "breaking")]);

		expect(plan.changes[0]).toMatchObject({
			risk: "low",
			additive: true,
			reason: "only adds exports, and tests reach it",
		});
	});

	it("still rates a changed export as breaking when the file also gained others", () => {
		const plan = planFor([
			changed("packages/math/src/index.ts", "breaking", ["add"]),
		]);

		expect(plan.changes[0]).toMatchObject({ risk: "high", additive: false });
	});

	it("rates a changed test as a changed test", () => {
		const plan = planFor([
			changed("packages/math/src/add.test.ts", "internal"),
		]);

		expect(plan.changes[0]).toMatchObject({
			risk: "low",
			reason: "a changed test, which the plan runs",
		});
	});

	// The pull request that adopts variant once opened with `.gitignore`
	// above the lockfile and every source file.
	it("leaves repository housekeeping unrated, and out of what is not verified", () => {
		const plan = planFor([
			changed(".gitignore", "unanalyzed"),
			changed(".github/workflows/ci.yml", "unanalyzed"),
			changed("supabase/migrations/1_add.sql", "unanalyzed"),
		]);

		expect(
			plan.changes.map((change) => [change.filePath, change.risk]),
		).toEqual([
			["supabase/migrations/1_add.sql", "high"],
			[".github/workflows/ci.yml", "unrated"],
			[".gitignore", "unrated"],
		]);
		expect(plan.notVerified.map((entry) => entry.filePath)).toEqual([
			"supabase/migrations/1_add.sql",
		]);
	});

	it("groups the selected tests by the runner each one runs under", () => {
		const plan = planFor([changed("packages/math/src/add.ts", "internal")]);

		expect(plan.tests.runs).toEqual([
			{
				runner: "vitest",
				dir: "packages/math",
				files: ["packages/math/src/add.test.ts"],
				command: "pnpm --filter @x/math run test",
			},
			{
				runner: "jest",
				dir: "packages/web",
				files: ["packages/web/src/cart.test.ts"],
			},
		]);
	});

	// pyra: two Playwright specs appeared as "Tests: 2 files", and two
	// integration tests under Vitest with no way to run them.
	it("groups end-to-end specs under Playwright, with the script that runs them", () => {
		const graph = graphOf({
			"apps/web/src/page.ts": [],
			"apps/web/e2e/login.spec.ts": ["../src/page.js"],
			"apps/web/src/page.test.ts": ["./page.js"],
		});
		const radius = assembleBlastRadius(
			"main",
			[changed("apps/web/src/page.ts", "internal")],
			graph,
		);
		const plan = assemblePlan({
			baseRef: "main",
			baseLabel: "main",
			radius,
			tests: computeTestImpact(radius, graph, {
				isTestFile: (file) => /\.(test|spec)\.ts$/.test(file),
			}),
			graph,
			packages: [
				{
					name: "@x/web",
					dir: "apps/web",
					scripts: { test: "vitest run", "test:e2e": "playwright test" },
				},
			],
			runnerRoots: [
				{ dir: "apps/web", runner: "vitest" },
				{ dir: "apps/web", runner: "playwright" },
			],
			style: { packageManager: "pnpm", taskRunner: null },
		});

		expect(plan.tests.runs).toEqual([
			{
				runner: "playwright",
				dir: "apps/web",
				files: ["apps/web/e2e/login.spec.ts"],
				command: "pnpm --filter @x/web run test:e2e",
			},
			{
				runner: "vitest",
				dir: "apps/web",
				files: ["apps/web/src/page.test.ts"],
				command: "pnpm --filter @x/web run test",
			},
		]);
	});

	it("finds the script that runs a package's tests when it is not called test", () => {
		const graph = graphOf({
			"apps/api/src/db.ts": [],
			"apps/api/src/db.integration.test.ts": ["./db.js"],
		});
		const radius = assembleBlastRadius(
			"main",
			[changed("apps/api/src/db.ts", "internal")],
			graph,
		);
		const plan = assemblePlan({
			baseRef: "main",
			baseLabel: "main",
			radius,
			tests: computeTestImpact(radius, graph),
			graph,
			packages: [
				{
					name: "@x/api",
					dir: "apps/api",
					scripts: {
						dev: "tsx watch src",
						"test:integration":
							"vitest run --config vitest.integration.config.ts",
					},
				},
			],
			runnerRoots: [{ dir: "apps/api", runner: "vitest" }],
			style: { packageManager: "pnpm", taskRunner: null },
		});

		expect(plan.tests.runs[0]?.command).toBe(
			"pnpm --filter @x/api run test:integration",
		);
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
