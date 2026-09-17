import type { PrCheckResult } from "../../core/pr/check.js";
import { verdictText } from "../../core/semantic/verdict.js";
import type { Printer } from "../visuals/printer.js";
import { getPrinter } from "../visuals/printer.js";
import { classificationLabel } from "./labels.js";
import { lines } from "./writer.js";

function symbolSummary(symbols: {
	added: readonly unknown[];
	removed: readonly unknown[];
	changed: readonly unknown[];
}): string {
	const changes: string[] = [];
	if (symbols.added.length > 0) changes.push(`+${symbols.added.length} added`);
	if (symbols.removed.length > 0) {
		changes.push(`-${symbols.removed.length} removed`);
	}
	if (symbols.changed.length > 0) {
		changes.push(`~${symbols.changed.length} changed`);
	}
	return changes.length > 0 ? `  (${changes.join(", ")})` : "";
}

export function renderPrCheck(
	result: PrCheckResult,
	printer: Printer = getPrinter(),
): void {
	lines(
		printer,
		"",
		`Base ref: ${result.baseRef}`,
		`Changed .ts files: ${result.tsFilesChanged}`,
	);

	if (result.files.length > 0) {
		lines(printer, "", "File classifications:");
		for (const file of result.files) {
			lines(
				printer,
				`  ${classificationLabel(file.classification)}  ${file.filePath}${symbolSummary(file.exportedSymbols)}`,
			);
		}
	}

	lines(printer, "", `Verdict: ${verdictText(result.verdict)}`);
}
