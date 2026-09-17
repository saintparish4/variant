import type { InsightSummary } from "../../core/insight/analyzer.js";
import type { RuntimeInfo } from "../../types/index.js";
import { getColors } from "../visuals/color.js";
import type { Printer } from "../visuals/printer.js";
import { getPrinter } from "../visuals/printer.js";
import { lines } from "./writer.js";

function statusLabel(result: { skipped?: boolean; cacheHit: boolean }): string {
	const colors = getColors();
	if (result.skipped) return colors.dim("SKIP");
	return result.cacheHit ? colors.green("HIT") : colors.red("MISS");
}

export function renderInsights(
	summary: InsightSummary,
	printer: Printer = getPrinter(),
): void {
	const colors = getColors();
	const results = summary.lastRunResults;

	if (results.length === 0) {
		const entries = Object.entries(summary.cachedStats);
		if (entries.length === 0) {
			lines(printer, "No cached task data yet. Run a task first.");
			return;
		}
		lines(printer, "", "Cached task history:");
		for (const [task, entry] of entries) {
			const duration =
				entry.lastDurationMs !== undefined
					? `${entry.lastDurationMs}ms`
					: "unknown";
			const ran = new Date(entry.lastRun).toLocaleString();
			lines(
				printer,
				`  ${task.padEnd(20)} last run: ${ran}  duration: ${duration}`,
			);
		}
		return;
	}

	const nameWidth = Math.max(...results.map((r) => r.task.length), 4);
	const header = `${"TASK".padEnd(nameWidth)} ${"DURATION".padEnd(10)} STATUS`;
	lines(printer, "", colors.bold(header), "-".repeat(header.length));

	for (const result of results) {
		const duration =
			result.skipped || result.cacheHit ? "-" : `${result.durationMs}ms`;
		lines(
			printer,
			`${result.task.padEnd(nameWidth)} ${duration.padEnd(10)} ${statusLabel(result)}`,
		);
	}

	const percent = (summary.cacheHitRate * 100).toFixed(0);
	lines(
		printer,
		"",
		colors.dim(
			`Total: ${summary.totalDurationMs}ms  Cache hit rate: ${percent}%`,
		),
	);
}

export function renderEnv(
	pm: string,
	runtime: RuntimeInfo,
	framework: string | null,
	printer: Printer = getPrinter(),
): void {
	lines(
		printer,
		`Package Manager : ${pm}`,
		`Runtime         : ${runtime.primary} (fallback: ${runtime.fallback})`,
		`Framework       : ${framework ?? "none detected"}`,
	);
}
