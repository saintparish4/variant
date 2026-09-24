import type { ImpactOptions } from "../../core/impact/predict.js";
import { predictImpact } from "../../core/impact/predict.js";
import { verifyImpact } from "../../core/impact/verify.js";
import {
	NO_PREDICTION_MESSAGE,
	renderImpact,
	renderImpactJson,
	renderImpactVerify,
	renderImpactVerifyJson,
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
	const report = await predictImpact(process.cwd(), opts);

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
	reportPath: string,
	opts: ImpactVerifyActionOptions = {},
): Promise<void> {
	const result = await verifyImpact(process.cwd(), reportPath, {
		...(opts.headSha !== undefined && { headSha: opts.headSha }),
	});

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
