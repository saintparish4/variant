import { createStrykerBackend } from "../../adapters/mutation/stryker.js";
import type { MutationBackend } from "../../core/check/backend.js";
import type { CheckResult } from "../../core/check/result.js";
import {
	checkDeps,
	DEFAULT_BUDGET_MS,
	DEFAULT_MAX_MUTANTS,
	runCheck,
} from "../../core/check/run.js";
import { CliUsageError } from "../../core/errors.js";
import { renderCheck, renderCheckJson } from "../render/check.js";
import { errorLines } from "../render/writer.js";
import { getPrinter } from "../visuals/printer.js";

export interface CheckActionOptions {
	base?: string;
	maxMutants?: string;
	budget?: string;
	vitestConfig?: string;
	failOnSurvivors?: boolean;
	json?: boolean;
}

export function parseMaxMutants(value: string | undefined): number {
	if (value === undefined) return DEFAULT_MAX_MUTANTS;
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new CliUsageError(
			`--max-mutants takes a whole number of at least 1, not "${value}"`,
		);
	}
	return Number(value);
}

/** `300`, `90s` or `5m`. */
export function parseBudget(value: string | undefined): number {
	if (value === undefined) return DEFAULT_BUDGET_MS;
	const match = /^(\d+)(s|m)?$/.exec(value.trim());
	if (match === null || Number(match[1]) < 1) {
		throw new CliUsageError(
			`--budget takes seconds (300, 90s) or minutes (5m), not "${value}"`,
		);
	}
	return Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000);
}

/** Whether the run gives a gate something to fail on. */
export function hasFindings(result: CheckResult): boolean {
	return (
		result.status === "incomplete" ||
		result.counts.undetected > 0 ||
		result.counts["no-coverage"] > 0
	);
}

export async function registerCheckAction(
	opts: CheckActionOptions = {},
	backend: MutationBackend = createStrykerBackend(),
): Promise<void> {
	const maxMutants = parseMaxMutants(opts.maxMutants);
	const budgetMs = parseBudget(opts.budget);

	// The first Ctrl-C stops the run and still reports what finished; a
	// second one leaves at once.
	const controller = new AbortController();
	const onInterrupt = (): void => {
		if (controller.signal.aborted) process.exit(130);
		errorLines(getPrinter(), "variant check: stopping…");
		controller.abort();
	};
	process.on("SIGINT", onInterrupt);

	let result: CheckResult;
	try {
		result = await runCheck(
			process.cwd(),
			{
				maxMutants,
				budgetMs,
				signal: controller.signal,
				...(opts.base !== undefined && { base: opts.base }),
				...(opts.vitestConfig !== undefined && {
					vitestConfig: opts.vitestConfig,
				}),
			},
			checkDeps(process.cwd(), backend),
		);
	} finally {
		process.off("SIGINT", onInterrupt);
	}

	if (opts.json === true) renderCheckJson(result);
	else renderCheck(result);

	if (opts.failOnSurvivors === true && hasFindings(result)) {
		process.exitCode = 1;
	}
}
