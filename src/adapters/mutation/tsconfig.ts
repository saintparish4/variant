/**
 * @module
 * Whether Stryker can rewrite the project's tsconfig for the copy it tests
 * in. Its preprocessor calls TypeScript's JavaScript API, which TypeScript 7
 * (native, npm `latest` since 2026) does not have: every run there failed
 * with "ts.parseConfigFileTextToJson is not a function".
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export async function canRewriteTsconfig(
	load: () => Promise<unknown>,
): Promise<boolean> {
	try {
		const module = (await load()) as { default?: unknown } | null;
		const api = (module?.default ?? module) as Record<string, unknown> | null;
		return typeof api?.["parseConfigFileTextToJson"] === "function";
	} catch {
		return false;
	}
}

/** The `typescript` Stryker's core would import, resolved from where it is. */
export function loadTypescriptAsStryker(): Promise<unknown> {
	const core = createRequire(import.meta.url).resolve("@stryker-mutator/core");
	const typescript = createRequire(core).resolve("typescript");
	return import(pathToFileURL(typescript).href);
}
