/**
 * @module
 * Whether the package `variant check` runs in tests with Vitest, decided
 * before Stryker starts: on a Jest package Stryker spent seconds starting up
 * and then said only that no tests ran.
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
	return { kind: runner.kind, configFile: relative.split(path.sep).join("/") };
}

export type RunnerVerdict =
	| { kind: "vitest" }
	/** `evidence` names what shows it, for the error. */
	| { kind: "jest"; evidence: string }
	| { kind: "none" };

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

/**
 * From the package's own `package.json` and the names of the files beside it.
 * Vitest wins wherever there is any sign of it: a package moving off Jest
 * keeps its Jest config for a while.
 */
export function detectRunner(
	manifestText: string | null,
	fileNames: readonly string[],
): RunnerVerdict {
	const manifest = parse(manifestText);
	const declares = (name: string): boolean =>
		name in (manifest?.devDependencies ?? {}) ||
		name in (manifest?.dependencies ?? {});
	const scripts = Object.entries(manifest?.scripts ?? {});
	const scriptRunning = (tool: RegExp): string | undefined =>
		scripts.find(
			([, command]) => typeof command === "string" && tool.test(command),
		)?.[0];

	if (
		declares("vitest") ||
		scriptRunning(/\bvitest\b/) !== undefined ||
		fileNames.some((name) => /^vitest\.(config|workspace)\./.test(name))
	) {
		return { kind: "vitest" };
	}

	const jestConfig = fileNames.find((name) => /^jest\.config\./.test(name));
	if (jestConfig !== undefined) return { kind: "jest", evidence: jestConfig };
	const jestScript = scriptRunning(/\bjest\b/);
	if (jestScript !== undefined) {
		return { kind: "jest", evidence: `the \`${jestScript}\` script` };
	}
	if (manifest?.jest !== undefined) {
		return { kind: "jest", evidence: "the `jest` key in package.json" };
	}
	if (declares("jest"))
		return { kind: "jest", evidence: "a `jest` dependency" };
	return { kind: "none" };
}
