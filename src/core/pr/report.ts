/**
 * @module
 * `variant pr report` — the `pr check` verdict in the two shapes CI consumes:
 * JSON for machines and markdown for a PR comment.
 */

import type { BuildVerdict } from "../semantic/verdict.js";
import type { PrCheckOptions, PrCheckResult } from "./check.js";
import { runPrCheck } from "./check.js";

export interface PrReportOptions extends PrCheckOptions {}

export interface PrReportResult {
	generatedAt: string;
	check: PrCheckResult;
}

export async function buildPrReport(
	cwd: string,
	options: PrReportOptions = {},
): Promise<PrReportResult> {
	const check = await runPrCheck(cwd, options);
	return { generatedAt: new Date().toISOString(), check };
}

const VERDICT_EMOJI: Record<BuildVerdict, string> = {
	"safe-to-skip": "✅",
	"build-recommended": "⚠️",
	"build-required": "🔴",
};

const VERDICT_HEADING: Record<BuildVerdict, string> = {
	"safe-to-skip": "Safe to skip build",
	"build-recommended": "Build recommended",
	"build-required": "Build required",
};

function symbolDelta(counts: {
	added: readonly unknown[];
	removed: readonly unknown[];
	changed: readonly unknown[];
}): string[] {
	const delta: string[] = [];
	if (counts.added.length > 0) delta.push(`+${counts.added.length}`);
	if (counts.removed.length > 0) delta.push(`-${counts.removed.length}`);
	if (counts.changed.length > 0) delta.push(`~${counts.changed.length}`);
	return delta;
}

export function formatPrReportJson(report: PrReportResult): string {
	return JSON.stringify(report, null, 2);
}

export function formatPrReportMarkdown(report: PrReportResult): string {
	const { check } = report;
	const lines: string[] = [
		"## Variant PR Report",
		"",
		`**Generated:** ${report.generatedAt}  `,
		`**Base ref:** \`${check.baseRef}\`  `,
		"",
		"### Semantic Diff",
		"",
		`${VERDICT_EMOJI[check.verdict]} **${VERDICT_HEADING[check.verdict]}**`,
		"",
	];

	if (check.files.length > 0) {
		lines.push(
			"| File | Classification | API Changes |",
			"|------|----------------|-------------|",
		);
		for (const file of check.files) {
			const delta = symbolDelta(file.exportedSymbols);
			lines.push(
				`| \`${file.filePath}\` | ${file.classification} | ${delta.join(" ") || "—"} |`,
			);
		}
		lines.push("");
	} else {
		lines.push("_No TypeScript files changed._", "");
	}

	return lines.join("\n");
}
