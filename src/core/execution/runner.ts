import { createHash } from "node:crypto";
import os from "node:os";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

import type {
	ResolvedVariantConfig,
	TaskConfig,
	TaskGraph,
	TaskProvenance,
} from "../../types/index.js";
import { hashTaskInputs } from "../cache/hashing.js";
import type { RemoteCacheAdapter } from "../cache/remote-adapter.js";
import type { CacheFile } from "../cache/store.js";
import {
	evictStaleEntries,
	readCache,
	writeCache,
	writeCacheSync,
} from "../cache/store.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { OnTaskEvent } from "../progress/reporter.js";
import { attachProvenance } from "../provenance/attach.js";
import { recordCacheMiss } from "../provenance/capture.js";
import { mapLimit } from "./concurrency.js";
import type { TaskExecutor } from "./executor.js";
import { executeTask } from "./executor.js";
import { runScheduled } from "./scheduler.js";

export interface RunOptions {
	cwd: string;
	cacheDir: string;
	pm: string;
	config: ResolvedVariantConfig;
	tasks: Record<string, TaskConfig>;
	concurrency?: number;
	/** When true, use event-driven scheduling instead of level-based waves. */
	useScheduler?: boolean;
	/** Lower priority runs sooner (passed through to the scheduler). */
	priorityOf?: (task: string) => number;
	/** Hook fan-out for this run; pass an empty registry to opt out. */
	plugins: PluginRegistry;
	/** When set, hashTaskInputs only reads files inside these dirs. */
	packageScopes?: string[];
	/**
	 * When set, only tasks passing this predicate are executed; others are
	 * recorded as skipped (durationMs 0, cacheHit false, skipped true).
	 */
	taskFilter?: (taskName: string) => boolean;
	/** Optional remote cache backend for cross-machine cache sharing. */
	remoteCache?: RemoteCacheAdapter;
	/**
	 * Called on each task lifecycle change (running/cached/done/failed) —
	 * drive live output from these events. The CLI bridges them onto a spinner
	 * via createTaskEventProgress, which degrades to per-line logging when
	 * progress is hidden.
	 */
	onTaskEvent?: OnTaskEvent;
	/**
	 * When set, task stdout/stderr is captured and streamed here line by line
	 * instead of inheriting the terminal — set it whenever live progress
	 * rendering is active so child output can't tear through the display.
	 */
	onTaskOutput?: (task: string, line: string) => void;
	/**
	 * Seeded by `createContext()`. The runner only refines it, upgrading a
	 * task's reason to `cache-miss` once the hash comparison produces both
	 * sides — it never rebuilds the DAG-derived fields.
	 */
	provenance?: Map<string, TaskProvenance>;
}

export interface TaskRunResult {
	task: string;
	durationMs: number;
	cacheHit: boolean;
	/** True when the task was filtered out by taskFilter (not actually run). */
	skipped?: boolean;
	/** True when the cache hit came from the remote backend (not local). */
	remoteHit?: boolean;
}

export function defaultConcurrency(): number {
	return Math.max(1, os.cpus().length - 1);
}

interface RemoteEntry {
	lastRun: number;
	lastDurationMs?: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function serializeRemoteEntry(entry: RemoteEntry): Uint8Array {
	return textEncoder.encode(JSON.stringify(entry));
}

/**
 * Parses bytes fetched from a remote cache backend. Remote data is untrusted:
 * a malformed payload (corrupt bytes, a hostile server, a schema change) must
 * never crash the run, so this returns `null` — treated as a cache miss — for
 * anything that doesn't match the expected shape rather than throwing.
 */
function parseRemoteEntry(bytes: Uint8Array): RemoteEntry | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(textDecoder.decode(bytes));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj["lastRun"] !== "number" || !Number.isFinite(obj["lastRun"])) {
		return null;
	}
	const entry: RemoteEntry = { lastRun: obj["lastRun"] };
	if (
		typeof obj["lastDurationMs"] === "number" &&
		Number.isFinite(obj["lastDurationMs"])
	) {
		entry.lastDurationMs = obj["lastDurationMs"];
	}
	return entry;
}

async function runOneTask(
	taskName: string,
	options: RunOptions,
	cache: CacheFile,
	executor: TaskExecutor,
): Promise<TaskRunResult> {
	if (options.taskFilter && !options.taskFilter(taskName)) {
		return { task: taskName, durationMs: 0, cacheHit: false, skipped: true };
	}

	const taskCfg = options.tasks[taskName] ?? {};
	const patterns = taskCfg.inputs ?? [];
	const isStrict = options.config.strategy === "strict";
	const plugins = options.plugins;
	const { onTaskOutput } = options;
	const onOutput =
		onTaskOutput !== undefined
			? (line: string) => onTaskOutput(taskName, line)
			: undefined;

	if (plugins) {
		const skip = await plugins.runOnBeforeExecute(taskName);
		if (skip) {
			const result: TaskRunResult = {
				task: taskName,
				durationMs: 0,
				cacheHit: true,
			};
			options.onTaskEvent?.({ task: taskName, status: "cached" });
			await plugins.runOnAfterExecute(taskName, result);
			return result;
		}
	}

	if (!isStrict && patterns.length > 0) {
		const baseHash = await hashTaskInputs(
			options.cwd,
			patterns,
			options.packageScopes !== undefined
				? { packageScopes: options.packageScopes }
				: {},
		);
		const extra = plugins ? await plugins.runOnHash(taskName, patterns) : [];
		const hash =
			extra.length === 0
				? baseHash
				: sha256(`${baseHash}\x00${extra.join("\x00")}`);
		const cached = cache.tasks[taskName];

		if (cached !== undefined && cached.hash === hash) {
			const result: TaskRunResult = {
				task: taskName,
				durationMs: 0,
				cacheHit: true,
			};
			options.onTaskEvent?.({ task: taskName, status: "cached" });
			if (plugins) await plugins.runOnAfterExecute(taskName, result);
			return result;
		}

		// Past the hit check, so this task is definitively a local miss and both
		// sides of the comparison exist. Keep them instead of discarding them
		// with the boolean.
		recordCacheMiss(options.provenance, taskName, cached?.hash ?? null, hash);

		// Local miss — check remote cache before running the task. A remote
		// read failure is non-fatal (symmetric with the write path below): we
		// fall through and run the task locally instead of breaking the build.
		if (options.remoteCache !== undefined) {
			let remoteEntry: RemoteEntry | null = null;
			try {
				const remoteBytes = await options.remoteCache.get(hash);
				if (remoteBytes !== null) remoteEntry = parseRemoteEntry(remoteBytes);
			} catch {
				remoteEntry = null;
			}
			if (remoteEntry !== null) {
				cache.tasks[taskName] = { hash, ...remoteEntry };
				const result: TaskRunResult = {
					task: taskName,
					durationMs: 0,
					cacheHit: true,
					remoteHit: true,
				};
				options.onTaskEvent?.({ task: taskName, status: "cached" });
				if (plugins) await plugins.runOnAfterExecute(taskName, result);
				return result;
			}
		}

		options.onTaskEvent?.({ task: taskName, status: "running" });
		const start = Date.now();
		try {
			await executor(taskName, taskCfg, options.pm, options.cwd, onOutput);
		} catch (err) {
			options.onTaskEvent?.({ task: taskName, status: "failed" });
			throw attachProvenance(err, taskName, options.provenance);
		}
		const durationMs = Date.now() - start;

		const entry = { hash, lastRun: Date.now(), lastDurationMs: durationMs };
		cache.tasks[taskName] = entry;

		// Push to remote so other machines benefit from this run.
		if (options.remoteCache !== undefined) {
			try {
				await options.remoteCache.set(hash, serializeRemoteEntry(entry));
			} catch {
				// Remote write failure is non-fatal; local cache is already updated.
			}
		}

		const result: TaskRunResult = {
			task: taskName,
			durationMs,
			cacheHit: false,
		};
		options.onTaskEvent?.({ task: taskName, status: "done", durationMs });
		if (plugins) await plugins.runOnAfterExecute(taskName, result);
		return result;
	}

	// Strict mode or no-inputs task: always execute, but still
	// record run metadata so `insight` shows history for these tasks.
	options.onTaskEvent?.({ task: taskName, status: "running" });
	const start = Date.now();
	try {
		await executor(taskName, taskCfg, options.pm, options.cwd, onOutput);
	} catch (err) {
		options.onTaskEvent?.({ task: taskName, status: "failed" });
		throw attachProvenance(err, taskName, options.provenance);
	}
	const durationMs = Date.now() - start;

	cache.tasks[taskName] = {
		lastRun: Date.now(),
		lastDurationMs: durationMs,
	};

	const result: TaskRunResult = {
		task: taskName,
		durationMs,
		cacheHit: false,
	};
	options.onTaskEvent?.({ task: taskName, status: "done", durationMs });
	if (plugins) await plugins.runOnAfterExecute(taskName, result);
	return result;
}

export async function runTasksWithDeps(
	target: string,
	graph: TaskGraph,
	options: RunOptions,
	executor: TaskExecutor = executeTask,
): Promise<TaskRunResult[]> {
	const levels = graph.toLevels(target);
	const rawCache = await readCache(options.cacheDir);
	const ttlDays = options.config.cache.ttlDays;
	const cache: CacheFile =
		ttlDays !== undefined ? evictStaleEntries(rawCache, ttlDays) : rawCache;
	const results: TaskRunResult[] = [];
	const concurrency = options.concurrency ?? defaultConcurrency();

	// Defense-in-depth: if the process is killed mid-run (SIGINT, etc.) we
	// still flush whatever we have. The handler MUST be synchronous.
	const flushCache = (): void => writeCacheSync(options.cacheDir, cache);
	process.on("exit", flushCache);

	try {
		if (options.useScheduler) {
			const byTask = new Map<string, TaskRunResult>();
			await runScheduled(
				target,
				graph,
				async (taskName) => {
					byTask.set(
						taskName,
						await runOneTask(taskName, options, cache, executor),
					);
				},
				{
					concurrency,
					...(options.priorityOf !== undefined
						? { priorityOf: options.priorityOf }
						: {}),
				},
			);
			for (const name of levels.flat()) {
				const r = byTask.get(name);
				if (r !== undefined) results.push(r);
			}
		} else {
			for (const level of levels) {
				const levelResults = await mapLimit(
					level,
					concurrency,
					async (taskName): Promise<TaskRunResult> =>
						runOneTask(taskName, options, cache, executor),
				);

				results.push(...levelResults);
			}
		}
	} finally {
		// ALWAYS persist whatever we have, even on task failure.
		// Order matters: write first, then remove the exit handler so the
		// safety net is still armed during the await.
		try {
			await writeCache(options.cacheDir, cache);
		} catch {
			// If async write fails, fall back to the sync handler logic --
			// the exit handler will still run on process termination.
		}
		process.off("exit", flushCache);
	}

	return results;
}
