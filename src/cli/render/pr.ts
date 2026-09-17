import type { PrCheckResult } from "../../core/pr/check.js";
import type { PrReplayResult } from "../../core/pr/replay.js";
import { verdictText } from "../../core/semantic/verdict.js";
import type { Printer } from "../visuals/printer.js";
import { getPrinter } from "../visuals/printer.js";
import { classificationLabel, plural } from "./labels.js";
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

export function renderPrReplay(
	result: PrReplayResult | null,
	printer: Printer = getPrinter(),
): void {
	if (result === null) {
		lines(
			printer,
			"No trace session found. Run `variant trace` first to record a session.",
		);
		return;
	}

	lines(
		printer,
		"",
		`Base ref:        ${result.baseRef}`,
		`Trace session:   ${result.sessionId}`,
		`Framework:       ${result.framework}`,
		`Changed files:   ${result.changedFiles.length}`,
		`Touched modules: ${result.touchedModules.length}`,
	);

	if (result.touchedRoutes.length > 0) {
		lines(printer, "", "Touched routes:");
		for (const route of result.touchedRoutes) {
			lines(
				printer,
				`  ${route.path}  (${plural(route.modules.length, "module")})`,
			);
		}
	} else {
		lines(printer, "", "No traced routes are touched by this PR.");
	}

	if (result.touchedPackages.length > 0) {
		lines(printer, "", "Touched packages:");
		for (const name of result.touchedPackages) lines(printer, `  ${name}`);
	}
}
