/**
 * @module
 * Public types for the variant plugin system. Plugins observe and
 * optionally override caching / execution decisions; they never throw out
 * of the runner (errors are routed to onPluginError).
 */

import type { TaskConfig } from "../../types/index.js";
import type { TaskRunResult } from "../execution/runner.js";

export interface DetectionContext {
	cwd: string;
	pm: string;
	framework: string | null;
	// Mutable: Plugins MAY register synthesized tasks here during onDetect
	tasks: Record<string, TaskConfig>;
}

export type PluginHookName =
	| "onDetect"
	| "onHash"
	| "onBeforeExecute"
	| "onAfterExecute";

export interface BuildPlugin {
	name: string;
	hooks?: {
		// Runs once at context creation. May mutate ctx.tasks
		onDetect?: (ctx: DetectionContext) => void | Promise<void>;
		/**
		 * Returns ADDITIONAL hash inputs (strings folded into the cache key)
		 * for this task. Returning [] is meaningful: it signals "no extra
		 * inputs, default cache behavior". Returning undefined is also fine.
		 */
		onHash?: (
			task: string,
			files: string[],
		) => string[] | undefined | Promise<string[] | undefined>;
		/**
		 * Return false to mark the task as cached/skipped without running.
		 * Any other return value (including undefined) lets the runner proceed.
		 */
		onBeforeExecute?: (
			task: string,
		) => boolean | undefined | Promise<boolean | undefined>;
		onAfterExecute?: (
			task: string,
			result: TaskRunResult,
		) => void | Promise<void>;
	};
}

export type PluginErrorHook = (
	err: unknown,
	pluginName: string,
	hook: PluginHookName,
	task?: string,
) => void;
