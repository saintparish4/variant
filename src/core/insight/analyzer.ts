import type { CacheFile, TaskCacheEntry } from "../cache/store.js";
import type { TaskRunResult } from "../execution/runner.js";

export interface InsightSummary {
	lastRunResults: TaskRunResult[];
	cachedStats: Record<string, TaskCacheEntry>;
	totalDurationMs: number;
	cacheHitRate: number;
}

export function computeInsights(
	results: TaskRunResult[],
	cache: CacheFile,
): InsightSummary {
	const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
	const hits = results.filter((r) => r.cacheHit).length;
	const cacheHitRate = results.length === 0 ? 0 : hits / results.length;

	return {
		lastRunResults: results,
		cachedStats: cache.tasks,
		totalDurationMs,
		cacheHitRate,
	};
}
