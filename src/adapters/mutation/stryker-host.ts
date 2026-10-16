/**
 * @module
 * The process Stryker runs in. Stryker has no way to stop a run part-way, so
 * `variant check` runs it here and ends this process (and the workers it
 * starts) when the limit, the budget or Ctrl-C says to.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Stryker } from "@stryker-mutator/core";
import type { HostMessage, HostRequest } from "./protocol.js";
import { RUNNER_PACKAGES, strykerOptions } from "./stryker-options.js";
import {
	canRewriteTsconfig,
	loadTypescriptAsStryker,
	tsconfigLeavesPackage,
} from "./tsconfig.js";

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
	const runnerPlugin = createRequire(import.meta.url).resolve(
		RUNNER_PACKAGES[request.runner.kind],
	);
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
		await new Stryker(
			strykerOptions(request, {
				cwd: process.cwd(),
				runnerPlugin,
				rewriteTsconfig,
			}),
		).runMutationTest();
		send({ kind: "finished" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		send(
			/failed tests in the initial test run/i.test(message)
				? { kind: "baseline-failed" }
				: { kind: "error", message },
		);
	}
	// Stays alive until `variant check` ends this process tree. Exiting here
	// would cut the tree: on Windows a child outlives its parent, and a test
	// worker or esbuild process left running holds the project directory.
}
