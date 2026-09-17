import { describe, expect, it } from "vitest";
import type { ResolvedVariantConfig, TaskGraph } from "../../../types/index.js";
import { ConfigError, CycleError } from "../../errors.js";
import { buildGraph } from "../planner.js";
import { validateTaskGraph } from "../validation.js";

type Tasks = ResolvedVariantConfig["tasks"];

function graphFor(tasks: Tasks): TaskGraph {
	return buildGraph({
		strategy: "adaptive",
		cache: { mode: "content", directory: ".variant/cache" },
		tasks,
	});
}

describe("validateTaskGraph", () => {
	it("accepts a graph whose dependencies all resolve", () => {
		const tasks: Tasks = {
			lint: {},
			build: { dependsOn: ["lint"] },
		};

		expect(() => validateTaskGraph(tasks, graphFor(tasks))).not.toThrow();
	});

	it("accepts tasks with no dependencies at all", () => {
		const tasks: Tasks = { build: {}, lint: {} };

		expect(() => validateTaskGraph(tasks, graphFor(tasks))).not.toThrow();
	});

	it("rejects a dependsOn entry naming an unknown task", () => {
		const tasks: Tasks = {
			build: { dependsOn: ["ghost"] },
		};

		expect(() => validateTaskGraph(tasks, graphFor(tasks))).toThrow(
			ConfigError,
		);
	});

	it("names both the task and its missing dependency", () => {
		const tasks: Tasks = {
			build: { dependsOn: ["ghost"] },
		};

		expect(() => validateTaskGraph(tasks, graphFor(tasks))).toThrow(
			/"build".*"ghost"/,
		);
	});

	it("rejects a cycle even when it sits outside the default target", () => {
		const tasks: Tasks = {
			build: {},
			a: { dependsOn: ["b"] },
			b: { dependsOn: ["a"] },
		};

		expect(() => validateTaskGraph(tasks, graphFor(tasks))).toThrow(CycleError);
	});
});
