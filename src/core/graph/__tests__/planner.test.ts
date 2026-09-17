import { describe, expect, it } from "vitest";
import type { ResolvedVariantConfig } from "../../../types/index.js";
import { CycleError } from "../../errors.js";
import { buildGraph } from "../planner.js";

function makeConfig(
	tasks: ResolvedVariantConfig["tasks"],
): ResolvedVariantConfig {
	return {
		strategy: "adaptive",
		cache: { mode: "content", directory: ".variant/cache" },
		tasks,
	};
}

describe("buildGraph", () => {
	it("returns an empty graph when config has no tasks", () => {
		const g = buildGraph(makeConfig({}));
		// An empty graph cannot produce levels for any task
		expect(() => g.toLevels("build")).toThrow();
	});

	it("creates a single task with no dependencies", () => {
		const g = buildGraph(makeConfig({ build: {} }));
		expect(g.toLevels("build")).toEqual([["build"]]);
	});

	it("creates tasks and respects dependsOn", () => {
		const g = buildGraph(
			makeConfig({
				lint: {},
				build: { dependsOn: ["lint"] },
			}),
		);
		const levels = g.toLevels("build");
		expect(levels[0]).toEqual(["lint"]);
		expect(levels[1]).toEqual(["build"]);
	});

	it("handles tasks with no dependsOn field (undefined) without throwing", () => {
		// TaskConfig.dependsOn is optional; the optional-chaining in planner
		// must protect against undefined.
		const g = buildGraph(makeConfig({ build: { command: "echo hi" } }));
		expect(() => g.toLevels("build")).not.toThrow();
	});

	it("handles tasks with an empty dependsOn array", () => {
		const g = buildGraph(makeConfig({ build: { dependsOn: [] } }));
		expect(g.toLevels("build")).toEqual([["build"]]);
	});

	it("resolves a multi-level chain correctly", () => {
		const g = buildGraph(
			makeConfig({
				typecheck: {},
				lint: {},
				build: { dependsOn: ["typecheck", "lint"] },
				test: { dependsOn: ["build"] },
			}),
		);
		const levels = g.toLevels("test");
		// typecheck and lint should be at level 0 (no deps)
		expect(levels[0]?.sort()).toEqual(["lint", "typecheck"]);
		expect(levels[1]).toEqual(["build"]);
		expect(levels[2]).toEqual(["test"]);
	});

	it("detects a cycle declared through config tasks", () => {
		const g = buildGraph(
			makeConfig({
				A: { dependsOn: ["B"] },
				B: { dependsOn: ["A"] },
			}),
		);
		expect(() => g.toLevels("A")).toThrow(CycleError);
	});

	it("implicitly creates a node when dependsOn references a task not in config", () => {
		// A task may declare dependsOn on a name not present in config.tasks.
		// buildGraph calls addDependency which implicitly creates the node.
		// The implicit node has no command — running it will execute
		// `<pm> run <taskname>` (the default), which may fail if the script
		// doesn't exist. This test documents the current behavior.
		const g = buildGraph(
			makeConfig({
				build: { dependsOn: ["undeclared-dep"] },
			}),
		);
		const levels = g.toLevels("build");
		// "undeclared-dep" is created as an implicit leaf
		expect(levels[0]).toEqual(["undeclared-dep"]);
		expect(levels[1]).toEqual(["build"]);
	});

	it("getDependencies returns the direct deps declared in config", () => {
		const g = buildGraph(
			makeConfig({
				lint: {},
				build: { dependsOn: ["lint"] },
				test: { dependsOn: ["build"] },
			}),
		);
		// build depends directly on lint only, not test
		expect([...g.getDependencies("build")]).toEqual(["lint"]);
		expect([...g.getDependencies("test")]).toEqual(["build"]);
		expect([...g.getDependencies("lint")]).toEqual([]);
	});
});
