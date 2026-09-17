/**
 * Boundary: `trace` and `trace analyze` meeting real session files on disk.
 * The summarizing and rendering they delegate to are unit-tested beside their
 * sources; what is only testable here is that the command finds the session,
 * runs the dev task, and wires the two together.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerTraceAction,
	registerTraceAnalyzeAction,
} from "../../cli/commands/trace.js";
import type { TraceFile } from "../../tracer/types.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createTempWorkspace,
	restoreGlobalPrinter,
	withCwd,
	writeFiles,
} from "../helpers/cli-harness.js";

function trace(overrides: Partial<TraceFile> = {}): TraceFile {
	return {
		schemaVersion: 1,
		sessionId: "sess-001",
		startedAt: Date.now() - 5000,
		endedAt: Date.now(),
		framework: "next",
		modules: [],
		routes: [],
		...overrides,
	};
}

function workspaceWithSession(session: TraceFile): string {
	const dir = createTempWorkspace("trace");
	writeFiles(dir, {
		"variant.config.json": JSON.stringify({ tasks: { dev: {} } }),
		[`.variant/traces/${session.sessionId}.json`]: JSON.stringify(session),
	});
	return dir;
}

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
});

describe("trace analyze command", () => {
	it("prints the session header for a minimal trace", async () => {
		const dir = workspaceWithSession(
			trace({ sessionId: "sess-001", framework: "vite" }),
		);
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerTraceAnalyzeAction("sess-001"));

		expect(output.stdout()).toContain("sess-001");
		expect(output.stdout()).toContain("vite");
		expect(output.stdout()).toContain("Modules");
		expect(output.stdout()).toContain("Routes");
	});

	it("lists traced routes with their module counts", async () => {
		const dir = workspaceWithSession(
			trace({
				sessionId: "with-routes",
				routes: [
					{ path: "/home", modules: ["src/home.ts", "src/layout.ts"] },
					{ path: "/checkout", modules: ["src/checkout.ts"] },
				],
			}),
		);
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerTraceAnalyzeAction("with-routes"));

		expect(output.stdout()).toContain("/home");
		expect(output.stdout()).toContain("2 modules");
		expect(output.stdout()).toContain("/checkout");
		expect(output.stdout()).toContain("1 module");
	});

	it("defaults to the most recent session", async () => {
		const dir = workspaceWithSession(trace({ sessionId: "the-only-session" }));
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerTraceAnalyzeAction());

		expect(output.stdout()).toContain("the-only-session");
	});

	it("breaks modules down by workspace package", async () => {
		const dir = createTempWorkspace("trace");
		const moduleFile = path.join(dir, "packages", "mylib", "index.ts");
		writeFiles(dir, {
			"variant.config.json": JSON.stringify({ tasks: { dev: {} } }),
			"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
			"packages/mylib/package.json": JSON.stringify({ name: "mylib" }),
			"packages/mylib/index.ts": "export const value = 1;\n",
			".variant/traces/with-pkg.json": JSON.stringify(
				trace({ sessionId: "with-pkg", modules: [{ file: moduleFile }] }),
			),
		});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerTraceAnalyzeAction("with-pkg"));

		expect(output.stdout()).toContain("Packages touched");
		expect(output.stdout()).toContain("mylib");
	});
});

describe("trace command", () => {
	it("runs the dev task with tracing enabled", async () => {
		const dir = createTempWorkspace("trace");
		writeFiles(dir, {
			"variant.config.json": JSON.stringify({
				tasks: { dev: { command: "echo dev-trace-ok" } },
				cache: { directory: path.join(dir, ".variant/cache") },
			}),
		});
		const previous = process.env["VARIANT_TRACE"];
		captureGlobalOutput();

		try {
			await expect(
				withCwd(dir, () => registerTraceAction()),
			).resolves.toBeUndefined();
			expect(process.env["VARIANT_TRACE"]).toBe("1");
		} finally {
			// Assigning `undefined` would leak the string "undefined" into later
			// tests, and `delete` is banned by the linter.
			if (previous === undefined) {
				Reflect.deleteProperty(process.env, "VARIANT_TRACE");
			} else {
				process.env["VARIANT_TRACE"] = previous;
			}
		}
	});
});
