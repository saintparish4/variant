/**
 * @module
 * Whether Stryker can rewrite the project's tsconfig for the copy it tests
 * in. Its preprocessor calls TypeScript's JavaScript API, which TypeScript 7
 * (native, npm `latest` since 2026) does not have: every run there failed
 * with "ts.parseConfigFileTextToJson is not a function".
 */

import { createRequire } from "node:module";
import path from "node:path";
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

/**
 * Whether the package's tsconfig chain points outside the package through a
 * relative `extends` or `references`: the only case where skipping Stryker's
 * rewrite changes anything. A package specifier resolves through the linked
 * `node_modules` either way. Parsed with ts-morph's own TypeScript, which has
 * the JavaScript API whatever version the project uses.
 */
export async function tsconfigLeavesPackage(
	root: string,
	read: (file: string) => string | null | Promise<string | null>,
): Promise<boolean> {
	const { ts } = await import("ts-morph");
	const visited = new Set<string>();
	const inside = (file: string): boolean => {
		const relative = path.relative(root, file);
		return !relative.startsWith("..") && !path.isAbsolute(relative);
	};
	const visit = async (file: string): Promise<boolean> => {
		if (visited.has(file)) return false;
		visited.add(file);
		const text = await read(file);
		if (text === null) return false;
		const config = ts.parseConfigFileTextToJson(file, text).config as
			| { extends?: unknown; references?: unknown }
			| undefined;
		const extended = Array.isArray(config?.extends)
			? config.extends
			: [config?.extends];
		for (const target of extended) {
			if (typeof target !== "string" || !target.startsWith(".")) continue;
			const resolved = path.resolve(path.dirname(file), target);
			if (!inside(resolved)) return true;
			if (
				await visit(resolved.endsWith(".json") ? resolved : `${resolved}.json`)
			) {
				return true;
			}
		}
		const references = Array.isArray(config?.references)
			? config.references
			: [];
		return references.some(
			(reference: unknown) =>
				typeof (reference as { path?: unknown })?.path === "string" &&
				!inside(
					path.resolve(
						path.dirname(file),
						(reference as { path: string }).path,
					),
				),
		);
	};
	return visit(path.join(root, "tsconfig.json"));
}
