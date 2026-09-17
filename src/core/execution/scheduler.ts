/**
 * @module
 * Event-driven task scheduler. Maintains a ready queue keyed by predicted cost
 * and wakes dependents when their last upstream finishes. Resource accounting
 * is deferred to Phase 4 (cost model); this phase ships the topology + queue.
 */

import type {
	ResolvedVariantConfig,
	TaskConfig,
	TaskGraph,
} from "../../types/index.js";

export interface ScheduledTask {
	name: string;
	/** Lower = scheduled sooner. Phase 4 fills with cost predictions. */
	priority?: number;
}

export interface SchedulerOptions {
	concurrency: number;
	/** Optional priority lookup; default 0. */
	priorityOf?: (task: string) => number;
}

export type TaskRunner = (task: string) => Promise<void>;

export async function runScheduled(
	target: string,
	graph: TaskGraph,
	runner: TaskRunner,
	options: SchedulerOptions,
): Promise<void> {
	const levels = graph.toLevels(target);
	const allTasks = levels.flat();
	const remainingDeps = new Map<string, number>();
	const dependents = new Map<string, Set<string>>();

	for (const t of allTasks) {
		remainingDeps.set(t, 0);
		dependents.set(t, new Set());
	}
	// Walk actual graph edges rather than approximating via level boundaries.
	// This lets tasks with no shared dependency start in true parallel instead
	// of being gated on a whole level wave finishing.
	for (const t of allTasks) {
		for (const dep of graph.getDependencies(t)) {
			if (remainingDeps.has(dep)) {
				// dep is in our subgraph: t depends on dep, so dep has t as a dependent
				remainingDeps.set(t, (remainingDeps.get(t) ?? 0) + 1);
				dependents.get(dep)?.add(t);
			}
		}
	}

	const priorityOf = options.priorityOf ?? (() => 0);
	const ready: string[] = [];
	for (const [t, n] of remainingDeps) {
		if (n === 0) ready.push(t);
	}
	ready.sort((a, b) => priorityOf(a) - priorityOf(b));

	let inFlight = 0;
	let firstError: unknown = null;

	return new Promise<void>((resolve, reject) => {
		const tryDrain = () => {
			if (firstError !== null && inFlight === 0) {
				reject(firstError);
				return;
			}
			while (
				firstError === null &&
				inFlight < options.concurrency &&
				ready.length > 0
			) {
				const next = ready.shift();
				if (next === undefined) continue;
				inFlight++;
				runner(next)
					.then(() => {
						for (const dep of dependents.get(next) ?? []) {
							const left = (remainingDeps.get(dep) ?? 0) - 1;
							remainingDeps.set(dep, left);
							if (left === 0) {
								insertSorted(ready, dep, priorityOf);
							}
						}
					})
					.catch((err) => {
						if (firstError === null) firstError = err;
					})
					.finally(() => {
						inFlight--;
						if (
							ready.length === 0 &&
							inFlight === 0 &&
							[...remainingDeps.values()].every((n) => n <= 0)
						) {
							firstError === null ? resolve() : reject(firstError);
							return;
						}
						tryDrain();
					});
			}
		};
		tryDrain();
	});
}

/**
 * Derives a `priorityOf` function from the resolved config's scheduler policy
 * and per-task `cpuHeavy` flags. Returns `undefined` when the policy imposes
 * no ordering (i.e. "auto" or absent), letting the scheduler use its default.
 *
 * Policies:
 *   "light-first"   — non-cpuHeavy tasks (priority 0) before cpuHeavy (priority 1)
 *   "pack-heavy"    — cpuHeavy tasks (priority 0) before non-cpuHeavy (priority 1)
 *   "critical-path" — deferred to Phase 4; treated as "auto" for now
 *   "auto" / absent — no ordering imposed
 */
export function priorityFromConfig(
	config: ResolvedVariantConfig,
	tasks: Record<string, TaskConfig>,
): ((task: string) => number) | undefined {
	const policy = config.scheduler?.policy;
	if (policy === "light-first") {
		return (task: string) => (tasks[task]?.cpuHeavy ? 1 : 0);
	}
	if (policy === "pack-heavy") {
		return (task: string) => (tasks[task]?.cpuHeavy ? 0 : 1);
	}
	return undefined;
}

function insertSorted(
	arr: string[],
	item: string,
	priorityOf: (t: string) => number,
): void {
	const p = priorityOf(item);
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const midTask = arr[mid];
		if (midTask === undefined || priorityOf(midTask) <= p) lo = mid + 1;
		else hi = mid;
	}
	arr.splice(lo, 0, item);
}
