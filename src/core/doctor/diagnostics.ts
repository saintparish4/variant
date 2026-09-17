/**
 * @module
 * `variant doctor` — the environment diagnosis behind the command. Each
 * check answers one question and returns a {@link Diagnostic}; the command
 * renders them and maps `error` onto a non-zero exit code.
 *
 * Checks never throw: a broken environment is the thing being reported, so a
 * failure to read it is itself a diagnostic.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ResolvedVariantConfig } from "../../types/index.js";
import { findVariantConfigPath, loadConfig } from "../config/loader.js";

export type DiagnosticLevel = "ok" | "warn" | "error";

export interface Diagnostic {
	level: DiagnosticLevel;
	label: string;
	/** Actionable next step, shown indented under the label. */
	detail?: string;
}

export const MINIMUM_NODE_MAJOR = 20;

/** Cache directories above this are worth a warning, not a failure. */
const CACHE_WARN_MB = 500;

export function checkNodeVersion(
	version: string = process.version,
): Diagnostic {
	const match = version.match(/^v(\d+)/);
	const major = match ? Number(match[1]) : 0;
	if (major >= MINIMUM_NODE_MAJOR) {
		return {
			level: "ok",
			label: `Node ${version} meets requirement ≥${MINIMUM_NODE_MAJOR}`,
		};
	}
	return {
		level: "error",
		label: `Node ${version} is below requirement ≥${MINIMUM_NODE_MAJOR}`,
		detail: `Upgrade Node.js to v${MINIMUM_NODE_MAJOR} or later.`,
	};
}

async function directorySizeBytes(dir: string): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return 0;
	}
	const sizes = await Promise.all(
		entries.map(async (entry) => {
			const full = path.join(dir, entry);
			try {
				const stats = await stat(full);
				return stats.isDirectory()
					? await directorySizeBytes(full)
					: stats.size;
			} catch {
				return 0;
			}
		}),
	);
	return sizes.reduce((total, size) => total + size, 0);
}

export async function checkCacheSize(
	cwd: string,
	cacheDir: string,
): Promise<Diagnostic> {
	const bytes = await directorySizeBytes(path.resolve(cwd, cacheDir));
	const megabytes = bytes / (1024 * 1024);
	const label = `Cache directory is ${megabytes.toFixed(0)} MB`;
	if (megabytes > CACHE_WARN_MB) {
		return {
			level: "warn",
			label,
			detail:
				"Consider setting `cache.ttlDays` to evict old entries automatically.",
		};
	}
	return { level: "ok", label };
}

export async function checkTraces(cwd: string): Promise<Diagnostic> {
	const traceDir = path.resolve(cwd, ".variant/traces");
	let sessions: string[];
	try {
		sessions = (await readdir(traceDir)).filter((f) => f.endsWith(".json"));
	} catch {
		return {
			level: "warn",
			label: "No trace sessions found",
			detail:
				"Run `variant trace` to record a session (needed for scope/criticalPaths features).",
		};
	}
	if (sessions.length === 0) {
		return {
			level: "warn",
			label: "Trace directory exists but contains no sessions",
			detail: "Run `variant trace` to record a session.",
		};
	}
	return { level: "ok", label: `${sessions.length} trace session(s) found` };
}

/**
 * Traces are only required when `lintOnlyForNonCritical` can actually fire,
 * which needs critical paths too — this mirrors the condition in
 * `cli/context.ts`, so the two must change together.
 */
function requiresTrace(config: ResolvedVariantConfig): boolean {
	const performance = config.performance;
	return (
		(performance?.lintOnlyForNonCritical ?? false) &&
		(performance?.criticalPaths?.length ?? 0) > 0
	);
}

async function checkConfig(cwd: string): Promise<Diagnostic[]> {
	const configPath = findVariantConfigPath(cwd);
	if (!configPath) {
		return [
			{
				level: "error",
				label: "No variant.config.ts found",
				detail: "Run `variant init` to create one.",
			},
		];
	}

	const diagnostics: Diagnostic[] = [
		{ level: "ok", label: `Config found: ${path.basename(configPath)}` },
	];

	let config: ResolvedVariantConfig;
	try {
		config = await loadConfig(cwd);
	} catch (err) {
		diagnostics.push({
			level: "error",
			label: "Config validation failed",
			detail: err instanceof Error ? err.message : String(err),
		});
		return diagnostics;
	}

	diagnostics.push({ level: "ok", label: "Config is valid" });
	diagnostics.push(await checkCacheSize(cwd, config.cache.directory));

	if (requiresTrace(config)) {
		const trace = await checkTraces(cwd);
		diagnostics.push(
			trace.level === "ok"
				? trace
				: {
						...trace,
						label: `performance.criticalPaths configured but ${trace.label.toLowerCase()}`,
					},
		);
	}

	return diagnostics;
}

export async function runDiagnostics(cwd: string): Promise<Diagnostic[]> {
	return [checkNodeVersion(), ...(await checkConfig(cwd))];
}

export function hasFailure(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.level === "error");
}
