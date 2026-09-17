import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { viteAdapter } from "../vite.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "variant-vite-test-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
	tmpDirs.length = 0;
});

describe("viteAdapter.detect", () => {
	it("returns true when vite is in dependencies", () => {
		const dir = makeTmpDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ dependencies: { vite: "5.0.0" } }),
		);
		expect(viteAdapter.detect(dir)).toBe(true);
	});

	it("returns true when vite is in devDependencies", () => {
		const dir = makeTmpDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
		);
		expect(viteAdapter.detect(dir)).toBe(true);
	});

	it("returns false when vite is absent", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "package.json"), JSON.stringify({}));
		expect(viteAdapter.detect(dir)).toBe(false);
	});

	it("returns false when package.json is missing", () => {
		const dir = makeTmpDir();
		expect(viteAdapter.detect(dir)).toBe(false);
	});

	it("returns false on malformed package.json", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "package.json"), "not json");
		expect(viteAdapter.detect(dir)).toBe(false);
	});
});

describe("viteAdapter commands", () => {
	it("devCommand returns 'vite'", () => {
		expect(viteAdapter.devCommand()).toBe("vite");
	});
	it("buildCommand returns 'vite build'", () => {
		expect(viteAdapter.buildCommand()).toBe("vite build");
	});
});
