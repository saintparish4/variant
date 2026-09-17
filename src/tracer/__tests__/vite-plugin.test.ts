import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceFile } from "../types.js";
import { variantVitePlugin } from "../vite-plugin.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-vite-p-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

describe("variantVitePlugin", () => {
	it("has name 'variant-tracer'", () => {
		const plugin = variantVitePlugin();
		expect(plugin.name).toBe("variant-tracer");
	});

	it("transform returns null (does not modify code)", () => {
		const plugin = variantVitePlugin();
		const result = plugin.transform?.("const x = 1;", "/app/src/main.ts");
		expect(result).toBeNull();
	});

	it("transform collects non-node_modules ids", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s1", outDir: "traces" });
		plugin.configResolved?.({ root: cwd });
		plugin.transform?.("", "/app/src/a.ts");
		plugin.transform?.("", "/app/src/b.ts");
		plugin.transform?.("", "/app/node_modules/dep/index.js");
		// closeBundle writes the trace — verify only non-node_modules are included
		return plugin.closeBundle?.().then(async () => {
			const traceRaw = await readFile(
				path.join(cwd, "traces", "s1.json"),
				"utf8",
			);
			const trace: TraceFile = JSON.parse(traceRaw);
			expect(trace.modules).toHaveLength(2);
			expect(trace.modules.map((m) => m.file)).not.toContain(
				"/app/node_modules/dep/index.js",
			);
		});
	});

	it("transform strips query parameters from ids", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s2", outDir: "traces" });
		plugin.configResolved?.({ root: cwd });
		plugin.transform?.("", "/app/src/comp.vue?vue&type=script");
		return plugin.closeBundle?.().then(async () => {
			const traceRaw = await readFile(
				path.join(cwd, "traces", "s2.json"),
				"utf8",
			);
			const trace: TraceFile = JSON.parse(traceRaw);
			expect(trace.modules[0]?.file).toBe("/app/src/comp.vue");
		});
	});

	it("configResolved updates root used by closeBundle", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s3", outDir: "out" });
		plugin.configResolved?.({ root: cwd });
		plugin.transform?.("", "/x.ts");
		return plugin.closeBundle?.().then(() => {
			expect(existsSync(path.join(cwd, "out", "s3.json"))).toBe(true);
		});
	});

	it("closeBundle writes sorted modules and correct metadata", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s4", outDir: "traces" });
		plugin.configResolved?.({ root: cwd });
		plugin.transform?.("", "/z.ts");
		plugin.transform?.("", "/a.ts");
		return plugin.closeBundle?.().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "s4.json"), "utf8"),
			);
			expect(trace.framework).toBe("vite");
			expect(trace.schemaVersion).toBe(1);
			expect(trace.modules[0]?.file).toBe("/a.ts");
			expect(trace.modules[1]?.file).toBe("/z.ts");
			expect(trace.endedAt).toBeGreaterThanOrEqual(trace.startedAt);
		});
	});

	it("options.sessionId overrides generated id", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({
			sessionId: "my-id",
			outDir: "traces",
		});
		plugin.configResolved?.({ root: cwd });
		return plugin.closeBundle?.().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "my-id.json"), "utf8"),
			);
			expect(trace.sessionId).toBe("my-id");
		});
	});

	it("deduplicates the same module id seen multiple times", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s5", outDir: "traces" });
		plugin.configResolved?.({ root: cwd });
		plugin.transform?.("", "/app/same.ts");
		plugin.transform?.("", "/app/same.ts");
		plugin.transform?.("", "/app/same.ts");
		return plugin.closeBundle?.().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "s5.json"), "utf8"),
			);
			expect(trace.modules).toHaveLength(1);
		});
	});

	it("generateBundle populates routes from entry chunks", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s6", outDir: "traces" });
		plugin.configResolved?.({ root: cwd });

		plugin.generateBundle?.(undefined, {
			"checkout-abc123.js": {
				type: "chunk",
				isEntry: true,
				facadeModuleId: `${cwd}/pages/checkout.tsx`,
				moduleIds: [
					`${cwd}/pages/checkout.tsx`,
					`${cwd}/src/components/CartSummary.tsx`,
					`${cwd}/node_modules/react/index.js`,
				],
			},
			"about-def456.js": {
				type: "chunk",
				isEntry: true,
				facadeModuleId: `${cwd}/pages/about.tsx`,
				moduleIds: [`${cwd}/pages/about.tsx`],
			},
			"logo.svg": {
				type: "asset",
			},
		});

		return plugin.closeBundle?.().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "s6.json"), "utf8"),
			);
			const routePaths = trace.routes.map((r) => r.path);
			expect(routePaths).toContain("/checkout");
			expect(routePaths).toContain("/about");

			const checkout = trace.routes.find((r) => r.path === "/checkout");
			expect(checkout?.modules).toContain(`${cwd}/pages/checkout.tsx`);
			expect(checkout?.modules).toContain(
				`${cwd}/src/components/CartSummary.tsx`,
			);
			// node_modules must be excluded
			expect(checkout?.modules).not.toContain(
				`${cwd}/node_modules/react/index.js`,
			);
		});
	});

	it("generateBundle skips non-entry chunks and asset chunks", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s7", outDir: "traces" });
		plugin.configResolved?.({ root: cwd });

		plugin.generateBundle?.(undefined, {
			"vendor-abc.js": {
				type: "chunk",
				isEntry: false, // not an entry — skip
				facadeModuleId: `${cwd}/pages/home.tsx`,
				moduleIds: [`${cwd}/pages/home.tsx`],
			},
			"style.css": {
				type: "asset", // asset — skip
			},
		});

		return plugin.closeBundle?.().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "s7.json"), "utf8"),
			);
			expect(trace.routes).toHaveLength(0);
		});
	});

	it("generateBundle ignores entry chunks with no matching route convention", () => {
		const cwd = makeTmpDir();
		const plugin = variantVitePlugin({ sessionId: "s8", outDir: "traces" });
		plugin.configResolved?.({ root: cwd });

		// facadeModuleId is under src/ but NOT under pages/routes/views
		plugin.generateBundle?.(undefined, {
			"main-abc.js": {
				type: "chunk",
				isEntry: true,
				facadeModuleId: `${cwd}/src/main.tsx`,
				moduleIds: [`${cwd}/src/main.tsx`],
			},
		});

		return plugin.closeBundle?.().then(async () => {
			const trace: TraceFile = JSON.parse(
				await readFile(path.join(cwd, "traces", "s8.json"), "utf8"),
			);
			expect(trace.routes).toHaveLength(0);
		});
	});
});
