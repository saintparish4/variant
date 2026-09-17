import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ResolvedVariantConfig,
	TaskProvenance,
} from "../../../types/index.js";
import { hashTaskInputs } from "../../cache/hashing.js";
import { readCache, writeCache } from "../../cache/store.js";
import { TaskExecutionError } from "../../errors.js";
import { TaskGraph } from "../../graph/dag.js";
import { PluginRegistry } from "../../plugins/registry.js";
import type { TaskExecutor } from "../executor.js";
import type { TaskRunResult } from "../runner.js";
import { runTasksWithDeps } from "../runner.js";

function makeTempDir(): string {
	return mkdtempSync(path.join(tmpdir(), "variant-runner-test-"));
}

function makeConfig(
	strategy: "adaptive" | "strict" = "adaptive",
): ResolvedVariantConfig {
	return {
		strategy,
		cache: { mode: "content", directory: ".variant/cache" },
		tasks: {},
	};
}

function makeGraph(tasks: Array<{ name: string; deps?: string[] }>): TaskGraph {
	const graph = new TaskGraph();
	for (const { name, deps } of tasks) {
		graph.addTask(name);
		for (const dep of deps ?? []) {
			graph.addDependency(name, dep);
		}
	}
	return graph;
}

function emptyPlugins(): PluginRegistry {
	return new PluginRegistry();
}

describe("runTasksWithDeps", () => {
	let cwd: string;
	let cacheDir: string;

	beforeEach(() => {
		cwd = makeTempDir();
		cacheDir = path.join(makeTempDir(), ".variant/cache");
	});

	// ── 1. Cache hit ─────────────────────────────────────────────────────────
	it("skips execution on cache hit", async () => {
		// Create a real file so hashTaskInputs can hash it
		writeFileSync(path.join(cwd, "main.ts"), "export const x = 1;");

		const patterns = ["main.ts"];
		const hash = await hashTaskInputs(cwd, patterns);

		// Pre-populate cache with the current hash
		mkdirSync(cacheDir, { recursive: true });
		await writeCache(cacheDir, {
			tasks: { build: { hash, lastRun: Date.now() } },
		});

		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: { build: { inputs: patterns } },
		};
		const graph = makeGraph([{ name: "build" }]);
		const executor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const results: TaskRunResult[] = await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
			},
			executor,
		);

		expect(executor).not.toHaveBeenCalled();
		expect(results).toHaveLength(1);
		expect(results[0]?.cacheHit).toBe(true);
		expect(results[0]?.durationMs).toBe(0);
	});

	// ── 2. Cache miss ────────────────────────────────────────────────────────
	it("executes on cache miss (stale hash)", async () => {
		writeFileSync(path.join(cwd, "main.ts"), "export const x = 1;");

		mkdirSync(cacheDir, { recursive: true });
		await writeCache(cacheDir, {
			tasks: { build: { hash: "stale-hash", lastRun: Date.now() } },
		});

		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: { build: { inputs: ["main.ts"] } },
		};
		const graph = makeGraph([{ name: "build" }]);
		const executor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const results: TaskRunResult[] = await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
			},
			executor,
		);

		expect(executor).toHaveBeenCalledOnce();
		expect(results[0]?.cacheHit).toBe(false);
	});

	// ── 3. Parallel levels ───────────────────────────────────────────────────
	it("runs tasks in the same level concurrently", async () => {
		// lint and test are independent (same level), build depends on both
		const callOrder: string[] = [];
		const executor = vi
			.fn<(name: string) => Promise<void>>()
			.mockImplementation(async (name: string) => {
				callOrder.push(`start:${name}`);
				await new Promise<void>((res) => setTimeout(res, 10));
				callOrder.push(`end:${name}`);
			});

		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: {
				lint: {},
				test: {},
				build: { dependsOn: ["lint", "test"] },
			},
		};
		const graph = makeGraph([
			{ name: "lint" },
			{ name: "test" },
			{ name: "build", deps: ["lint", "test"] },
		]);

		const results: TaskRunResult[] = await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
			},
			executor as TaskExecutor,
		);

		// Both lint and test should have started before either finishes
		const lintStart = callOrder.indexOf("start:lint");
		const testStart = callOrder.indexOf("start:test");
		const lintEnd = callOrder.indexOf("end:lint");
		const testEnd = callOrder.indexOf("end:test");

		expect(lintStart).not.toBe(-1);
		expect(testStart).not.toBe(-1);
		// In concurrent execution, both start before the first end
		expect(Math.min(lintEnd, testEnd)).toBeGreaterThan(
			Math.max(lintStart, testStart),
		);
		expect(results).toHaveLength(3);
	});

	// ── 4. Task failure ──────────────────────────────────────────────────────
	it("propagates TaskExecutionError on task failure", async () => {
		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: { build: {} },
		};
		const graph = makeGraph([{ name: "build" }]);
		const executor = vi
			.fn<() => Promise<void>>()
			.mockRejectedValue(new TaskExecutionError("build", 1));

		await expect(
			runTasksWithDeps(
				"build",
				graph,
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
				},
				executor,
			),
		).rejects.toBeInstanceOf(TaskExecutionError);
	});

	// ── 5. Strict mode ───────────────────────────────────────────────────────
	it("always executes in strict mode, ignoring cache", async () => {
		writeFileSync(path.join(cwd, "main.ts"), "export const x = 1;");

		const patterns = ["main.ts"];
		const hash = await hashTaskInputs(cwd, patterns);

		mkdirSync(cacheDir, { recursive: true });
		await writeCache(cacheDir, {
			tasks: { build: { hash, lastRun: Date.now() } },
		});

		const config: ResolvedVariantConfig = {
			...makeConfig("strict"),
			tasks: { build: { inputs: patterns } },
		};
		const graph = makeGraph([{ name: "build" }]);
		const executor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const results: TaskRunResult[] = await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
			},
			executor,
		);

		expect(executor).toHaveBeenCalledOnce();
		expect(results[0]?.cacheHit).toBe(false);
	});

	// ── 6. Strict mode records cache ─────────────────────────────────────────
	it("records lastRun/lastDurationMs in strict mode (no hash)", async () => {
		mkdirSync(cacheDir, { recursive: true });

		const config: ResolvedVariantConfig = {
			...makeConfig("strict"),
			tasks: { build: {} },
		};
		const graph = makeGraph([{ name: "build" }]);
		const executor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
			},
			executor,
		);

		const cache = await readCache(cacheDir);
		const buildTaskKey = "build" as const;
		const buildTask = cache.tasks[buildTaskKey];
		expect(buildTask).toBeDefined();
		expect(buildTask?.hash).toBeUndefined();
		expect(typeof buildTask?.lastRun).toBe("number");
		expect(typeof buildTask?.lastDurationMs).toBe("number");
	});

	// ── Regression: cache flushed even on task failure ───────────
	it("persists cache to disk even when a task throws (Issue 11)", async () => {
		writeFileSync(path.join(cwd, "ok.ts"), "export const ok = 1;");

		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: {
				ok: { inputs: ["ok.ts"] },
				flaky: { dependsOn: ["ok"] },
			},
		};
		const graph = makeGraph([{ name: "ok" }, { name: "flaky", deps: ["ok"] }]);

		const executor = vi
			.fn<(name: string) => Promise<void>>()
			.mockImplementation(async (name: string) => {
				if (name === "flaky") throw new TaskExecutionError(name, 2);
			});

		await expect(
			runTasksWithDeps(
				"flaky",
				graph,
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
				},
				executor as TaskExecutor,
			),
		).rejects.toBeInstanceOf(TaskExecutionError);

		const cache = await readCache(cacheDir);
		const okTaskKey = "ok" as const;
		expect(cache.tasks[okTaskKey]).toBeDefined();
		expect(typeof cache.tasks[okTaskKey]?.lastDurationMs).toBe("number");
	});

	// ── taskFilter: filtered tasks are recorded as skipped ──────────────────
	it("marks tasks as skipped when taskFilter returns false", async () => {
		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: { lint: {}, build: { dependsOn: ["lint"] } },
		};
		const graph = makeGraph([
			{ name: "lint" },
			{ name: "build", deps: ["lint"] },
		]);
		const executor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const results = await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
				taskFilter: (name) => name === "lint",
			},
			executor,
		);

		const buildResult = results.find((r) => r.task === "build");
		expect(buildResult?.skipped).toBe(true);
		expect(buildResult?.durationMs).toBe(0);
		// lint was not filtered out (5th arg is the onOutput sink, unset here)
		expect(executor).toHaveBeenCalledWith(
			"lint",
			expect.anything(),
			expect.anything(),
			expect.anything(),
			undefined,
		);
		// build executor was never called
		expect(executor).not.toHaveBeenCalledWith(
			"build",
			expect.anything(),
			expect.anything(),
			expect.anything(),
			undefined,
		);
	});

	// ── plugin onBeforeExecute skip ──────────────────────────────────────────
	it("returns cacheHit result when plugin onBeforeExecute returns false", async () => {
		const plugins = new PluginRegistry();
		plugins.register({
			name: "cache-skip-plugin",
			hooks: {
				onBeforeExecute: async () => false as boolean,
			},
		});

		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: { build: {} },
		};
		const graph = makeGraph([{ name: "build" }]);
		const executor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const results = await runTasksWithDeps(
			"build",
			graph,
			{ cwd, cacheDir, pm: "npm", config, tasks: config.tasks, plugins },
			executor,
		);

		expect(executor).not.toHaveBeenCalled();
		expect(results[0]?.cacheHit).toBe(true);
		expect(results[0]?.durationMs).toBe(0);
	});

	// ── useScheduler path ────────────────────────────────────────────────────
	it("runs tasks via event-driven scheduler when useScheduler is true", async () => {
		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: { lint: {}, build: { dependsOn: ["lint"] } },
		};
		const graph = makeGraph([
			{ name: "lint" },
			{ name: "build", deps: ["lint"] },
		]);
		const executor = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

		const results = await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
				useScheduler: true,
			},
			executor,
		);

		expect(executor).toHaveBeenCalledTimes(2);
		expect(results).toHaveLength(2);
	});

	// ── 7. Concurrency ceiling ───────────────────────────────────────────────
	it("respects options.concurrency inside a level", async () => {
		let inFlight = 0;
		let peak = 0;
		const executor = vi
			.fn<(name: string) => Promise<void>>()
			.mockImplementation(async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise<void>((res) => setTimeout(res, 10));
				inFlight--;
			});

		// 5 sibling leaves + a build target that depends on all of them.
		// graph.toLevels("build") -> [[a, b, c, d, e], [build]], so the first
		// level has 5 items and exercises the limit < items.length branch
		// of mapLimit. Without a real cap, peak would reach 5.
		const leaves = ["a", "b", "c", "d", "e"];
		const config: ResolvedVariantConfig = {
			...makeConfig("adaptive"),
			tasks: {
				...Object.fromEntries(leaves.map((n) => [n, {}])),
				build: { dependsOn: leaves },
			},
		};
		const graph = makeGraph([
			...leaves.map((name) => ({ name })),
			{ name: "build", deps: leaves },
		]);

		await runTasksWithDeps(
			"build",
			graph,
			{
				cwd,
				cacheDir,
				pm: "npm",
				config,
				tasks: config.tasks,
				plugins: emptyPlugins(),
				concurrency: 2,
			},
			executor as TaskExecutor,
		);

		expect(peak).toBeLessThanOrEqual(2);
		expect(executor).toHaveBeenCalledTimes(leaves.length + 1);
	});

	// ── Remote cache hardening ───────────────────────────────────────────────
	describe("remote cache (untrusted data)", () => {
		const encode = (s: string) => new TextEncoder().encode(s);

		async function runWithRemote(
			remoteCache: {
				get: (key: string) => Promise<Uint8Array | null>;
				set: (key: string, value: Uint8Array) => Promise<void>;
				has: (key: string) => Promise<boolean>;
			},
			executor: TaskExecutor,
		): Promise<TaskRunResult[]> {
			writeFileSync(path.join(cwd, "main.ts"), "export const x = 1;");
			const config: ResolvedVariantConfig = {
				...makeConfig("adaptive"),
				tasks: { build: { inputs: ["main.ts"] } },
			};
			return runTasksWithDeps(
				"build",
				makeGraph([{ name: "build" }]),
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
					remoteCache,
				},
				executor,
			);
		}

		it("uses a valid remote entry as a remote hit (no local execution)", async () => {
			const executor = vi
				.fn<() => Promise<void>>()
				.mockResolvedValue(undefined);
			const results = await runWithRemote(
				{
					get: async () => encode(JSON.stringify({ lastRun: 123 })),
					set: async () => {},
					has: async () => true,
				},
				executor,
			);
			expect(executor).not.toHaveBeenCalled();
			expect(results[0]?.remoteHit).toBe(true);
		});

		it("treats a malformed remote entry as a miss and runs the task", async () => {
			const executor = vi
				.fn<() => Promise<void>>()
				.mockResolvedValue(undefined);
			const results = await runWithRemote(
				{
					get: async () => encode("}{ not json"),
					set: async () => {},
					has: async () => true,
				},
				executor,
			);
			expect(executor).toHaveBeenCalledTimes(1);
			expect(results[0]?.remoteHit).toBeUndefined();
			expect(results[0]?.cacheHit).toBe(false);
		});

		it("treats a wrong-shape remote entry (lastRun not a number) as a miss", async () => {
			const executor = vi
				.fn<() => Promise<void>>()
				.mockResolvedValue(undefined);
			const results = await runWithRemote(
				{
					get: async () => encode(JSON.stringify({ lastRun: "nope" })),
					set: async () => {},
					has: async () => true,
				},
				executor,
			);
			expect(executor).toHaveBeenCalledTimes(1);
			expect(results[0]?.cacheHit).toBe(false);
		});

		it("does not fail the run when the remote get throws", async () => {
			const executor = vi
				.fn<() => Promise<void>>()
				.mockResolvedValue(undefined);
			const results = await runWithRemote(
				{
					get: async () => {
						throw new Error("remote down");
					},
					set: async () => {},
					has: async () => true,
				},
				executor,
			);
			expect(executor).toHaveBeenCalledTimes(1);
			expect(results[0]?.cacheHit).toBe(false);
		});
	});

	// ── Provenance ───────────────────────────────────────────────────────────
	describe("provenance on failure", () => {
		function provenanceFor(taskId: string): TaskProvenance {
			return {
				taskId,
				reason: { kind: "affected-by", changedFiles: ["src/db.ts"] },
				dirtyDependents: ["web:build"],
				upstreamTasks: ["utils:build"],
			};
		}

		it("attaches the failing task's provenance to the thrown error", async () => {
			const graph = makeGraph([{ name: "build" }]);
			const config = makeConfig();
			const entry = provenanceFor("build");

			const error = await runTasksWithDeps(
				"build",
				graph,
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
					provenance: new Map([["build", entry]]),
				},
				vi
					.fn<() => Promise<void>>()
					.mockRejectedValue(new TaskExecutionError("build", 1)),
			).catch((err: unknown) => err);

			expect(error).toBeInstanceOf(TaskExecutionError);
			expect((error as TaskExecutionError).provenance).toEqual(entry);
		});

		it("reports the real hashes when a cached task is invalidated", async () => {
			// The reason must reflect what the runner observed, not the
			// affected-by placeholder createContext seeded.
			writeFileSync(path.join(cwd, "main.ts"), "export const x = 1;");
			const patterns = ["main.ts"];
			const staleHash = "stale-hash";
			await writeCache(cacheDir, {
				tasks: { build: { hash: staleHash, lastRun: Date.now() } },
			});

			const graph = makeGraph([{ name: "build" }]);
			const config = makeConfig();
			config.tasks = { build: { inputs: patterns } };
			const provenance = new Map([["build", provenanceFor("build")]]);

			const error = await runTasksWithDeps(
				"build",
				graph,
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
					provenance,
				},
				vi
					.fn<() => Promise<void>>()
					.mockRejectedValue(new TaskExecutionError("build", 1)),
			).catch((err: unknown) => err);

			const reason = (error as TaskExecutionError).provenance?.reason;
			expect(reason).toEqual({
				kind: "cache-miss",
				expectedHash: staleHash,
				actualHash: await hashTaskInputs(cwd, patterns),
			});
		});

		it("reports a null expected hash on a task that was never cached", async () => {
			writeFileSync(path.join(cwd, "main.ts"), "export const x = 1;");
			const patterns = ["main.ts"];

			const graph = makeGraph([{ name: "build" }]);
			const config = makeConfig();
			config.tasks = { build: { inputs: patterns } };
			const provenance = new Map([["build", provenanceFor("build")]]);

			const error = await runTasksWithDeps(
				"build",
				graph,
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
					provenance,
				},
				vi
					.fn<() => Promise<void>>()
					.mockRejectedValue(new TaskExecutionError("build", 1)),
			).catch((err: unknown) => err);

			const reason = (error as TaskExecutionError).provenance?.reason;
			expect(reason).toMatchObject({ kind: "cache-miss", expectedHash: null });
		});

		it("leaves a cache-hit task's reason untouched", async () => {
			// A task that never ran cannot have been invalidated.
			writeFileSync(path.join(cwd, "main.ts"), "export const x = 1;");
			const patterns = ["main.ts"];
			const hash = await hashTaskInputs(cwd, patterns);
			await writeCache(cacheDir, {
				tasks: { build: { hash, lastRun: Date.now() } },
			});

			const graph = makeGraph([{ name: "build" }]);
			const config = makeConfig();
			config.tasks = { build: { inputs: patterns } };
			const entry = provenanceFor("build");
			const provenance = new Map([["build", entry]]);

			await runTasksWithDeps(
				"build",
				graph,
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
					provenance,
				},
				vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			);

			expect(provenance.get("build")?.reason).toEqual({
				kind: "affected-by",
				changedFiles: ["src/db.ts"],
			});
		});

		it("wraps a non-VariantError from an injected executor", async () => {
			const graph = makeGraph([{ name: "build" }]);
			const config = makeConfig();
			const entry = provenanceFor("build");

			const error = await runTasksWithDeps(
				"build",
				graph,
				{
					cwd,
					cacheDir,
					pm: "npm",
					config,
					tasks: config.tasks,
					plugins: emptyPlugins(),
					provenance: new Map([["build", entry]]),
				},
				vi.fn<() => Promise<void>>().mockRejectedValue(new Error("raw boom")),
			).catch((err: unknown) => err);

			expect(error).toBeInstanceOf(TaskExecutionError);
			expect((error as TaskExecutionError).provenance).toEqual(entry);
		});

		it("still throws when the run captured no provenance at all", async () => {
			const graph = makeGraph([{ name: "build" }]);
			const config = makeConfig();

			await expect(
				runTasksWithDeps(
					"build",
					graph,
					{
						cwd,
						cacheDir,
						pm: "npm",
						config,
						tasks: config.tasks,
						plugins: emptyPlugins(),
					},
					vi
						.fn<() => Promise<void>>()
						.mockRejectedValue(new TaskExecutionError("build", 1)),
				),
			).rejects.toBeInstanceOf(TaskExecutionError);
		});
	});
});
