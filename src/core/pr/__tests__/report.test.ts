import { describe, expect, it } from "vitest";
import type { PlannedChange, VerificationPlan } from "../../plan/plan.js";
import type { PrReportResult } from "../report.js";
import { formatPrReportJson, formatPrReportMarkdown } from "../report.js";

function change(overrides: Partial<PlannedChange> = {}): PlannedChange {
	return {
		filePath: "src/math.ts",
		classification: "internal",
		symbols: [],
		dependents: 2,
		crossesInto: [],
		tests: 1,
		risk: "low",
		reason: "implementation only, and tests reach it",
		...overrides,
	};
}

function report(plan: Partial<VerificationPlan> = {}): PrReportResult {
	return {
		generatedAt: "2026-01-01T00:00:00.000Z",
		check: {
			baseRef: "main",
			changedFiles: [],
			tsFilesChanged: 0,
			files: [],
			verdict: "safe-to-skip",
		},
		plan: {
			baseRef: "main",
			baseLabel: "main",
			changes: [change()],
			tests: {
				selected: 1,
				total: 4,
				all: false,
				runs: [{ runner: "vitest", dir: "", files: ["src/math.test.ts"] }],
				why: { "src/math.test.ts": ["src/math.test.ts", "src/math.ts"] },
			},
			checks: [],
			widened: [],
			notVerified: [],
			resolution: "high",
			notes: [],
			repositoryNotes: [],
			...plan,
		},
	};
}

const markdown = (plan: Partial<VerificationPlan> = {}): string =>
	formatPrReportMarkdown(report(plan));

describe("formatPrReportJson", () => {
	it("round-trips through JSON.parse, plan included", () => {
		const parsed = JSON.parse(formatPrReportJson(report())) as PrReportResult;

		expect(parsed.check.baseRef).toBe("main");
		expect(parsed.plan.tests.selected).toBe(1);
	});
});

describe("formatPrReportMarkdown", () => {
	it("opens with the line a workflow finds its comment by", () => {
		expect(markdown().startsWith("## Variant PR Report\n")).toBe(true);
	});

	it("says so plainly when nothing changed", () => {
		expect(markdown({ changes: [] })).toContain(
			"_Nothing changed against the base._",
		);
	});

	it("gives each changed file its risk, its reach and the rule behind the risk", () => {
		const text = markdown({
			changes: [
				change({
					classification: "breaking",
					symbols: ["add"],
					crossesInto: ["@x/web"],
					risk: "high",
					reason: "its exports changed, and other packages import it",
				}),
			],
		});

		expect(text).toContain(
			"| **high** | `src/math.ts` | breaking: `add` | 2 files, into `@x/web`, 1 test file | its exports changed, and other packages import it |",
		);
	});

	it("lists the tests to run by runner, and why each is there", () => {
		const text = markdown();

		expect(text).toContain("**Tests:** 1 of 4 test files.");
		expect(text).toContain("- Vitest: 1 file");
		expect(text).toContain("- `src/math.test.ts` → `src/math.ts`");
	});

	it("says a changed test is in the plan because it changed", () => {
		expect(
			markdown({
				tests: {
					selected: 1,
					total: 4,
					all: false,
					runs: [],
					why: { "src/math.test.ts": ["src/math.test.ts"] },
				},
			}),
		).toContain("- `src/math.test.ts` is itself changed");
	});

	it("lists the checks as commands", () => {
		expect(
			markdown({
				checks: [
					{
						kind: "typecheck",
						package: "@x/web",
						dir: "packages/web",
						script: "typecheck",
						command: "pnpm --filter @x/web run typecheck",
					},
				],
			}),
		).toContain("- typecheck: `pnpm --filter @x/web run typecheck`");
	});

	it("says where the plan is wider than the import graph", () => {
		const text = markdown({ widened: ["pnpm-lock.yaml changed: every test"] });

		expect(text).toContain("**Wider than the import graph:**");
		expect(text).toContain("- pnpm-lock.yaml changed: every test");
	});

	it("names what nothing verifies, with its symbols and who imports it", () => {
		expect(
			markdown({
				notVerified: [
					{
						filePath: "src/billing.ts",
						symbols: ["charge"],
						usedBy: ["src/checkout.ts"],
						reason: "no test reaches it",
					},
				],
			}),
		).toContain(
			"- `src/billing.ts` (`charge`): no test reaches it. Imported by `src/checkout.ts`.",
		);
	});

	it("does not call a change verified when there are no tests at all", () => {
		const text = markdown({
			tests: { selected: 0, total: 0, all: false, runs: [], why: {} },
		});

		expect(text).toContain("variant found no TypeScript test files here.");
		expect(text).not.toContain("Every changed file is reached");
	});

	it("never presents graph resolution as a safety figure", () => {
		const text = markdown();

		expect(text).toContain("Graph resolution: high.");
		expect(text).toContain("not how safe the change is");
		expect(text).not.toMatch(/\d+%/);
	});

	it("folds a long change list into a count", () => {
		const changes = Array.from({ length: 30 }, (_, index) =>
			change({ filePath: `src/file-${index}.ts` }),
		);

		expect(markdown({ changes })).toContain("_…and 5 files more");
	});
});
