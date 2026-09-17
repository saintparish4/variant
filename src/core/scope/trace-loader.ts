/**
 * @module
 * Reads trace JSON files written by src/tracer and converts them into the
 * package set the scheduler should restrict its work to.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TraceFile } from "../../tracer/types.js";
import { ConfigError } from "../errors.js";
import type { PackageGraph } from "../graph/package-graph.js";
import { packageForFile } from "../graph/package-graph.js";

export async function loadTrace(
	cwd: string,
	sessionId: string | "last",
): Promise<TraceFile> {
	const dir = path.resolve(cwd, ".variant/traces");
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new ConfigError(
				`Trace directory not found: "${dir}". Run \`variant trace\` first to record a session.`,
				{ cause: err },
			);
		}
		throw err;
	}
	if (sessionId === "last") {
		files.sort();
		const latest = files[files.length - 1];
		if (!latest) throw new Error("No trace files found");
		sessionId = latest.replace(/\.json$/, "");
	}
	return JSON.parse(
		await readFile(path.join(dir, `${sessionId}.json`), "utf8"),
	) as TraceFile;
}

export function tracedPackages(
	trace: TraceFile,
	graph: PackageGraph,
): Set<string> {
	const out = new Set<string>();
	for (const module of trace.modules) {
		const owner = packageForFile(module.file, graph);
		if (owner !== null) out.add(owner.name);
	}
	return out;
}
