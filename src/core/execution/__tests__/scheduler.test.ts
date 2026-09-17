import { describe, expect, it } from "vitest";
import { TaskGraph } from "../../graph/dag.js";
import { priorityFromConfig, runScheduled } from "../scheduler.js";

function makeGraph(edges: Record<string, string[]>): TaskGraph {
	const g = new TaskGraph();
	for (const [task, deps] of Object.entries(edges)) {
		g.addTask(task);
		for (const dep of deps) g.addDependency(task, dep);
	}
	return g;
}

describe("runScheduled", () => {
	it("runs a single task", async () => {
		const g = makeGraph({ build: [] });
		const ran: string[] = [];
		await runScheduled(
			"build",
			g,
			async (t) => {
				ran.push(t);
			},
			{
				concurrency: 2,
			},
		);
		expect(ran).toEqual(["build"]);
	});

	it("runs tasks in dependency order (A depends on B)", async () => {
		const g = makeGraph({ A: ["B"], B: [] });
		const ran: string[] = [];
		await runScheduled(
			"A",
			g,
			async (t) => {
				ran.push(t);
			},
			{
				concurrency: 4,
			},
		);
		expect(ran.indexOf("B")).toBeLessThan(ran.indexOf("A"));
	});

	it("respects concurrency ceiling", async () => {
		const g = makeGraph({
			root: ["a", "b", "c", "d", "e"],
			a: [],
			b: [],
			c: [],
			d: [],
			e: [],
		});
		let peak = 0;
		let inFlight = 0;
		await runScheduled(
			"root",
			g,
			async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 10));
				inFlight--;
			},
			{ concurrency: 2 },
		);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it("priorityOf: lower priority runs first", async () => {
		const g = makeGraph({
			root: ["a", "b", "c"],
			a: [],
			b: [],
			c: [],
		});
		const ran: string[] = [];
		await runScheduled(
			"root",
			g,
			async (t) => {
				ran.push(t);
			},
			{
				concurrency: 1,
				priorityOf: (t) => (t === "c" ? 0 : t === "a" ? 1 : 2),
			},
		);
		// With concurrency 1, tasks are serial in priority order
		expect(ran.indexOf("c")).toBeLessThan(ran.indexOf("a"));
		expect(ran.indexOf("a")).toBeLessThan(ran.indexOf("b"));
	});

	it("propagates first error and stops scheduling new tasks", async () => {
		const g = makeGraph({
			root: ["a", "b", "c"],
			a: [],
			b: [],
			c: [],
		});
		const ran: string[] = [];
		await expect(
			runScheduled(
				"root",
				g,
				async (t) => {
					ran.push(t);
					if (t === "a") throw new Error("fail-a");
					await new Promise((r) => setTimeout(r, 50));
				},
				{ concurrency: 1, priorityOf: () => 0 },
			),
		).rejects.toThrow("fail-a");
	});

	it("diamond DAG: all paths complete before target runs", async () => {
		const g = makeGraph({
			root: ["left", "right"],
			left: ["base"],
			right: ["base"],
			base: [],
		});
		const ran: string[] = [];
		await runScheduled(
			"root",
			g,
			async (t) => {
				ran.push(t);
			},
			{
				concurrency: 4,
			},
		);
		expect(ran.indexOf("base")).toBeLessThan(ran.indexOf("left"));
		expect(ran.indexOf("base")).toBeLessThan(ran.indexOf("right"));
		expect(ran.indexOf("left")).toBeLessThan(ran.indexOf("root"));
		expect(ran.indexOf("right")).toBeLessThan(ran.indexOf("root"));
	});

	it("wide fan-in: all leaves run before root", async () => {
		const leaves = Array.from({ length: 20 }, (_, i) => `leaf-${i}`);
		const edges: Record<string, string[]> = { root: leaves };
		for (const l of leaves) edges[l] = [];
		const g = makeGraph(edges);
		const ran: string[] = [];
		await runScheduled(
			"root",
			g,
			async (t) => {
				ran.push(t);
			},
			{
				concurrency: 8,
			},
		);
		const rootIdx = ran.indexOf("root");
		for (const l of leaves) {
			expect(ran.indexOf(l)).toBeLessThan(rootIdx);
		}
	});

	it("in-flight tasks complete even after error before rejection", async () => {
		const g = makeGraph({ root: ["a", "b"], a: [], b: [] });
		const completed: string[] = [];
		await expect(
			runScheduled(
				"root",
				g,
				async (t) => {
					if (t === "a") throw new Error("boom");
					await new Promise((r) => setTimeout(r, 30));
					completed.push(t);
				},
				{ concurrency: 4 },
			),
		).rejects.toThrow("boom");
		// b was already in-flight and should have completed
		expect(completed).toContain("b");
	});
});

describe("priorityFromConfig", () => {
	const tasks = {
		"pkg:build": { cpuHeavy: true },
		"pkg:lint": { cpuHeavy: false },
		"pkg:test": {},
	};

	function makeConfig(
		policy?: "auto" | "light-first" | "pack-heavy" | "critical-path",
	) {
		return {
			strategy: "adaptive" as const,
			cache: { mode: "content" as const, directory: ".variant/cache" },
			tasks,
			...(policy !== undefined ? { scheduler: { policy } } : {}),
		};
	}

	it("returns undefined for auto policy", () => {
		expect(priorityFromConfig(makeConfig("auto"), tasks)).toBeUndefined();
	});

	it("returns undefined when no scheduler policy is set", () => {
		expect(priorityFromConfig(makeConfig(), tasks)).toBeUndefined();
	});

	it("returns undefined for critical-path policy (deferred to Phase 4)", () => {
		expect(
			priorityFromConfig(makeConfig("critical-path"), tasks),
		).toBeUndefined();
	});

	it("light-first: cpuHeavy tasks get higher priority number (run later)", () => {
		const fn = priorityFromConfig(makeConfig("light-first"), tasks);
		expect(fn).toBeDefined();
		if (fn === undefined) return;
		expect(fn("pkg:build")).toBeGreaterThan(fn("pkg:lint"));
		expect(fn("pkg:lint")).toBe(0);
		expect(fn("pkg:build")).toBe(1);
	});

	it("light-first: unknown task (no cpuHeavy flag) treated as non-heavy", () => {
		const fn = priorityFromConfig(makeConfig("light-first"), tasks);
		expect(fn).toBeDefined();
		if (fn === undefined) return;
		expect(fn("pkg:test")).toBe(0);
	});

	it("pack-heavy: cpuHeavy tasks get lower priority number (run sooner)", () => {
		const fn = priorityFromConfig(makeConfig("pack-heavy"), tasks);
		expect(fn).toBeDefined();
		if (fn === undefined) return;
		expect(fn("pkg:build")).toBeLessThan(fn("pkg:lint"));
		expect(fn("pkg:build")).toBe(0);
		expect(fn("pkg:lint")).toBe(1);
	});

	it("pack-heavy: unknown task treated as non-heavy", () => {
		const fn = priorityFromConfig(makeConfig("pack-heavy"), tasks);
		expect(fn).toBeDefined();
		if (fn === undefined) return;
		expect(fn("pkg:test")).toBe(1);
	});

	it("light-first ordering is respected end-to-end by runScheduled", async () => {
		const g = makeGraph({ root: ["heavy", "light"], heavy: [], light: [] });
		const localTasks = {
			heavy: { cpuHeavy: true },
			light: { cpuHeavy: false },
		};
		const fn = priorityFromConfig(makeConfig("light-first"), localTasks);
		expect(fn).toBeDefined();
		if (fn === undefined) return;
		const ran: string[] = [];
		await runScheduled(
			"root",
			g,
			async (t) => {
				ran.push(t);
			},
			{ concurrency: 1, priorityOf: fn },
		);
		expect(ran.indexOf("light")).toBeLessThan(ran.indexOf("heavy"));
	});

	it("pack-heavy ordering is respected end-to-end by runScheduled", async () => {
		const g = makeGraph({ root: ["heavy", "light"], heavy: [], light: [] });
		const localTasks = {
			heavy: { cpuHeavy: true },
			light: { cpuHeavy: false },
		};
		const fn = priorityFromConfig(makeConfig("pack-heavy"), localTasks);
		expect(fn).toBeDefined();
		if (fn === undefined) return;
		const ran: string[] = [];
		await runScheduled(
			"root",
			g,
			async (t) => {
				ran.push(t);
			},
			{ concurrency: 1, priorityOf: fn },
		);
		expect(ran.indexOf("heavy")).toBeLessThan(ran.indexOf("light"));
	});
});
