/**
 * Boundary: the read-only commands (`check`, `doctor`, `env`, `insight`,
 * `init`) meeting real config discovery, validation, and environment
 * detection.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerCheckAction } from "../../cli/commands/check.js";
import { registerDoctorAction } from "../../cli/commands/doctor.js";
import { registerEnvAction } from "../../cli/commands/env.js";
import { registerInitAction } from "../../cli/commands/init.js";
import { registerInsightAction } from "../../cli/commands/insight.js";
import { ConfigError } from "../../core/errors.js";
import {
	captureGlobalOutput,
	cleanupTempWorkspaces,
	createTempWorkspace,
	restoreGlobalPrinter,
	withCwd,
	writeFiles,
} from "../helpers/cli-harness.js";

function writeConfig(dir: string, config: Record<string, unknown>): void {
	writeFiles(dir, {
		"variant.config.json": JSON.stringify(config),
	});
}

afterEach(() => {
	cleanupTempWorkspaces();
	restoreGlobalPrinter();
	process.exitCode = 0;
});

describe("check command", () => {
	it("accepts a valid config and task graph", async () => {
		const dir = createTempWorkspace("check");
		writeConfig(dir, { tasks: { build: {}, lint: {} } });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerCheckAction());

		expect(output.stdout()).toMatch(/valid/i);
	});

	it("accepts dependsOn references that resolve", async () => {
		const dir = createTempWorkspace("check");
		writeConfig(dir, { tasks: { lint: {}, build: { dependsOn: ["lint"] } } });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerCheckAction());

		expect(output.stdout()).toMatch(/valid/i);
	});

	it("rejects a dependsOn reference to an unknown task", async () => {
		const dir = createTempWorkspace("check");
		writeConfig(dir, { tasks: { build: { dependsOn: ["nonexistent"] } } });

		await expect(
			withCwd(dir, () => registerCheckAction()),
		).rejects.toBeInstanceOf(ConfigError);
	});
});

describe("doctor command", () => {
	it("reports a healthy Node version and valid config", async () => {
		const dir = createTempWorkspace("doctor");
		writeConfig(dir, { tasks: { build: { command: "echo ok" } } });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerDoctorAction());

		expect(output.stdout()).toMatch(/Node.*meets/i);
		expect(output.stdout()).toMatch(/Config.*valid/i);
		expect(process.exitCode).toBe(0);
	});

	// Only the task runner reads a config. Failing here told someone who had
	// just run `impact` without one that their setup was broken.
	it("notes a missing config without failing, since only the task runner needs one", async () => {
		const dir = createTempWorkspace("doctor");
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerDoctorAction());

		expect(output.stdout()).toMatch(/No variant\.config/i);
		expect(output.stdout()).toMatch(/impact.*work without one/i);
		expect(process.exitCode).toBe(0);
	});

	it("flags a config whose dependsOn does not resolve", async () => {
		const dir = createTempWorkspace("doctor");
		writeConfig(dir, { tasks: { build: { dependsOn: ["ghost"] } } });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerDoctorAction());

		expect(output.stdout()).toMatch(/Config validation failed/i);
		expect(process.exitCode).toBe(1);
	});
});

describe("env command", () => {
	it("prints the detected package manager, runtime, and framework", async () => {
		const dir = createTempWorkspace("env");
		writeConfig(dir, { tasks: {} });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerEnvAction());

		expect(output.stdout()).toMatch(/Package Manager/i);
		expect(output.stdout()).toMatch(/Runtime/i);
		expect(output.stdout()).toMatch(/Framework/i);
	});

	it("says 'none detected' for a project with no framework", async () => {
		const dir = createTempWorkspace("env");
		writeConfig(dir, { tasks: {} });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerEnvAction());

		expect(output.stdout()).toContain("none detected");
	});
});

describe("insight command", () => {
	it("says there is nothing to report before any task has run", async () => {
		const dir = createTempWorkspace("insight");
		writeConfig(dir, {
			tasks: {},
			cache: { directory: path.join(dir, ".variant/cache") },
		});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInsightAction());

		expect(output.stdout()).toContain("No cached task data yet");
	});

	it("shows cached task history once the cache has entries", async () => {
		const dir = createTempWorkspace("insight");
		const cacheDir = path.join(dir, ".variant/cache");
		writeConfig(dir, { tasks: {}, cache: { directory: cacheDir } });
		writeFiles(dir, {
			".variant/cache/cache.json": JSON.stringify({
				tasks: {
					build: { lastRun: Date.now() - 60_000, lastDurationMs: 1234 },
				},
			}),
		});
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInsightAction());

		expect(output.stdout()).toContain("build");
		expect(output.stdout()).toContain("1234ms");
	});
});

describe("init command", () => {
	it("scaffolds a config when none exists", async () => {
		const dir = createTempWorkspace("init");
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInitAction());

		expect(existsSync(path.join(dir, "variant.config.ts"))).toBe(true);
		expect(output.stdout()).toMatch(/Created/);
	});

	it("refuses to overwrite an existing TypeScript config", async () => {
		const dir = createTempWorkspace("init");
		writeFiles(dir, { "variant.config.ts": "// existing" });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInitAction());

		expect(output.stdout()).toMatch(/already exists/);
	});

	it("refuses to overwrite an existing JSON config", async () => {
		const dir = createTempWorkspace("init");
		writeFiles(dir, { "variant.config.json": "{}" });
		const output = captureGlobalOutput();

		await withCwd(dir, () => registerInitAction());

		expect(output.stdout()).toMatch(/variant\.config\.json.*already exists/);
		expect(existsSync(path.join(dir, "variant.config.ts"))).toBe(false);
	});
});
