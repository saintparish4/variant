/**
 * @module
 * `variant pr report` — what a pull request changes and what has to be
 * verified before it merges, as JSON for machines and markdown for a comment.
 */

import type { VerificationPlan } from "../plan/plan.js";
import { buildVerificationPlan } from "../plan/plan.js";
import type { PrCheckOptions, PrCheckResult } from "./check.js";
import { runPrCheck } from "./check.js";

export interface PrReportOptions extends PrCheckOptions {}

export interface PrReportResult {
	generatedAt: string;
	check: PrCheckResult;
	plan: VerificationPlan;
}

export async function buildPrReport(
	cwd: string,
	options: PrReportOptions = {},
): Promise<PrReportResult> {
	const check = await runPrCheck(cwd, options);
	// The same files and the same base as the check, so the two halves of
	// one report cannot describe different changes.
	const plan = await buildVerificationPlan(cwd, {
		base: check.baseRef,
		changedFiles: check.changedFiles,
	});
	return { generatedAt: new Date().toISOString(), check, plan };
}

export function formatPrReportJson(report: PrReportResult): string {
	return JSON.stringify(report, null, 2);
}

/** Rows and list items shown before the rest fold into a count. */
const MAX_ROWS = 25;
const MAX_INLINE = 5;

const count = (value: number, noun: string): string =>
	`${value} ${noun}${value === 1 ? "" : "s"}`;

const code = (text: string): string => `\`${text}\``;

function inline(items: readonly string[]): string {
	const shown = items.slice(0, MAX_INLINE).map(code).join(", ");
	return items.length > MAX_INLINE
		? `${shown} and ${items.length - MAX_INLINE} more`
		: shown;
}

function capped(rows: readonly string[], noun: string): string[] {
	if (rows.length <= MAX_ROWS) return [...rows];
	return [
		...rows.slice(0, MAX_ROWS),
		`_…and ${count(rows.length - MAX_ROWS, noun)} more, in the JSON report._`,
	];
}

const RUNNER_NAME = {
	vitest: "Vitest",
	jest: "Jest",
	playwright: "Playwright",
	unknown: "Tests",
};

function changeRows(plan: VerificationPlan): string[] {
	return plan.changes.map((change) => {
		const kind = change.additive ? "new exports" : change.classification;
		const what =
			change.symbols.length > 0 ? `${kind}: ${inline(change.symbols)}` : kind;
		const reach = [count(change.dependents, "file")];
		if (change.crossesInto.length > 0) {
			reach.push(`into ${inline(change.crossesInto)}`);
		}
		reach.push(count(change.tests, "test file"));
		// Nothing imports a lockfile or a workflow. "0 files" there would read
		// as a finding when it is only what such a file is.
		const reached =
			change.dependents === 0 && change.tests === 0 && change.risk !== "high"
				? "—"
				: reach.join(", ");
		return `| **${change.risk}** | ${code(change.filePath)} | ${what} | ${reached} | ${change.reason} |`;
	});
}

function testLines(plan: VerificationPlan): string[] {
	const { tests } = plan;
	if (tests.total === 0) {
		return ["**Tests:** variant found no TypeScript test files here.", ""];
	}
	const lines = [
		tests.all
			? `**Tests:** all ${count(tests.total, "test file")}.`
			: `**Tests:** ${tests.selected} of ${count(tests.total, "test file")}.`,
		"",
	];
	for (const run of tests.runs) {
		const where = run.dir === "" ? "" : ` in ${code(run.dir)}`;
		const how =
			run.command === undefined ? "" : `, run by ${code(run.command)}`;
		lines.push(
			`- ${RUNNER_NAME[run.runner]}${where}: ${count(run.files.length, "file")}${how}`,
		);
	}
	if (tests.runs.some((run) => run.runner === "jest")) {
		lines.push(
			"",
			"variant has no Jest adapter yet, so Jest runs are not compared with this plan.",
		);
	}
	if (tests.runs.length > 0) lines.push("");

	const chains = Object.values(tests.why);
	if (chains.length > 0) {
		lines.push(
			"<details><summary>Why these tests</summary>",
			"",
			"Each line is the import chain from a test to a file this change touches.",
			"",
			...capped(
				chains.map((chain) =>
					chain.length === 1
						? `- ${code(chain[0] ?? "")} is itself changed`
						: `- ${chain.map(code).join(" → ")}`,
				),
				"test",
			),
			"",
			"</details>",
			"",
		);
	}
	return lines;
}

export function formatPrReportMarkdown(report: PrReportResult): string {
	const { plan } = report;
	const lines: string[] = [
		"## Variant PR Report",
		"",
		`${count(plan.changes.length, "changed file")} against ${code(plan.baseRef)}.`,
		"",
	];

	if (plan.changes.length === 0) {
		lines.push("_Nothing changed against the base._", "");
		return lines.join("\n");
	}

	lines.push(
		"### What changed",
		"",
		"| Risk | File | Change | Reached by | Why |",
		"|------|------|--------|------------|-----|",
		...capped(changeRows(plan), "file"),
		"",
		"### What to verify",
		"",
		...testLines(plan),
	);

	if (plan.checks.length > 0) {
		lines.push(
			"**Checks** in the packages this change affects:",
			"",
			...capped(
				plan.checks.map((check) => `- ${check.kind}: ${code(check.command)}`),
				"check",
			),
			"",
		);
	}

	if (plan.widened.length > 0) {
		lines.push(
			"**Wider than the import graph:**",
			"",
			...plan.widened.map((reason) => `- ${reason}`),
			"",
		);
	}

	lines.push("### Not verified", "");
	if (plan.notVerified.length === 0) {
		lines.push(
			plan.tests.total === 0
				? "_With no test files found, nothing here is verified by a test._"
				: `_Every changed source file is reached by at least one test in the plan.${
						plan.changes.some(
							(change) => change.tests === 0 && change.risk !== "none",
						)
							? " Configuration and housekeeping files are not counted: no test imports them."
							: ""
					}_`,
			"",
		);
	} else {
		lines.push(
			...capped(
				plan.notVerified.map((entry) => {
					const names =
						entry.symbols.length > 0 ? ` (${inline(entry.symbols)})` : "";
					const users =
						entry.usedBy.length > 0
							? ` Imported by ${inline(entry.usedBy)}.`
							: " Nothing variant indexes imports it.";
					return `- ${code(entry.filePath)}${names}: ${entry.reason}.${users}`;
				}),
				"file",
			),
			"",
		);
	}

	lines.push(
		`<sub>Graph resolution: ${plan.resolution}. It says how much of this change variant could follow, not how safe the change is. Reaching a file is not the same as testing what changed in it.</sub>`,
		"",
	);
	if (plan.notes.length > 0) {
		lines.push(
			"<details><summary>Notes</summary>",
			"",
			...plan.notes.map((note) => `- ${note}`),
			"",
			"</details>",
			"",
		);
	}

	return lines.join("\n");
}
