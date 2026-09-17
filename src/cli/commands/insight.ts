import { readCache } from "../../core/cache/store.js";
import { computeInsights } from "../../core/insight/analyzer.js";
import { createContext } from "../context.js";
import { renderInsights } from "../render/insight.js";

export async function registerInsightAction(): Promise<void> {
	const ctx = await createContext(process.cwd(), { scope: false });
	const cache = await readCache(ctx.cacheDir);
	renderInsights(computeInsights([], cache));
}
