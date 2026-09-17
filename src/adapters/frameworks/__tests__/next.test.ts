import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DetectionContext } from "../../../core/plugins/types.js";
import { nextAdapter, nextPlugin } from "../next.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "variant-next-test-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
	tmpDirs.length = 0;
});

describe("nextAdapter.detect", () => {
	it("returns true when next is in dependencies", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ dependencies: { next: "14.0.0" } }),
		);
		expect(await nextAdapter.detect(dir)).toBe(true);
	});

	it("returns true when next is in devDependencies", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { next: "14.0.0" } }),
		);
		expect(await nextAdapter.detect(dir)).toBe(true);
	});

	it("returns true when next is in peerDependencies", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ peerDependencies: { next: "14.0.0" } }),
		);
		expect(await nextAdapter.detect(dir)).toBe(true);
	});

	it("returns false when next is missing entirely", async () => {
		const dir = makeTmpDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ dependencies: { react: "18.0.0" } }),
		);
		expect(await nextAdapter.detect(dir)).toBe(false);
	});

	it("returns false when package.json does not exist", async () => {
		const dir = makeTmpDir();
		expect(await nextAdapter.detect(dir)).toBe(false);
	});

	it("returns false on malformed package.json (does not throw)", async () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "package.json"), "{ this is not json");
		expect(await nextAdapter.detect(dir)).toBe(false);
	});

	it("returns false when both dep blocks are missing", async () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
		expect(await nextAdapter.detect(dir)).toBe(false);
	});
});

describe("nextAdapter commands", () => {
	it("devCommand returns 'next dev'", () => {
		expect(nextAdapter.devCommand()).toBe("next dev");
	});
	it("buildCommand returns 'next build'", () => {
		expect(nextAdapter.buildCommand()).toBe("next build");
	});
});

describe("nextPlugin", () => {
	it("registers per-app build tasks when apps/<name> has next.config", async () => {
		const dir = makeTmpDir();
		const apps = join(dir, "apps", "web");
		mkdirSync(apps, { recursive: true });
		writeFileSync(join(apps, "next.config.mjs"), "export default {};\n");

		const ctx: DetectionContext = {
			cwd: dir,
			pm: "pnpm",
			framework: "next",
			tasks: {},
		};
		await nextPlugin.hooks?.onDetect?.(ctx);

		expect(ctx.tasks["web:build"]).toEqual({
			command: `${ctx.pm} --filter web run build`,
			inputs: ["apps/web/**/*.{ts,tsx,js,jsx,json,css}"],
		});
	});
});
