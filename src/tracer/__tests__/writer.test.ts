import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceFile } from "../types.js";
import { newSessionId, writeTrace } from "../writer.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-tracer-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

function makeTrace(overrides: Partial<TraceFile> = {}): TraceFile {
	return {
		schemaVersion: 1,
		sessionId: "test-session",
		startedAt: 1000,
		endedAt: 2000,
		framework: "vite",
		modules: [{ file: "src/index.ts" }],
		routes: [],
		...overrides,
	};
}

describe("writeTrace", () => {
	it("writes valid JSON to <outDir>/<sessionId>.json", async () => {
		const cwd = makeTmpDir();
		const trace = makeTrace();
		const result = await writeTrace(cwd, trace);
		expect(existsSync(result)).toBe(true);
		const parsed = JSON.parse(readFileSync(result, "utf8"));
		expect(parsed.sessionId).toBe("test-session");
		expect(parsed.modules).toHaveLength(1);
	});

	it("uses default outDir (.variant/traces) when none provided", async () => {
		const cwd = makeTmpDir();
		const result = await writeTrace(cwd, makeTrace());
		expect(result).toContain(".variant");
		expect(result).toContain("traces");
	});

	it("respects custom outDir", async () => {
		const cwd = makeTmpDir();
		const result = await writeTrace(cwd, makeTrace(), "custom/traces");
		expect(result).toContain("custom");
		expect(result).toContain("traces");
	});

	it("atomic write: no .tmp file left behind on success", async () => {
		const cwd = makeTmpDir();
		const result = await writeTrace(cwd, makeTrace());
		expect(existsSync(`${result}.tmp`)).toBe(false);
	});

	it("creates nested outDir recursively", async () => {
		const cwd = makeTmpDir();
		const deep = "a/b/c/traces";
		const result = await writeTrace(cwd, makeTrace(), deep);
		expect(existsSync(result)).toBe(true);
	});

	it("overwrites existing trace with same sessionId", async () => {
		const cwd = makeTmpDir();
		const trace1 = makeTrace({ modules: [{ file: "a.ts" }] });
		const trace2 = makeTrace({ modules: [{ file: "b.ts" }] });
		await writeTrace(cwd, trace1);
		const result = await writeTrace(cwd, trace2);
		const parsed = JSON.parse(readFileSync(result, "utf8"));
		expect(parsed.modules[0].file).toBe("b.ts");
	});
});

describe("newSessionId", () => {
	it("returns a string with a hyphen separator", () => {
		const id = newSessionId();
		expect(id).toContain("-");
		expect(id.length).toBeGreaterThan(8);
	});

	it("generates unique ids on rapid successive calls", () => {
		const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
		expect(ids.size).toBe(100);
	});

	it("is lexicographically orderable (timestamp prefix)", () => {
		const id1 = newSessionId();
		// Advance time slightly
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 1000);
		const id2 = newSessionId();
		vi.useRealTimers();
		expect(id2 > id1).toBe(true);
	});
});
