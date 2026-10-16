/**
 * @module
 * The process Stryker runs in. Stryker has no way to stop a run part-way, so
 * `variant check` runs it here and ends this process (and the workers it
 * starts) when the limit, the budget or Ctrl-C says to.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { LogLevel } from "@stryker-mutator/api/core";
import { Stryker } from "@stryker-mutator/core";
import type { HostMessage, HostRequest } from "./protocol.js";
import { EXCLUDED_MUTATORS } from "./protocol.js";
import {
	canRewriteTsconfig,
	loadTypescriptAsStryker,
	tsconfigLeavesPackage,
} from "./tsconfig.js";

/**
 * Stryker types its log levels as a `const enum`, which a bundler compiling
 * one file at a time cannot inline from another package. The values are these
 * strings.
 */
function logLevel(value: "off" | "error"): LogLevel {
	return value as unknown as LogLevel;
}

function send(message: HostMessage): void {
	process.send?.(message);
}

// The workers Stryker starts do not watch for their parent dying. If
// `variant check` itself is killed, take them down with this process.
process.on("disconnect", () => {
	if (process.platform === "win32") process.exit(1);
	try {
		process.kill(-process.pid, "SIGKILL");
	} catch {
		process.exit(1);
	}
});

process.once("message", (request: HostRequest) => {
	void run(request);
});

async function run(request: HostRequest): Promise<void> {
	// Resolved from variant's own install. Setting `plugins` replaces
	// Stryker's default, which looks only beside Stryker's own package.
	const vitestRunner = createRequire(import.meta.url).resolve(
		"@stryker-mutator/vitest-runner",
	);
	// Pointed at a file that does not exist, Stryker's tsconfig preprocessor
	// skips, which beats failing every run on TypeScript 7.
	const rewriteTsconfig = await canRewriteTsconfig(loadTypescriptAsStryker);
	if (
		!rewriteTsconfig &&
		(await tsconfigLeavesPackage(process.cwd(), (file) =>
			readFile(file, "utf8").catch(() => null),
		).catch(() => false))
	) {
		send({
			kind: "note",
			text: "the tsconfig here points outside this package (a relative `extends` or `references`). This TypeScript has no JavaScript API (TypeScript 7 does not), so that path was not adjusted for the copy the tests ran in.",
		});
	}
	try {
		await new Stryker({
			...(!rewriteTsconfig && {
				tsconfigFile: `${request.tempDirName}.no-tsconfig.json`,
			}),
			configFile: request.configFile,
			// Stryker's Vitest runner, made to count a test file that fails to
			// load: see stryker-plugins.ts.
			testRunner: "variant-vitest",
			vitest: {
				// The whole configured suite in the baseline, so each mutant's
				// tests come from measured coverage, not from Vitest's guess at
				// which tests relate to the file.
				related: false,
				...(request.vitestConfig !== undefined && {
					configFile: request.vitestConfig,
				}),
			},
			mutate: request.mutate,
			mutator: { excludedMutations: EXCLUDED_MUTATORS },
			plugins: [vitestRunner],
			appendPlugins: [request.plugins],
			reporters: ["variant"],
			tempDirName: request.tempDirName,
			cleanTempDir: "always",
			ignorePatterns: ["/.variant"],
			fileLogLevel: logLevel("off"),
			// Stryker names the failing baseline tests only in its log.
			logLevel: logLevel("error"),
			incremental: false,
			thresholds: { high: 80, low: 60, break: null },
			dryRunTimeoutMinutes: request.baselineTimeoutMinutes,
		}).runMutationTest();
		send({ kind: "finished" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		send(
			/failed tests in the initial test run/i.test(message)
				? { kind: "baseline-failed" }
				: { kind: "error", message },
		);
	}
	process.disconnect?.();
	process.exit(0);
}
