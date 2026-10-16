/**
 * @module
 * Which runner `variant check` runs the package's tests with, decided before
 * Stryker starts: on a package it cannot run, Stryker spent seconds starting
 * up and then said only that no tests ran.
 */

import path from "node:path";
import { CliUsageError } from "../errors.js";

/** The test runners `variant check` drives. */
export type RunnerKind = "vitest" | "jest";

export const RUNNER_NAMES: Readonly<Record<RunnerKind, string>> = {
	vitest: "Vitest",
	jest: "Jest",
};

/** What `variant check` runs the tests with. */
export interface CheckRunner {
	kind: RunnerKind;
	/** The config to run them with, relative to cwd; absent for the runner's own lookup. */
	configFile?: string;
	/** Node flags for the processes the tests run in. */
	nodeArgs?: string[];
}

/**
 * The runner with its config named relative to cwd, which is where the copy
 * the tests run in has it. Named outside cwd, or by an absolute path, it
 * would be the real package's config, and the runner would test the real
 * files: Jest's root follows its config, snapshots and all.
 */
export function withConfigInside(
	cwd: string,
	runner: CheckRunner,
): CheckRunner {
	if (runner.configFile === undefined) return runner;
	const relative = path.relative(cwd, path.resolve(cwd, runner.configFile));
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		const error = new CliUsageError(
			`--${runner.kind}-config must name a file inside this package, and ${runner.configFile} is not`,
		);
		error.hint =
			"variant check runs the tests in a copy of this package; a config outside it would run them against the real files.";
		throw error;
	}
	return { ...runner, configFile: relative.split(path.sep).join("/") };
}

export interface RunnerVerdict {
	kind: RunnerKind | "none";
	/**
	 * Node flags the package's `test` script runs the tests with that the
	 * runner's workers need too: Jest's ESM mode is off without
	 * `--experimental-vm-modules`, and every test file then fails to load.
	 */
	nodeArgs: string[];
}

interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	jest?: unknown;
}

function parse(manifest: string | null): Manifest | null {
	if (manifest === null) return null;
	try {
		return JSON.parse(manifest) as Manifest;
	} catch {
		return null;
	}
}

const NODE_FLAGS = ["--experimental-vm-modules"];

/**
 * From the package's own `package.json` and the names of the files beside it.
 * Where both runners show, the `test` script says which one the package
 * runs; where it names neither, Vitest: a package moving off Jest keeps its
 * Jest config for a while.
 */
export function detectRunner(
	manifestText: string | null,
	fileNames: readonly string[],
): RunnerVerdict {
	const manifest = parse(manifestText);
	const declares = (name: string): boolean =>
		name in (manifest?.devDependencies ?? {}) ||
		name in (manifest?.dependencies ?? {});
	const scripts = Object.values(manifest?.scripts ?? {}).filter(
		(command): command is string => typeof command === "string",
	);
	const scriptRuns = (tool: RegExp): boolean =>
		scripts.some((command) => tool.test(command));
	const testScript =
		typeof manifest?.scripts?.["test"] === "string"
			? manifest.scripts["test"]
			: "";
	const nodeArgs = NODE_FLAGS.filter((flag) => testScript.includes(flag));

	const vitest =
		declares("vitest") ||
		scriptRuns(/\bvitest\b/) ||
		fileNames.some((name) => /^vitest\.(config|workspace)\./.test(name));
	const jest =
		fileNames.some((name) => /^jest\.config\./.test(name)) ||
		scriptRuns(/\bjest\b/) ||
		manifest?.jest !== undefined ||
		declares("jest");

	if (vitest && jest) {
		const followsJest =
			/\bjest\b/.test(testScript) && !/\bvitest\b/.test(testScript);
		return { kind: followsJest ? "jest" : "vitest", nodeArgs };
	}
	if (vitest) return { kind: "vitest", nodeArgs };
	if (jest) return { kind: "jest", nodeArgs };
	return { kind: "none", nodeArgs };
}

export interface RunnerFlags {
	runner?: string;
	jestConfig?: string;
	vitestConfig?: string;
}

/** The runner the command line names, if it names one. */
export function requestedRunner(flags: RunnerFlags): CheckRunner | undefined {
	const { runner, jestConfig, vitestConfig } = flags;
	if (runner !== undefined && runner !== "vitest" && runner !== "jest") {
		throw new CliUsageError(`--runner takes vitest or jest, not "${runner}"`);
	}
	if (jestConfig !== undefined && vitestConfig !== undefined) {
		throw new CliUsageError(
			"--jest-config and --vitest-config name different runners; pass one of them",
		);
	}
	const implied: RunnerKind | undefined =
		jestConfig !== undefined
			? "jest"
			: vitestConfig !== undefined
				? "vitest"
				: undefined;
	if (runner !== undefined && implied !== undefined && runner !== implied) {
		throw new CliUsageError(
			`--runner ${runner} and --${implied}-config name different runners`,
		);
	}
	const kind = runner ?? implied;
	if (kind === undefined) return undefined;
	const configFile = jestConfig ?? vitestConfig;
	return { kind, ...(configFile !== undefined && { configFile }) };
}
