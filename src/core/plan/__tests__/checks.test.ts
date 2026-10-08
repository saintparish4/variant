import { describe, expect, it } from "vitest";
import { planChecks } from "../checks.js";

const ROOT = { name: "root", dir: "", scripts: { lint: "biome check ." } };
const API = {
	name: "@x/api",
	dir: "packages/api",
	scripts: {
		build: "tsup",
		"check-types": "tsc --noEmit",
		dev: "tsx watch",
		test: "vitest run",
		"test:e2e": "playwright test",
	},
};

describe("planChecks", () => {
	it("lists typecheck, build, lint and end-to-end scripts, and nothing else", () => {
		const checks = planChecks([API], {
			packageManager: "pnpm",
			taskRunner: null,
		});

		expect(checks.map((check) => [check.kind, check.script])).toEqual([
			["typecheck", "check-types"],
			["build", "build"],
			["e2e", "test:e2e"],
		]);
	});

	it("writes each command the way the repository runs its scripts", () => {
		const command = (
			packageManager: "npm" | "pnpm" | "yarn" | "bun",
			taskRunner: "turborepo" | "nx" | null = null,
		) =>
			planChecks([API], { packageManager, taskRunner }).find(
				(check) => check.kind === "build",
			)?.command;

		expect(command("pnpm")).toBe("pnpm --filter @x/api run build");
		expect(command("npm")).toBe("npm run build --workspace @x/api");
		expect(command("yarn")).toBe("yarn workspace @x/api run build");
		expect(command("bun")).toBe("bun run --filter @x/api build");
		expect(command("pnpm", "turborepo")).toBe(
			"turbo run build --filter=@x/api",
		);
		expect(command("pnpm", "nx")).toBe("nx run @x/api:build");
	});

	it("runs a root script from the root, whatever task runner there is", () => {
		expect(
			planChecks([ROOT], { packageManager: "pnpm", taskRunner: "turborepo" }),
		).toMatchObject([{ kind: "lint", command: "pnpm run lint" }]);
	});

	it("falls back to npm when nothing says how the repository installs", () => {
		expect(
			planChecks([ROOT], { packageManager: null, taskRunner: null })[0]
				?.command,
		).toBe("npm run lint");
	});
});
