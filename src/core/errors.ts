// Imported from the leaf module rather than the `types/` barrel, which reaches
// back into core and would make this a cycle.
import type { TaskProvenance } from "../types/provenance.js";

export class VariantError extends Error {
	hint?: string;
	/** Lines of evidence printed between the message and the hint. */
	details?: string[];
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

/**
 * A detected base that does not exist: the first push of a branch has no
 * previous commit, and a force-push can name one that is gone. Nobody made a
 * mistake, so a command that found its base this way reports it and succeeds.
 */
export class NoBaseCommitError extends VariantError {
	constructor() {
		super(
			"NO_BASE_COMMIT",
			"This push has no previous commit to compare against",
		);
		this.hint =
			"The first push of a branch, or a force-push whose old head is gone. Pass --base to compare against a commit of your choice.";
	}
}

export class ImpactReportError extends VariantError {
	constructor(message: string) {
		super("IMPACT_REPORT_ERROR", `Could not read the test report: ${message}`);
		this.hint =
			"Pass a Vitest `--reporter=json --outputFile=<path>` or Jest `--json --outputFile=<path>` report.";
	}
}

export class NoTestFilesError extends VariantError {
	constructor() {
		super(
			"NO_TEST_FILES",
			"No test files found, so there is nothing to predict",
		);
		this.hint =
			"variant finds TypeScript tests named `*.test.ts` or `*.spec.ts` (also `.tsx`, `.mts`, `.cts`) or placed under `__tests__/`. JavaScript files are not indexed.";
	}
}

/**
 * `variant check` found nothing that says what the change is: a clean tree on
 * the default branch, or no default branch at all. Guessing the previous
 * commit would check something the developer may not mean.
 */
export class NoChangeBaseError extends VariantError {
	constructor(message: string) {
		super("NO_CHANGE_BASE", message);
		this.hint =
			"Pass --base <ref> to say what to compare against, for example `--base HEAD~1` or `--base origin/main`.";
	}
}

export interface FailingTest {
	name: string;
	message: string;
}

/**
 * Tests that fail with no mutation in place. Every later failure would be
 * indistinguishable from one a mutation caused, so nothing is interpreted.
 */
export class BaselineFailedError extends VariantError {
	constructor(
		public failingTests: readonly FailingTest[],
		public output: string,
	) {
		super(
			"BASELINE_FAILED",
			failingTests.length === 0
				? "The tests fail before any mutation, so no result could be trusted"
				: `${failingTests.length} test${failingTests.length === 1 ? "" : "s"} fail before any mutation, so no result could be trusted`,
		);
		this.details = failingTests
			.slice(0, 10)
			.map((test) =>
				test.message === "" ? test.name : `${test.name}: ${test.message}`,
			);
		this.hint =
			"Make the tests pass first. If `vitest run` already passes outside variant, the copy variant runs them in is the cause: a path outside this directory (such as a tsconfig `extends`), git used by a test, or an absolute path.";
	}
}

/** The mutation-testing engine could not run, or stopped on an error of its own. */
export class CheckBackendError extends VariantError {
	constructor(
		message: string,
		public output: string,
	) {
		super("CHECK_BACKEND", message);
		const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
		this.details = lines.slice(-12);
		this.hint =
			lines.length > 0
				? "Above is the engine's last output. If the tests pass with `vitest run`, please report this with it."
				: "If the tests pass with `vitest run`, please report this.";
	}
}

/**
 * Run from a workspace root, a package imported by name resolves through
 * `node_modules` to its real source rather than to the copy being mutated, so
 * its mutants would read "no test reached this" when tests do.
 */
export class CheckWorkspaceRootError extends VariantError {
	constructor() {
		super(
			"CHECK_WORKSPACE_ROOT",
			"`variant check` runs from a package directory, not a workspace root",
		);
		this.hint =
			"cd into the package whose code changed and run `variant check` there.";
	}
}

/** The package does not test with Vitest, the one runner `check` supports. */
export class CheckRunnerError extends VariantError {
	constructor(found: { kind: "jest"; evidence: string } | { kind: "none" }) {
		super(
			"CHECK_RUNNER",
			found.kind === "jest"
				? `This package tests with Jest (${found.evidence}); \`variant check\` runs Vitest only`
				: "No Vitest here: no `vitest` dependency, script or config in this package",
		);
		this.hint =
			found.kind === "jest"
				? "Jest support is not built yet. The pull request report (`variant pr report`) and `variant impact` do work with Jest; docs/check.md says what `check` supports."
				: "Run it from the package that runs Vitest, or pass --vitest-config <file>.";
	}
}

export class CliUsageError extends VariantError {
	constructor(message: string) {
		super("CLI_USAGE", message);
		this.hint = "Run `variant --help` for usage information.";
	}
}
