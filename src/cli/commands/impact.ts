import { NoBaseCommitError } from "../../core/errors.js";
import type { ImpactOptions } from "../../core/impact/predict.js";
import { predictImpact } from "../../core/impact/predict.js";
import { verifyImpact } from "../../core/impact/verify.js";
import { changeBaseDeps, detectHeadSha } from "../../core/vcs/change-base.js";
import {
	NO_PREDICTION_MESSAGE,
	renderImpact,
	renderImpactJson,
	renderImpactVerify,
	renderImpactVerifyJson,
	renderNoBaseCommit,
} from "../render/impact.js";
import { lines } from "../render/writer.js";
import { getPrinter } from "../visuals/printer.js";

export interface ImpactActionOptions extends ImpactOptions {
	/** Print the report as JSON instead of the human block. */
	json?: boolean;
}

export async function registerImpactAction(
	opts: ImpactActionOptions = {},
): Promise<void> {
	let report: Awaited<ReturnType<typeof predictImpact>>;
	try {
		report = await predictImpact(process.cwd(), opts);
	} catch (error) {
		// Only a detected base can be missing this way, and it is nobody's
		// mistake: a workflow that runs on every push must not go red on the
		// first push of a branch.
		if (!(error instanceof NoBaseCommitError)) throw error;
		renderNoBaseCommit(error.message, opts.json === true);
		return;
	}

	if (opts.json === true) {
		renderImpactJson(report);
		return;
	}

	renderImpact(report);
}

export interface ImpactVerifyActionOptions {
	/** Reconcile against the prediction for this commit. */
	headSha?: string;
	json?: boolean;
}

export async function registerImpactVerifyAction(
	reportPaths: string | readonly string[],
	opts: ImpactVerifyActionOptions = {},
): Promise<void> {
	const cwd = process.cwd();
	// In a pull request the prediction was recorded against the pushed
	// commit, not the merge commit that is checked out. The detected commit is
	// a hint, though: a prediction recorded another way is still the one to
	// reconcile, so a miss falls back to the most recent.
	const detected =
		opts.headSha === undefined
			? await detectHeadSha(changeBaseDeps(cwd))
			: undefined;
	const headSha = opts.headSha ?? detected;
	let result = await verifyImpact(cwd, reportPaths, {
		...(headSha !== undefined && { headSha }),
	});
	if (result === null && opts.headSha === undefined && detected !== undefined) {
		result = await verifyImpact(cwd, reportPaths);
	}

	if (result === null) {
		lines(getPrinter(), NO_PREDICTION_MESSAGE);
		return;
	}

	if (opts.json === true) {
		renderImpactVerifyJson(result);
		return;
	}

	renderImpactVerify(result);
}
