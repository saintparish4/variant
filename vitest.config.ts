import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		passWithNoTests: true,
		// Deliberately not `enabled: true`. Thresholds are global, so a
		// single-file run would fail four of them while measuring nothing
		// useful. Coverage is opt-in via `--coverage` (`pnpm test:all`, and
		// the CI coverage job), which is the only place it gates anything.
		coverage: {
			provider: "v8",
			include: ["src/core/**", "src/cli/**"],
			exclude: ["**/__tests__/**", "**/types.ts", "src/types/**"],
			thresholds: {
				lines: 70,
				functions: 70,
				branches: 60,
				statements: 70,
			},
			reporter: ["text", "lcov"],
		},
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["src/**/__tests__/**/*.test.ts"],
					exclude: ["src/__tests__/integration/**", "src/__tests__/e2e/**"],
					testTimeout: 15_000,
				},
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: ["src/__tests__/integration/**/*.integration.test.ts"],
					testTimeout: 30_000,
					// Setup in this tier builds fixture workspaces and git repos —
					// the same order of work as the tests, so it gets the same budget
					// rather than vitest's 10s hook default.
					hookTimeout: 30_000,
				},
			},
			{
				extends: true,
				test: {
					name: "e2e",
					include: ["src/__tests__/e2e/**/*.e2e.test.ts"],
					// Spawns the built dist/cli.js against fixture workspaces; a cold
					// build plus git setup runs well past the integration budget.
					testTimeout: 60_000,
					// The heaviest work in this tier is in beforeAll, not the test:
					// copy a fixture, `git init`, two commits, then a full cold CLI
					// run to warm the cache. That is five subprocess spawns, which
					// blows vitest's 10s hook default on Windows every time.
					hookTimeout: 60_000,
				},
			},
		],
	},
});
