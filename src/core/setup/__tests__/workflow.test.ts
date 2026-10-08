import { describe, expect, it } from "vitest";
import {
	pullRequestWorkflow,
	runsTests,
	withFullHistory,
} from "../workflow.js";

describe("runsTests", () => {
	it.each([
		"      - run: pnpm test",
		"      - run: npm run test -- --coverage",
		"      - run: bun run test:web",
		"      - run: npx vitest run",
		"      - run: yarn jest --ci",
		"      - run: turbo run test",
		"      - run: nx affected -t test",
	])("recognises %s", (line) => {
		expect(runsTests(`jobs:\n  ci:\n    steps:\n${line}\n`)).toBe(true);
	});

	it("is not fooled by a workflow that only builds and lints", () => {
		expect(runsTests("steps:\n  - run: pnpm lint\n  - run: pnpm build\n")).toBe(
			false,
		);
	});

	it("ignores a test command that is commented out", () => {
		expect(runsTests("steps:\n  # - run: pnpm test\n")).toBe(false);
	});
});

describe("withFullHistory", () => {
	it("adds a with block to a checkout that has none", () => {
		expect(
			withFullHistory(
				[
					"    steps:",
					"      - uses: actions/checkout@v6",
					"      - uses: actions/setup-node@v6",
					"",
				].join("\n"),
			),
		).toBe(
			[
				"    steps:",
				"      - uses: actions/checkout@v6",
				"        with:",
				"          fetch-depth: 0",
				"      - uses: actions/setup-node@v6",
				"",
			].join("\n"),
		);
	});

	it("adds the key to a with block that lacks it, keeping what is there", () => {
		expect(
			withFullHistory(
				[
					"      - name: Check out",
					"        uses: actions/checkout@v6",
					"        with:",
					"          persist-credentials: false",
					"      - run: pnpm test",
				].join("\n"),
			),
		).toBe(
			[
				"      - name: Check out",
				"        uses: actions/checkout@v6",
				"        with:",
				"          fetch-depth: 0",
				"          persist-credentials: false",
				"      - run: pnpm test",
			].join("\n"),
		);
	});

	it("deepens a checkout that asks for a fixed number of commits", () => {
		expect(
			withFullHistory(
				[
					"      - uses: actions/checkout@v6",
					"        with:",
					"          fetch-depth: 2",
				].join("\n"),
			),
		).toBe(
			[
				"      - uses: actions/checkout@v6",
				"        with:",
				"          fetch-depth: 0",
			].join("\n"),
		);
	});

	it("leaves alone a workflow that already fetches everything", () => {
		expect(
			withFullHistory(
				[
					"      - uses: actions/checkout@v6",
					"        with:",
					"          fetch-depth: 0",
					"      - run: pnpm test",
				].join("\n"),
			),
		).toBeNull();
	});

	it("handles every checkout in a workflow with several jobs", () => {
		const result = withFullHistory(
			[
				"jobs:",
				"  lint:",
				"    steps:",
				"      - uses: actions/checkout@v6",
				"      - run: pnpm lint",
				"  test:",
				"    steps:",
				"      - uses: actions/checkout@v6",
				"      - run: pnpm test",
			].join("\n"),
		);
		expect(result?.match(/fetch-depth: 0/g)).toHaveLength(2);
	});
});

describe("pullRequestWorkflow", () => {
	it.each([
		["npm", "npm ci", "npx --no -- variant pr report"],
		["pnpm", "pnpm install --frozen-lockfile", "pnpm exec variant pr report"],
		["yarn", "yarn install --frozen-lockfile", "yarn variant pr report"],
		["bun", "bun install --frozen-lockfile", "bun run variant pr report"],
	] as const)("installs and runs the local binary with %s", (pm, install, exec) => {
		const workflow = pullRequestWorkflow(pm);
		expect(workflow).toContain(`- run: ${install}`);
		expect(workflow).toContain(exec);
		expect(workflow).toContain("fetch-depth: 0");
	});

	it("never fetches a package called variant from the registry", () => {
		for (const pm of ["npm", "pnpm", "yarn", "bun"] as const) {
			expect(pullRequestWorkflow(pm)).not.toMatch(/npx (?!--no )/);
		}
	});

	it("sets up the package managers that Node does not ship with", () => {
		expect(pullRequestWorkflow("pnpm")).toContain("pnpm/action-setup");
		expect(pullRequestWorkflow("bun")).toContain("oven-sh/setup-bun");
		expect(pullRequestWorkflow("npm")).not.toContain("action-setup");
	});
});
