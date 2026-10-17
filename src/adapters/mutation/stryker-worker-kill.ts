/**
 * @module
 * Stryker kills each test-runner worker after asking it to dispose of
 * itself, with `taskkill /T /F` on Windows, and treats only "already closed"
 * as success. A worker caught on its way out makes taskkill fail otherwise,
 * and Stryker throws: the error replaced a failing baseline, and would replace
 * a finished run's result. variant ends the host's whole process tree after
 * every run, so a worker this kill misses is ended anyway.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The part of Stryker's internal `objectUtils` this changes. */
export interface StrykerObjectUtils {
	kill: (pid: number | undefined) => Promise<void>;
}

/**
 * Stryker's own `objectUtils`, which it calls as `objectUtils.kill(pid)`:
 * the same module instance, so a replaced `kill` is the one it calls. Not
 * exported by the package, so loaded by its file; Stryker is pinned exactly,
 * and a test fails if the file moves.
 */
export async function strykerObjectUtils(): Promise<
	StrykerObjectUtils | undefined
> {
	try {
		const core = path.dirname(
			createRequire(import.meta.url).resolve(
				"@stryker-mutator/core/package.json",
			),
		);
		const loaded: { objectUtils?: Partial<StrykerObjectUtils> } = await import(
			pathToFileURL(path.join(core, "dist", "src", "utils", "object-utils.js"))
				.href
		);
		const utils = loaded.objectUtils;
		return typeof utils?.kill === "function"
			? (utils as StrykerObjectUtils)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Makes `kill` succeed whether or not it could end the worker. */
export function tolerateFailedKills(utils: StrykerObjectUtils): void {
	const kill = utils.kill.bind(utils);
	utils.kill = (pid) => kill(pid).catch(() => {});
}
