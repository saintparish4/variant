/**
 * @module
 * Whether the package `variant check` runs in tests with Vitest, decided
 * before Stryker starts: on a Jest package Stryker spent seconds starting up
 * and then said only that no tests ran.
 */

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
