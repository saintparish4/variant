import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrCheckOptions } from "../../core/pr/check.js";
import { runPrCheck } from "../../core/pr/check.js";
import type { PrReportOptions } from "../../core/pr/report.js";
import {
	buildPrReport,
	formatPrReportJson,
	formatPrReportMarkdown,
} from "../../core/pr/report.js";
import { renderPrCheck } from "../render/pr.js";
import { lines } from "../render/writer.js";
import { getPrinter } from "../visuals/printer.js";

export async function registerPrCheckAction(
	opts: PrCheckOptions,
): Promise<void> {
	renderPrCheck(await runPrCheck(process.cwd(), opts));
}

export interface PrReportActionOptions extends PrReportOptions {
	markdown?: boolean;
	/** Write to this workspace-relative path instead of stdout. */
	output?: string;
}

export async function registerPrReportAction(
	opts: PrReportActionOptions,
): Promise<void> {
	const cwd = process.cwd();
	const report = await buildPrReport(cwd, opts);
	const content = opts.markdown
		? formatPrReportMarkdown(report)
		: formatPrReportJson(report);

	if (opts.output === undefined) {
		lines(getPrinter(), content);
		return;
	}

	await writeFile(path.resolve(cwd, opts.output), content, "utf8");
	const kind = opts.markdown ? "Markdown report" : "Report";
	lines(getPrinter(), `${kind} written to ${opts.output}`);
}
