import type { ImpactReport } from "../../core/impact/predict.js";
import { verdictText } from "../../core/semantic/verdict.js";
import type { Printer } from "../visuals/printer.js";
import { getPrinter } from "../visuals/printer.js";
import { classificationLabel, plural } from "./labels.js";
import { lines } from "./writer.js";

/** Long change lists are truncated; the full set is in the JSON output. */
const MAX_LISTED_FILES = 20;

const count = (value: number): string => value.toLocaleString("en-US");

export const NO_CHANGED_FILES_MESSAGE =
	"impact: could not determine changed files (is this a git repository with at least one prior commit?). Pass --base <ref> against a valid ref.";

export function renderImpactJson(
	report: ImpactReport,
	printer: Printer = getPrinter(),
): void {
	const { result, ...rest } = report;
	lines(
		printer,
		JSON.stringify(
			{ ...rest, radius: result.radius, tests: result.tests },
			null,
			2,
		),
	);
}

export function renderImpact(
	report: ImpactReport,
	printer: Printer = getPrinter(),
): void {
	const { radius, tests } = report.result;

	lines(
		printer,
		"",
		`Base ref: ${report.baseRef}`,
		"",
		`You changed ${plural(radius.changed.length, "file")}.`,
	);

	for (const impact of radius.changed.slice(0, MAX_LISTED_FILES)) {
		const symbols =
			impact.impactedSymbols.length > 0
				? `  (${impact.impactedSymbols.join(", ")})`
				: "";
		lines(
			printer,
			`  ${classificationLabel(impact.classification)}  ${impact.filePath}${symbols}`,
		);
	}
	if (radius.changed.length > MAX_LISTED_FILES) {
		lines(
			printer,
			`  … and ${count(radius.changed.length - MAX_LISTED_FILES)} more`,
		);
	}

	const packages =
		radius.affectedPackages.length > 0
			? `, ${plural(radius.affectedPackages.length, "package")} (${radius.affectedPackages.join(", ")})`
			: "";
	lines(
		printer,
		"",
		`Impact: ${plural(radius.affectedFiles.length, "file")}${packages}`,
	);

	const skipped = tests.totalTests - tests.affectedTests.length;
	lines(
		printer,
		"",
		`Run:   ${count(tests.affectedTests.length)} test files`,
		`Skip:  ${count(skipped)} test files (of ${count(tests.totalTests)} total)`,
		"",
		`Verdict:    ${verdictText(report.verdict)}`,
		`Confidence: ${Math.round(tests.confidence * 100)}%  (report-only — run the full suite; skipping unlocks after shadow-mode validation)`,
	);

	const notes = [...radius.notes, ...tests.notes];
	if (notes.length > 0) {
		lines(printer, "", "Notes:");
		for (const note of notes) lines(printer, `  - ${note}`);
	}

	if (!report.historyLogged) {
		lines(
			printer,
			"",
			"(warning: could not write .variant/history/impact.jsonl — shadow-mode logging skipped)",
		);
	}
}
