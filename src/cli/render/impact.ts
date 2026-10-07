import type { ImpactReport } from "../../core/impact/predict.js";
import type { VerifyResult } from "../../core/impact/verify.js";
import { verdictText } from "../../core/semantic/verdict.js";
import { getColors } from "../visuals/color.js";
import type { Printer } from "../visuals/printer.js";
import { getPrinter } from "../visuals/printer.js";
import { classificationLabel, plural } from "./labels.js";
import { lines } from "./writer.js";

/** Long change lists are truncated; the full set is in the JSON output. */
const MAX_LISTED_FILES = 20;

const count = (value: number): string => value.toLocaleString("en-US");

export const NO_PREDICTION_MESSAGE =
	"impact verify: no logged prediction to reconcile against. Run `variant impact` before the test run, or pass --head-sha for a specific commit.";

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
		`Workspace: ${report.packagesFound === 0 ? "no workspace packages found" : plural(report.packagesFound, "package")}`,
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
		`Run:   ${plural(tests.affectedTests.length, "test file")}`,
		`Skip:  ${plural(skipped, "test file")} (of ${count(tests.totalTests)} total)`,
	);

	if (tests.unreached.length > 0) {
		const listed = tests.unreached.slice(0, MAX_LISTED_FILES).join(", ");
		const more =
			tests.unreached.length > MAX_LISTED_FILES
				? `, … ${count(tests.unreached.length - MAX_LISTED_FILES)} more`
				: "";
		lines(
			printer,
			"",
			`${getColors().yellow("Unreached:")} ${plural(tests.unreached.length, "changed file")} that variant cannot analyze and no test imports (${listed}${more}). No test is selected for them; run the ones that use them yourself.`,
		);
	}

	lines(
		printer,
		"",
		`Verdict:    ${verdictText(report.verdict)}`,
		`Confidence: ${tests.resolution} (${Math.round(tests.confidence * 100)}%)  (report-only — run the full suite; skipping unlocks after shadow-mode validation)`,
	);

	const notes = [...radius.notes, ...tests.notes];
	if (notes.length > 0) {
		lines(printer, "", "Notes:");
		for (const note of notes) lines(printer, `  - ${note}`);
	}

	// Standing notes say the same thing on every run, so by default they are
	// one line: printed in full each time, they bury the notes about the change.
	const standing = [...radius.repositoryNotes, ...tests.repositoryNotes];
	if (standing.length > 0 && printer.mode === "verbose") {
		lines(printer, "", "Repository (the same whatever changed):");
		for (const note of standing) lines(printer, `  - ${note}`);
	} else if (standing.length > 0) {
		lines(
			printer,
			"",
			`Repository: ${plural(standing.length, "standing note")}, the same whatever changed (-v lists them)`,
		);
	}

	if (!report.historyLogged) {
		lines(
			printer,
			"",
			"(warning: could not write .variant/history/impact.jsonl — shadow-mode logging skipped)",
		);
	}
}

export function renderImpactVerifyJson(
	result: VerifyResult,
	printer: Printer = getPrinter(),
): void {
	const { prediction, ...rest } = result;
	lines(
		printer,
		JSON.stringify(
			{ ...rest, predictedAt: prediction.at, baseRef: prediction.baseRef },
			null,
			2,
		),
	);
}

export function renderImpactVerify(
	result: VerifyResult,
	printer: Printer = getPrinter(),
): void {
	const { prediction } = result;

	lines(
		printer,
		"",
		`Prediction: ${prediction.at} (${prediction.headSha ?? "no commit recorded"})`,
		`Matched by: ${result.matchedBy === "head-sha" ? "head SHA" : "most recent — verify this is the right run"}`,
		"",
		`Predicted:  ${count(prediction.affectedTests.length)} of ${count(prediction.totalTests)} test files${prediction.selectAll ? " (selected all)" : ""}`,
		`Ran:        ${plural(result.ranTests, "test file")}, ${count(result.predictedRan)} of them predicted`,
		`Failed:     ${plural(result.failedTests.length, "test file")}`,
	);

	if (result.failedTests.length === 0) {
		lines(
			printer,
			"",
			"No failures in this run, so it neither confirms nor refutes the prediction.",
		);
		return;
	}

	lines(
		printer,
		"",
		`Caught:      ${count(result.caught.length)} (inside the predicted set)`,
		`False skips: ${count(result.falseSkips.length)} (would have been missed)`,
	);

	if (result.falseSkips.length > 0) {
		lines(printer, "", "False skips:");
		for (const test of result.falseSkips.slice(0, MAX_LISTED_FILES)) {
			lines(printer, `  ${test}`);
		}
		if (result.falseSkips.length > MAX_LISTED_FILES) {
			lines(
				printer,
				`  … and ${count(result.falseSkips.length - MAX_LISTED_FILES)} more`,
			);
		}
	}

	lines(
		printer,
		"",
		`False-skip rate this run: ${(result.falseSkipRate * 100).toFixed(1)}%`,
		"One run is not a rate. Reconcile many before reading anything into it.",
	);

	if (!result.historyLogged) {
		lines(
			printer,
			"",
			"(warning: could not write .variant/history/reconciliation.jsonl)",
		);
	}
}
