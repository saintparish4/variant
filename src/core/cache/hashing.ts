/**
 * @module
 * Content hashing for task inputs — the cache key every incremental decision
 * rests on.
 *
 * Files are hashed individually and their digests combined in path order,
 * rather than buffering every matched file and streaming the whole set into
 * one hash. That caps peak memory at one file per worker instead of the total
 * size of a task's inputs, which on a large monorepo was a real spike.
 *
 * Digests are deliberately NOT shared across the tasks of a run. A cache keyed
 * by path would have to prove nothing rewrote the file since the last task
 * hashed it, and stat (mtime + size) cannot: a same-length rewrite inside one
 * mtime tick is indistinguishable, and serving the stale digest would hand a
 * later task a cache key it should have missed.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

export interface HashOptions {
	/** When set, only files inside these package dirs are read. */
	packageScopes?: string[];
	/** Concurrency for parallel readFile. Default 32. */
	parallel?: number;
}

function assertSafePattern(pattern: string): void {
	if (path.isAbsolute(pattern)) {
		throw new Error(
			`Unsafe glob pattern "${pattern}": patterns must be relative and must not traverse outside the project root.`,
		);
	}
	// Normalize separators then reject any ".." segment — catches "./../../etc/passwd" and similar.
	const segments = pattern.replace(/\\/g, "/").split("/");
	if (segments.some((seg) => seg === "..")) {
		throw new Error(
			`Unsafe glob pattern "${pattern}": patterns must be relative and must not traverse outside the project root.`,
		);
	}
}

export async function hashTaskInputs(
	cwd: string,
	patterns: string[],
	options: HashOptions = {},
): Promise<string> {
	for (const p of patterns) assertSafePattern(p);
	const files = (
		await fg(patterns, {
			cwd,
			onlyFiles: true,
			ignore: ["node_modules/**", ".git/**", ".variant/**"],
		})
	).sort();

	const inScope = filterToScopes(cwd, files, options.packageScopes);

	const limit = Math.max(1, options.parallel ?? 32);
	const digests = new Array<string>(inScope.length);
	let next = 0;
	const worker = async () => {
		while (true) {
			const i = next++;
			if (i >= inScope.length) return;
			const relPath = inScope[i];
			if (relPath === undefined) return;
			digests[i] = sha256(await readFile(path.join(cwd, relPath)));
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, inScope.length || 1) }, worker),
	);

	// Combined in path order, so the key is stable regardless of which worker
	// finished first.
	const hash = createHash("sha256");
	for (let i = 0; i < inScope.length; i++) {
		const relPath = inScope[i];
		const digest = digests[i];
		if (relPath === undefined || digest === undefined) continue;
		hash.update(relPath);
		hash.update(digest);
	}
	return hash.digest("hex");
}

function filterToScopes(
	cwd: string,
	files: string[],
	packageScopes: string[] | undefined,
): string[] {
	if (!packageScopes?.length) return files;
	// Resolved once instead of once per file per scope, which is what the
	// predicate used to do.
	const prefixes = packageScopes.map((dir) => path.resolve(dir) + path.sep);
	return files.filter((file) => {
		const absolute = path.resolve(cwd, file);
		return prefixes.some((prefix) => absolute.startsWith(prefix));
	});
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}
