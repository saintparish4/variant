/**
 * Boundary: the Stryker backend's process and file handling, with a host
 * that cannot start. No Stryker runs here.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createStrykerBackend } from "../../adapters/mutation/stryker.js";
import type { BackendEvent } from "../../core/check/backend.js";

const CRASHING_HOST = fileURLToPath(
	new URL("../fixtures/mutation/crash-host.mjs", import.meta.url),
);
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
	}
});

function project(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "variant-backend-"));
	dirs.push(dir);
	writeFileSync(path.join(dir, "package.json"), "{}\n");
	return dir;
}

const backend = createStrykerBackend({ hostPath: CRASHING_HOST });

describe("the Stryker backend", () => {
	it("reports a host that cannot start, with its output, and leaves nothing behind", async () => {
		const cwd = project();
		const run = backend.start({ cwd, mutate: [], baselineTimeoutMinutes: 1 });

		const events: BackendEvent[] = [];
		for await (const event of run.events) events.push(event);
		await run.stop();

		expect(events).toEqual([
			expect.objectContaining({
				kind: "error",
				output: expect.stringContaining(
					"Cannot find package '@stryker-mutator/core'",
				),
			}),
		]);
		expect(existsSync(path.join(cwd, ".variant"))).toBe(false);
	});

	// A stop while the run's files were still being written left `.variant/`
	// behind: the writes landed after the cleanup.
	it("leaves nothing behind when stopped while the run is still being prepared", async () => {
		const cwd = project();
		const run = backend.start({ cwd, mutate: [], baselineTimeoutMinutes: 1 });

		await run.stop();

		expect(existsSync(path.join(cwd, ".variant"))).toBe(false);
	});
});
