import { describe, expect, it } from "vitest";
import {
	DEFAULT_TASK_INPUTS,
	defaultCommandFor,
	inputsFor,
	renderConfigTemplate,
} from "../config-template.js";

describe("defaultCommandFor", () => {
	it("uses the package manager's run form for an ordinary task", () => {
		expect(defaultCommandFor("pnpm", "lint", null)).toBe("pnpm lint");
		expect(defaultCommandFor("yarn", "lint", null)).toBe("yarn lint");
	});

	it("falls back to `npm run` for npm and unknown managers", () => {
		expect(defaultCommandFor("npm", "lint", null)).toBe("npm run lint");
		expect(defaultCommandFor("bun", "lint", null)).toBe("npm run lint");
	});

	it("invokes the framework binary directly for a framework build", () => {
		expect(defaultCommandFor("pnpm", "build", "next")).toBe("pnpm next build");
		expect(defaultCommandFor("pnpm", "build", "vite")).toBe("pnpm vite build");
	});

	it("reaches for npx when the manager has no binary runner of its own", () => {
		expect(defaultCommandFor("npm", "build", "next")).toBe("npx next build");
	});

	it("only special-cases build, not other tasks, for a framework", () => {
		expect(defaultCommandFor("pnpm", "test", "next")).toBe("pnpm test");
	});
});

describe("inputsFor", () => {
	it("returns the task's own defaults when it has them", () => {
		expect(inputsFor("typecheck")).toEqual(DEFAULT_TASK_INPUTS["typecheck"]);
	});

	it("falls back to the build defaults for an unknown task", () => {
		expect(inputsFor("deploy")).toEqual(DEFAULT_TASK_INPUTS["build"]);
	});
});

describe("renderConfigTemplate", () => {
	it("emits a defineConfig module importing from variant", () => {
		const template = renderConfigTemplate([
			{ name: "build", command: "pnpm build", inputs: ["src/**/*"] },
		]);

		expect(template).toContain(
			'import { defineConfig } from "@blzsky/variant";',
		);
		expect(template).toContain("export default defineConfig({");
		expect(template).toContain('strategy: "adaptive"');
	});

	it("writes each task with its command and inputs", () => {
		const template = renderConfigTemplate([
			{ name: "build", command: "pnpm build", inputs: ["src/**/*", "p.json"] },
		]);

		expect(template).toContain('command: "pnpm build"');
		expect(template).toContain('inputs: ["src/**/*", "p.json"]');
	});

	it("separates multiple tasks so the output stays valid TypeScript", () => {
		const template = renderConfigTemplate([
			{ name: "build", command: "pnpm build", inputs: [] },
			{ name: "lint", command: "pnpm lint", inputs: [] },
		]);

		expect(template).toContain("build: {");
		expect(template).toContain("lint: {");
		expect(template).toContain("},\n    lint");
	});
});
