import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceFile } from "../../../tracer/types.js";
import type { PackageGraph } from "../../graph/package-graph.js";
import { loadTrace, tracedPackages } from "../trace-loader.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-trace-loader-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

function makeTraceFile(overrides: Partial<TraceFile> = {}): TraceFile {
	return {
		schemaVersion: 1,
		sessionId: "abc123",
		startedAt: 1000,
		endedAt: 2000,
		framework: "next",
		modules: [],
		routes: [],
		...overrides,
	};
}

function writeTrace(dir: string, sessionId: string, data: TraceFile): void {
	const tracesDir = path.join(dir, ".variant", "traces");
	mkdirSync(tracesDir, { recursive: true });
	writeFileSync(
		path.join(tracesDir, `${sessionId}.json`),
		JSON.stringify(data),
	);
}

describe("loadTrace", () => {
	it("loads a trace by explicit sessionId", async () => {
		const dir = makeTmpDir();
		const expected = makeTraceFile({ sessionId: "my-session" });
		writeTrace(dir, "my-session", expected);
		const result = await loadTrace(dir, "my-session");
		expect(result.sessionId).toBe("my-session");
		expect(result.framework).toBe("next");
	});

	it("loads the last trace alphabetically when sessionId is 'last'", async () => {
		const dir = makeTmpDir();
		// Write three sessions — alphabetically, "session-c" is last
		writeTrace(dir, "session-a", makeTraceFile({ sessionId: "session-a" }));
		writeTrace(dir, "session-c", makeTraceFile({ sessionId: "session-c" }));
		writeTrace(dir, "session-b", makeTraceFile({ sessionId: "session-b" }));
		const result = await loadTrace(dir, "last");
		// "last" picks the lexicographically largest filename
		expect(result.sessionId).toBe("session-c");
	});

	it("loads the only file when there is exactly one trace", async () => {
		const dir = makeTmpDir();
		writeTrace(dir, "only-one", makeTraceFile({ sessionId: "only-one" }));
		const result = await loadTrace(dir, "last");
		expect(result.sessionId).toBe("only-one");
	});

	it("throws when 'last' is requested but no trace files exist", async () => {
		const dir = makeTmpDir();
		mkdirSync(path.join(dir, ".variant", "traces"), { recursive: true });
		// Directory exists but is empty
		await expect(loadTrace(dir, "last")).rejects.toThrow(
			"No trace files found",
		);
	});

	it("throws when traces directory does not exist (exposes BUG 3 — raw ENOENT)", async () => {
		// .variant/traces/ was never created — readdir throws ENOENT.
		// Currently the error is a raw NodeJS.ErrnoException, not an
		// VariantError. The test documents the current behavior.
		// Ideal fix: wrap in a ConfigError with a useful message.
		const dir = makeTmpDir();
		await expect(loadTrace(dir, "last")).rejects.toThrow();
	});

	it("throws when explicit sessionId does not exist", async () => {
		const dir = makeTmpDir();
		mkdirSync(path.join(dir, ".variant", "traces"), { recursive: true });
		await expect(loadTrace(dir, "nonexistent-session")).rejects.toThrow();
	});

	it("throws on malformed JSON in trace file", async () => {
		const dir = makeTmpDir();
		const tracesDir = path.join(dir, ".variant", "traces");
		mkdirSync(tracesDir, { recursive: true });
		writeFileSync(path.join(tracesDir, "bad.json"), "{ NOT VALID JSON }}}");
		await expect(loadTrace(dir, "bad")).rejects.toThrow();
	});

	it("ignores non-.json files when resolving 'last'", async () => {
		const dir = makeTmpDir();
		const tracesDir = path.join(dir, ".variant", "traces");
		mkdirSync(tracesDir, { recursive: true });
		// Write a .tmp file that should be ignored
		writeFileSync(path.join(tracesDir, "session-z.tmp"), "{}");
		writeTrace(dir, "session-a", makeTraceFile({ sessionId: "session-a" }));
		const result = await loadTrace(dir, "last");
		// .tmp is filtered out; only session-a.json remains
		expect(result.sessionId).toBe("session-a");
	});
});

describe("tracedPackages", () => {
	function makeGraph(pkgs: Array<{ name: string; dir: string }>): PackageGraph {
		return {
			packages: pkgs.map((p) => ({
				name: p.name,
				dir: p.dir,
				manifest: { name: p.name },
			})),
			edges: new Map(),
		};
	}

	it("returns an empty Set when trace has no modules", () => {
		const trace = makeTraceFile({ modules: [] });
		const graph = makeGraph([{ name: "web", dir: "/repo/packages/web" }]);
		expect(tracedPackages(trace, graph).size).toBe(0);
	});

	it("returns an empty Set when graph has no packages", () => {
		const trace = makeTraceFile({
			modules: [{ file: "/repo/packages/web/index.ts" }],
		});
		const graph = makeGraph([]);
		expect(tracedPackages(trace, graph).size).toBe(0);
	});

	it("returns package name when a module file is inside its dir", () => {
		const trace = makeTraceFile({
			modules: [{ file: "/repo/packages/utils/src/index.ts" }],
		});
		const graph = makeGraph([{ name: "utils", dir: "/repo/packages/utils" }]);
		const result = tracedPackages(trace, graph);
		expect(result.has("utils")).toBe(true);
		expect(result.size).toBe(1);
	});

	it("attributes a module to the first matching package only (break semantics)", () => {
		// When two packages could match, only the first in iteration order wins.
		// This test documents the "first match wins" behavior.
		const trace = makeTraceFile({
			modules: [{ file: "/repo/packages/utils/index.ts" }],
		});
		const graph = makeGraph([
			{ name: "utils", dir: "/repo/packages/utils" },
			{ name: "utils-alias", dir: "/repo/packages/utils" }, // same dir
		]);
		// Only "utils" should be in the result (first match)
		const result = tracedPackages(trace, graph);
		expect(result.size).toBe(1);
		expect(result.has("utils")).toBe(true);
	});

	it("collects multiple packages when modules span several packages", () => {
		const trace = makeTraceFile({
			modules: [
				{ file: "/repo/packages/utils/index.ts" },
				{ file: "/repo/packages/web/page.tsx" },
			],
		});
		const graph = makeGraph([
			{ name: "utils", dir: "/repo/packages/utils" },
			{ name: "web", dir: "/repo/packages/web" },
		]);
		const result = tracedPackages(trace, graph);
		expect(result.has("utils")).toBe(true);
		expect(result.has("web")).toBe(true);
		expect(result.size).toBe(2);
	});

	it("does not match a module outside any package dir", () => {
		const trace = makeTraceFile({
			modules: [{ file: "/repo/node_modules/react/index.js" }],
		});
		const graph = makeGraph([{ name: "web", dir: "/repo/packages/web" }]);
		expect(tracedPackages(trace, graph).size).toBe(0);
	});

	it("does NOT match sibling package with longer name via prefix (exposes BUG 2)", () => {
		// pkg.dir = "/repo/packages/utils"
		// file    = "/repo/packages/utils-extra/index.ts"
		// BUG: startsWith("/repo/packages/utils") is true for utils-extra paths
		// Fix: check startsWith(pkg.dir + "/") instead.
		const trace = makeTraceFile({
			modules: [{ file: "/repo/packages/utils-extra/index.ts" }],
		});
		const graph = makeGraph([
			{ name: "utils", dir: "/repo/packages/utils" },
			{ name: "utils-extra", dir: "/repo/packages/utils-extra" },
		]);
		const result = tracedPackages(trace, graph);
		// Should only match "utils-extra", NOT "utils"
		expect(result.has("utils")).toBe(false); // EXPECTED TO FAIL until BUG 2 is fixed
		expect(result.has("utils-extra")).toBe(true);
	});
});
