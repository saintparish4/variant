import type { CheckResult, MutantOutcome } from "../../core/check/result.js";
import { allDetected } from "../../core/check/result.js";
import type { ExclusionReason } from "../../core/check/targets.js";
import { getColors } from "../visuals/color.js";
import type { Printer } from "../visuals/printer.js";
import { getPrinter } from "../visuals/printer.js";
import { plural } from "./labels.js";
import { lines } from "./writer.js";

const EXCLUSION: Readonly<Record<ExclusionReason, string>> = {
	untracked: "untracked: `git add` it to include it",
	test: "a test file",
	declaration: "a declaration file",
	"not-typescript": "not TypeScript",
	outside: "outside this directory",
	"deleted-lines-only": "only lines removed, which cannot be mutated",
};

const INCONCLUSIVE: Readonly<
	Partial<Record<MutantOutcome["outcome"], string>>
> = {
	timeout: "timed out",
	"runtime-error": "the tests errored",
	"compile-error": "did not compile",
};

/** A full commit id is noise beside the words that say what it is. */
function shortRef(ref: string): string {
	return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`;
}

function where(mutant: MutantOutcome): string {
	const at = `${mutant.file}:${mutant.start.line}:${mutant.start.column}`;
	return mutant.symbol === undefined ? at : `${at}  in ${mutant.symbol}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function stopped(result: CheckResult): string {
	const tried = result.counts.attempted;
	const planned = result.mutants.length;
	switch (result.stopReason) {
		case "limit":
			return `stopped at --max-mutants after ${plural(tried, "mutation")}; ${result.counts["not-run"].toLocaleString("en-US")} more were not run`;
		case "budget":
			return result.baselineFinished
				? `the --budget ran out after ${tried} of ${plural(planned, "mutation")}`
				: "the --budget ran out before the tests finished their first, unmutated run";
		case "interrupted":
			return `interrupted after ${tried} of ${plural(planned, "mutation")}`;
		default:
			return `${result.counts["not-run"].toLocaleString("en-US")} of ${plural(planned, "mutation")} were not run`;
	}
}

export function renderCheck(
	result: CheckResult,
	printer: Printer = getPrinter(),
): void {
	const colors = getColors();
	const base =
		result.base.label === result.base.ref
			? shortRef(result.base.ref)
			: `${shortRef(result.base.ref)} (${result.base.label.replace(/^HEAD: /, "")})`;
	lines(printer, "", `Compared with ${base}.`);

	if (result.files.length > 0) {
		lines(printer, "", "Mutated:");
		for (const file of result.files) {
			const symbols =
				file.symbols.length > 0 ? `  (${file.symbols.join(", ")})` : "";
			lines(
				printer,
				`  ${file.file}  ${plural(file.changedLines, "changed line")}, ${plural(file.mutants, "mutation")}${symbols}`,
			);
		}
	}
	if (result.excluded.length > 0) {
		lines(printer, "", "Not mutated:");
		for (const exclusion of result.excluded) {
			lines(printer, `  ${exclusion.file}  ${EXCLUSION[exclusion.reason]}`);
		}
	}

	if (result.status === "nothing-to-mutate") {
		lines(
			printer,
			"",
			"Nothing to check: no TypeScript source line changed here, so there is nothing to mutate.",
		);
		renderFooter(result, printer);
		return;
	}

	const undetected = result.mutants.filter((m) => m.outcome === "undetected");
	if (undetected.length > 0) {
		lines(
			printer,
			"",
			colors.bold(colors.yellow(`Undetected: ${undetected.length}`)),
		);
		for (const mutant of undetected) {
			lines(
				printer,
				`  ${where(mutant)}`,
				`    ${colors.red(`- ${oneLine(mutant.original)}`)}`,
				`    ${colors.green(`+ ${oneLine(mutant.replacement)}`)}`,
				`    ${mutant.explanation ?? ""}`,
			);
		}
	}

	const unreached = result.mutants.filter((m) => m.outcome === "no-coverage");
	if (unreached.length > 0) {
		lines(
			printer,
			"",
			colors.bold(colors.yellow(`No test reached: ${unreached.length}`)),
			"  No test executed this code in the test process, so none could notice a change to it.",
		);
		for (const mutant of unreached) {
			lines(
				printer,
				`  ${where(mutant)}  ${oneLine(mutant.original)} → ${oneLine(mutant.replacement)}`,
			);
		}
	}

	const inconclusive = result.mutants.filter(
		(m) => INCONCLUSIVE[m.outcome] !== undefined,
	);
	if (inconclusive.length > 0) {
		lines(
			printer,
			"",
			`Inconclusive: ${inconclusive.length}  (neither detected nor undetected)`,
		);
		for (const mutant of inconclusive) {
			const reason =
				mutant.reason === undefined ? "" : `: ${oneLine(mutant.reason)}`;
			lines(
				printer,
				`  ${where(mutant)}  ${oneLine(mutant.original)} → ${oneLine(mutant.replacement)}  ${INCONCLUSIVE[mutant.outcome]}${reason}`,
			);
		}
	}

	lines(printer, "");
	const { counts } = result;
	if (result.status === "incomplete") {
		lines(
			printer,
			colors.bold(`Incomplete: ${stopped(result)}.`),
			"Nothing here says how the rest of the change would fare.",
		);
	}
	if (counts.attempted === 0 && result.status === "complete") {
		lines(
			printer,
			"The changed lines hold no comparison, condition or arithmetic to mutate.",
		);
	} else if (allDetected(result)) {
		lines(
			printer,
			colors.green(
				counts.attempted === 1
					? "The one mutation tried was detected by the tests that ran."
					: `All ${plural(counts.attempted, "mutation")} were detected by the tests that ran.`,
			),
			"That is evidence these tests check these lines, not proof the change is correct.",
		);
	} else if (counts.attempted > 0) {
		const parts = [
			`${counts.detected.toLocaleString("en-US")} detected`,
			`${counts.undetected.toLocaleString("en-US")} undetected`,
			...(counts["no-coverage"] > 0
				? [
						`${counts["no-coverage"].toLocaleString("en-US")} reached by no test`,
					]
				: []),
			...(inconclusive.length > 0
				? [`${inconclusive.length.toLocaleString("en-US")} inconclusive`]
				: []),
		];
		lines(
			printer,
			`${plural(counts.attempted, "mutation")} tried: ${parts.join(", ")}.`,
		);
	}
	renderFooter(result, printer);
}

function renderFooter(result: CheckResult, printer: Printer): void {
	const scope: string[] = [];
	if (result.baseline !== undefined) {
		const config =
			result.vitestConfig === undefined
				? "the Vitest config here"
				: result.vitestConfig;
		scope.push(
			`the tests passed unmutated first (${plural(result.baseline.tests, "test")} in ${plural(result.baseline.files, "file")}, from ${config}); each mutation then ran against the tests that executed its code`,
		);
	}
	if (result.status !== "nothing-to-mutate") {
		scope.push(
			"only comparisons, boolean conditions and arithmetic were mutated, and mutations are not type-checked",
		);
	}
	if (result.deletedLines > 0) {
		scope.push(
			`${plural(result.deletedLines, "deleted line")} could not be mutated`,
		);
	}
	if (scope.length > 0) lines(printer, "", `Scope: ${scope.join("; ")}.`);
	for (const note of result.notes) lines(printer, `Note: ${note}`);
	lines(printer, `Time: ${seconds(result.durationMs)}`);
}

export function renderCheckJson(
	result: CheckResult,
	printer: Printer = getPrinter(),
): void {
	lines(
		printer,
		JSON.stringify({ ...result, allDetected: allDetected(result) }, null, 2),
	);
}
