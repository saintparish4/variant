/**
 * @module
 * The import chain from a file to the nearest of a set of targets: what turns
 * "this test was selected" into "this test imports `a.ts`, which imports the
 * file you changed".
 *
 * Structural on purpose. A test is selected when its import closure holds an
 * affected file, and every affected file reaches a changed one through
 * imports, so the shortest chain is always a true account of the selection.
 */

import type { ImportGraph } from "./import-graph.js";
import { importersOfUnindexed } from "./import-graph.js";

function importersOf(graph: ImportGraph, file: string): Iterable<string> {
	// A target with no node (a stylesheet, a deleted file) is reached through
	// the imports that name it.
	return graph.imports.has(file)
		? (graph.dependents.get(file) ?? [])
		: importersOfUnindexed(graph, file);
}

/**
 * One breadth-first walk outward from every target, so each file learns its
 * next hop toward the nearest one. The returned lookup gives the chain from a
 * file to that target, both ends included, or null when it reaches none.
 */
export function pathsToward(
	graph: ImportGraph,
	targets: readonly string[],
): (from: string) => string[] | null {
	const next = new Map<string, string | null>();
	let frontier = [...new Set(targets)].sort();
	for (const target of frontier) next.set(target, null);

	while (frontier.length > 0) {
		const reached: string[] = [];
		for (const file of frontier) {
			for (const importer of [...importersOf(graph, file)].sort()) {
				if (next.has(importer)) continue;
				next.set(importer, file);
				reached.push(importer);
			}
		}
		frontier = reached;
	}

	return (from) => {
		if (!next.has(from)) return null;
		const chain = [from];
		let hop = next.get(from);
		while (hop !== null && hop !== undefined) {
			chain.push(hop);
			hop = next.get(hop);
		}
		return chain;
	};
}
