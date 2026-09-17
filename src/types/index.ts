import type * as z from "zod";
import type {
	taskConfigSchema,
	variantConfigSchema,
} from "../core/config/schema.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import type { TaskProvenance } from "./provenance.js";

export type { RunReason, TaskProvenance } from "./provenance.js";

/** The object a user passes to `defineConfig`: every field optional. */
export type VariantConfig = z.input<typeof variantConfigSchema>;

/** The same config after validation, with every default filled in. */
export type ResolvedVariantConfig = z.output<typeof variantConfigSchema>;

export type Strategy = ResolvedVariantConfig["strategy"];

export type TaskConfig = z.infer<typeof taskConfigSchema>;

export type CacheConfig = ResolvedVariantConfig["cache"];

/** Implemented by `core/graph`; consumers depend on this, not the class. */
export interface TaskGraph {
	addTask(name: string): void;
	addDependency(task: string, dep: string): void;
	/** Returns the direct dependencies of a task (tasks it depends ON). */
	getDependencies(task: string): ReadonlySet<string>;
	toLevels(target: string): string[][];
}

export interface RuntimeInfo {
	primary: string;
	fallback: string;
}

export interface VariantContext {
	cwd: string;
	config: ResolvedVariantConfig;
	pm: string;
	runtime: RuntimeInfo;
	framework: string | null;
	graph: TaskGraph;
	cacheDir: string;
	plugins: PluginRegistry;
	packageScopes?: string[];
	/**
	 * Package names (including cascade dependents) affected by the current
	 * git diff. Set when git is available and changes are detected.
	 * Used by --affected to filter task execution.
	 */
	affectedPackages?: ReadonlySet<string>;
	/**
	 * Why each task would run this invocation, keyed by task name. Seeded here
	 * from the DAG and the git diff; the runner refines a task's reason to
	 * `cache-miss` once it has both hashes.
	 */
	provenance: Map<string, TaskProvenance>;
}
