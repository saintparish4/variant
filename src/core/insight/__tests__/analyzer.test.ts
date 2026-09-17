import { describe, expect, it } from "vitest";
import type { CacheFile } from "../../cache/store.js";
import { computeInsights } from "../analyzer.js";

function makeCache(entries: CacheFile["tasks"] = {}): CacheFile {
	return { tasks: entries };
}

describe("computeInsights", () => {
	it("returns zero duration and zero hit rate when results are empty", () => {
		const summary = computeInsights([], makeCache());
		expect(summary.totalDurationMs).toBe(0);
		expect(summary.cacheHitRate).toBe(0);
		expect(summary.lastRunResults).toHaveLength(0);
	});

	it("returns hit rate of 1 when all tasks are cache hits", () => {
		const results = [
			{ task: "lint", durationMs: 0, cacheHit: true },
			{ task: "build", durationMs: 0, cacheHit: true },
		];
		const summary = computeInsights(results, makeCache());
		expect(summary.cacheHitRate).toBe(1);
		expect(summary.totalDurationMs).toBe(0);
	});

	it("returns hit rate of 0 when all tasks are cache misses", () => {
		const results = [
			{ task: "lint", durationMs: 300, cacheHit: false },
			{ task: "build", durationMs: 500, cacheHit: false },
		];
		const summary = computeInsights(results, makeCache());
		expect(summary.cacheHitRate).toBe(0);
		expect(summary.totalDurationMs).toBe(800);
	});

	it("computes mixed hit rate correctly", () => {
		// 1 hit out of 4 = 0.25
		const results = [
			{ task: "typecheck", durationMs: 0, cacheHit: true },
			{ task: "lint", durationMs: 200, cacheHit: false },
			{ task: "build", durationMs: 400, cacheHit: false },
			{ task: "test", durationMs: 600, cacheHit: false },
		];
		const summary = computeInsights(results, makeCache());
		expect(summary.cacheHitRate).toBe(0.25);
		expect(summary.totalDurationMs).toBe(1200);
	});

	it("skipped tasks (skipped: true) count as misses in hit rate, contribute 0 to duration", () => {
		// A skipped task has cacheHit: false and durationMs: 0 — it does NOT
		// count as a hit, but it also does not inflate total time.
		const results = [
			{ task: "build", durationMs: 500, cacheHit: false },
			{ task: "lint", durationMs: 0, cacheHit: false, skipped: true },
		];
		const summary = computeInsights(results, makeCache());
		expect(summary.cacheHitRate).toBe(0); // no hits
		expect(summary.totalDurationMs).toBe(500); // skipped contributes 0
	});

	it("exposes cachedStats from the cache file directly", () => {
		const cache = makeCache({
			build: { hash: "abc", lastRun: 100, lastDurationMs: 250 },
		});
		const summary = computeInsights([], cache);
		expect(summary.cachedStats["build"]?.hash).toBe("abc");
		expect(summary.cachedStats["build"]?.lastDurationMs).toBe(250);
	});

	it("preserves result order in lastRunResults", () => {
		const results = [
			{ task: "lint", durationMs: 100, cacheHit: false },
			{ task: "build", durationMs: 200, cacheHit: false },
			{ task: "test", durationMs: 300, cacheHit: false },
		];
		const summary = computeInsights(results, makeCache());
		expect(summary.lastRunResults.map((r) => r.task)).toEqual([
			"lint",
			"build",
			"test",
		]);
	});
});
