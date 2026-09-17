import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
	ResolvedVariantConfig,
	VariantConfig,
} from "../../types/index.js";
import { ConfigError } from "../errors.js";
import { variantConfigSchema } from "./schema.js";

export function defineConfig(config: VariantConfig): VariantConfig {
	return config;
}

const CANDIDATES = [
	"variant.config.ts",
	"variant.config.mjs",
	"variant.config.js",
	"variant.config.json",
] as const;

/** First matching config path under `cwd`, in the same order as `loadConfig` resolution. */
export function findVariantConfigPath(cwd: string): string | undefined {
	return CANDIDATES.map((f) => path.join(cwd, f)).find(existsSync);
}

export async function loadConfig(
	cwd: string = process.cwd(),
): Promise<ResolvedVariantConfig> {
	const configPath = findVariantConfigPath(cwd);

	let raw: unknown = {};

	if (configPath) {
		if (path.extname(configPath) === ".json") {
			try {
				const text = await readFile(configPath, "utf8");
				raw = JSON.parse(text) as unknown;
			} catch (err) {
				const hint = err instanceof Error ? err.message : String(err);
				throw new ConfigError(
					`Invalid JSON config (${path.basename(configPath)}): ${hint}`,
				);
			}
		} else {
			// jiti transpiles TS and resolves ESM on the fly, so a .ts config
			// needs no build step before variant can read it.
			const { createJiti } = await import("jiti");
			const jiti = createJiti(import.meta.url);
			const mod = await jiti.import(configPath);
			raw = (mod as { default?: unknown }).default ?? mod;
		}
	}

	const result = variantConfigSchema.safeParse(raw);

	if (!result.success) {
		const messages = result.error.issues
			.map((e) => ` ${e.path.map(String).join(".")}: ${e.message}`)
			.join("\n");
		throw new ConfigError(`Invalid variant config:\n${messages}`);
	}

	return result.data as ResolvedVariantConfig;
}
