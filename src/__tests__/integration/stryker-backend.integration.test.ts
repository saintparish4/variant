/**
 * Boundary: the Stryker backend's process and file handling, with a host
 * that cannot start. No Stryker runs here.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createStrykerBackend } from "../../adapters/mutation/stryker.js";
import type { BackendEvent } from "../../core/check/backend.js";

const CRASHING_HOST = fileURLToPath(
	new URL("../fixtures/mutation/crash-host.mjs", import.meta.url),
);
const LOCKING_HOST = fileURLToPath(
	new URL("../fixtures/mutation/locking-host.mjs", import.meta.url),
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
const lockingBackend = createStrykerBackend({ hostPath: LOCKING_HOST });

/** A process id nothing runs under any more. */
function deadPid(): number {
	const { pid } = spawnSync(process.execPath, ["-e", ""]);
	return pid;
}

describe("the Stryker backend", () => {
	it("reports a host that cannot start, with its output, and leaves nothing behind", async () => {
		const cwd = project();
		const run = backend.start({
			cwd,
			mutate: [],
			runner: { kind: "vitest" },
			baselineTimeoutMinutes: 1,
		});

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
		const run = backend.start({
			cwd,
			mutate: [],
			runner: { kind: "vitest" },
			baselineTimeoutMinutes: 1,
		});

		await run.stop();

		expect(existsSync(path.join(cwd, ".variant"))).toBe(false);
	});

	// Windows frees a killed process's files after taskkill returns, and
	// antivirus holds new ones: a sandbox still held when the run was removed
	// threw EBUSY, and a finished check failed with it. Made unremovable here
	// by permissions, which neither Windows nor root honours for this.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"finishes a run whose files cannot be removed yet, and leaves them for the next run to remove",
		async () => {
			const cwd = project();
			const request = {
				cwd,
				mutate: [],
				runner: { kind: "vitest" as const },
				baselineTimeoutMinutes: 1,
			};
			const run = lockingBackend.start(request);
			const events: BackendEvent[] = [];
			for await (const event of run.events) {
				events.push(event);
				if (event.kind === "finished") break;
			}

			await run.stop();

			expect(events).toEqual([{ kind: "finished" }]);
			const root = path.join(cwd, ".variant", "check-tmp");
			const owners = readdirSync(root).filter((name) =>
				name.endsWith(".owner"),
			);
			expect(owners).toHaveLength(1);

			// Once this run's process is gone and the files are free, the next
			// run removes them.
			const owner = owners[0] ?? "";
			chmodSync(
				path.join(root, owner.slice(0, -".owner".length), "locked"),
				0o700,
			);
			writeFileSync(path.join(root, owner), String(deadPid()));
			const next = backend.start(request);
			for await (const _ of next.events) {
				// Drained: the crashing host reports and exits.
			}
			await next.stop();

			// `.variant/` itself stays: a run removes only one it created.
			expect(existsSync(root)).toBe(false);
		},
	);
});
