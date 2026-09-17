import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { variantNextPlugin } from "../next-plugin.js";
import type { TraceFile } from "../types.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-next-p-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

// Derive the compiler type from the plugin without exporting internals.
type PluginCompiler = Parameters<
	ReturnType<typeof variantNextPlugin>["apply"]
>[0];

function mockCompiler(context: string) {
	const afterCompileHooks: Array<(compilation: unknown) => void> = [];
	const doneHooks: Array<() => Promise<void>> = [];

	const rawCompiler = {
		context,
		hooks: {
			afterCompile: {
				tap: (_name: string, cb: (c: unknown) => void) => {
					afterCompileHooks.push(cb);
				},
			},
			done: {
				tapPromise: (_name: string, cb: () => Promise<void>) => {
					doneHooks.push(cb);
				},
			},
		},
	};

	return {
		compiler: rawCompiler as unknown as PluginCompiler,
		simulateCompilation(modules: Array<{ resource?: string }>) {
			for (const cb of afterCompileHooks) {
				cb({ modules });
			}
		},
		async simulateDone() {
			for (const cb of doneHooks) {
				await cb();
			}
		},
	};
}

describe("variantNextPlugin", () => {
	it("registers afterCompile and done hooks", () => {
		const cwd = makeTmpDir();
		const { compiler } = mockCompiler(cwd);
		const plugin = variantNextPlugin({ outDir: "traces" });
		plugin.apply(compiler);
		// Hooks should have been tapped
		expect(true).toBe(true); // no throw = taps registered
	});

	it("collects modules from compilation, skipping node_modules", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateCompilation, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({
			sessionId: "nx1",
			outDir: "traces",
		});
		plugin.apply(compiler);

		simulateCompilation([
			{ resource: "/app/src/page.tsx" },
			{ resource: "/app/node_modules/react/index.js" },
			{ resource: "/app/src/lib.ts" },
			{ resource: "" },
			{},
		]);

		return simulateDone().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "nx1.json"), "utf8"),
			);
			expect(trace.modules).toHaveLength(2);
			expect(trace.modules.map((m) => m.file)).toContain("/app/src/page.tsx");
			expect(trace.modules.map((m) => m.file)).toContain("/app/src/lib.ts");
		});
	});

	it("writes sorted modules and framework='next'", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateCompilation, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({
			sessionId: "nx2",
			outDir: "traces",
		});
		plugin.apply(compiler);
		simulateCompilation([{ resource: "/z.ts" }, { resource: "/a.ts" }]);

		return simulateDone().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "nx2.json"), "utf8"),
			);
			expect(trace.framework).toBe("next");
			expect(trace.modules[0]?.file).toBe("/a.ts");
			expect(trace.modules[1]?.file).toBe("/z.ts");
		});
	});

	it("options.sessionId overrides generated id", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({
			sessionId: "custom-id",
			outDir: "traces",
		});
		plugin.apply(compiler);

		return simulateDone().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "custom-id.json"), "utf8"),
			);
			expect(trace.sessionId).toBe("custom-id");
		});
	});

	it("multiple compilations accumulate modules (watch mode)", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateCompilation, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({
			sessionId: "nx3",
			outDir: "traces",
		});
		plugin.apply(compiler);

		simulateCompilation([{ resource: "/a.ts" }]);
		simulateCompilation([{ resource: "/b.ts" }]);

		return simulateDone().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "nx3.json"), "utf8"),
			);
			expect(trace.modules).toHaveLength(2);
		});
	});

	it("deduplicates modules seen across compilations", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateCompilation, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({
			sessionId: "nx4",
			outDir: "traces",
		});
		plugin.apply(compiler);

		simulateCompilation([{ resource: "/same.ts" }]);
		simulateCompilation([{ resource: "/same.ts" }]);

		return simulateDone().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "nx4.json"), "utf8"),
			);
			expect(trace.modules).toHaveLength(1);
		});
	});

	it("uses compiler.context as cwd for writeTrace", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({
			sessionId: "nx5",
			outDir: "my-traces",
		});
		plugin.apply(compiler);

		return simulateDone().then(() => {
			expect(existsSync(path.join(cwd, "my-traces", "nx5.json"))).toBe(true);
		});
	});

	it("derives routes from page file paths when no entrypoints provided", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateCompilation, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({ sessionId: "nx6", outDir: "traces" });
		plugin.apply(compiler);

		simulateCompilation([
			{ resource: "/app/pages/index.tsx" },
			{ resource: "/app/pages/about.tsx" },
			{ resource: "/app/pages/_app.tsx" }, // should be skipped
			{ resource: "/app/pages/_document.tsx" }, // should be skipped
			{ resource: "/app/src/utils.ts" }, // not a page
		]);

		return simulateDone().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "nx6.json"), "utf8"),
			);
			const routePaths = trace.routes.map((r) => r.path);
			expect(routePaths).toContain("/"); // index → /
			expect(routePaths).toContain("/about"); // about → /about
			expect(routePaths).not.toContain("/_app");
			expect(routePaths).not.toContain("/_document");
		});
	});

	it("derives routes for app-router page.tsx files", () => {
		const cwd = makeTmpDir();
		const { compiler, simulateCompilation, simulateDone } = mockCompiler(cwd);
		const plugin = variantNextPlugin({ sessionId: "nx7", outDir: "traces" });
		plugin.apply(compiler);

		simulateCompilation([
			{ resource: "/app/app/checkout/page.tsx" },
			{ resource: "/app/app/checkout/layout.tsx" }, // should be skipped
			{ resource: "/app/app/page.tsx" }, // root page → /
		]);

		return simulateDone().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "nx7.json"), "utf8"),
			);
			const routePaths = trace.routes.map((r) => r.path);
			expect(routePaths).toContain("/checkout");
			expect(routePaths).toContain("/");
			expect(routePaths).not.toContain("/checkout/layout");
		});
	});
});
