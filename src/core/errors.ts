// Imported from the leaf module rather than the `types/` barrel, which reaches
// back into core and would make this a cycle.
import type { TaskProvenance } from "../types/provenance.js";

export class VariantError extends Error {
	hint?: string;
	/**
	 * Why the task that produced this failure was running. Attached by the
	 * runner so the failure and its reason travel together; absent on errors
	 * belonging to no task (config, CLI usage) and on successful runs.
	 *
	 * This says nothing about why the task FAILED — see `RunReason`.
	 */
	provenance?: TaskProvenance;
	constructor(
		public code: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "VariantError";
	}
}

export class ConfigError extends VariantError {
	constructor(message: string, options?: ErrorOptions) {
		super("CONFIG_ERROR", message, options);
		this.hint = "Run `variant doctor` to diagnose configuration issues.";
	}
}

export class CycleError extends VariantError {
	constructor(public cycle: string[]) {
		super("CYCLE_ERROR", `Circular dependency detected: ${cycle.join(" -> ")}`);
		this.hint = "Remove or reorder `dependsOn` entries to break the cycle.";
	}
}

export class TaskExecutionError extends VariantError {
	constructor(
		public task: string,
		public exitCode: number,
		message?: string,
		options?: ErrorOptions,
	) {
		super(
			"TASK_EXECUTION_ERROR",
			message ?? `Task "${task}" failed with exit code ${exitCode}`,
			options,
		);
		this.hint = `Check the output above, fix the failing command in task "${task}", then re-run.`;
	}
}

export class CacheError extends VariantError {
	constructor(message: string, options?: ErrorOptions) {
		super("CACHE_ERROR", message, options);
		this.hint = "Delete `.variant/cache/` and retry.";
	}
}

export class GraphError extends VariantError {
	constructor(message: string, options?: ErrorOptions) {
		super("GRAPH_ERROR", message, options);
		this.hint = "Delete `.variant/graph/` and retry.";
	}
}

export class GitRefError extends VariantError {
	constructor(message: string) {
		super("GIT_REF_ERROR", message);
		this.hint =
			"Check the ref with `git rev-parse --verify <ref>`. In CI, check out with `fetch-depth: 0` and pass a remote-tracking ref such as `origin/main`.";
	}
}

export class ImpactReportError extends VariantError {
	constructor(message: string) {
		super("IMPACT_REPORT_ERROR", `Could not read the test report: ${message}`);
		this.hint =
			"Pass a Vitest `--reporter=json --outputFile=<path>` or Jest `--json --outputFile=<path>` report.";
	}
}

export class CliUsageError extends VariantError {
	constructor(message: string) {
		super("CLI_USAGE", message);
		this.hint = "Run `variant --help` for usage information.";
	}
}
