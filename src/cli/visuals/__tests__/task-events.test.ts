import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeGlobalColorChoice } from "../color.js";
import type { OutputStream } from "../printer.js";
import { Printer } from "../printer.js";
import { createTaskEventProgress } from "../task-events.js";

const ESC = String.fromCharCode(27);

function fakeStream(isTTY: boolean): {
	chunks: string[];
	stream: OutputStream;
} {
	const chunks: string[] = [];
	return {
		chunks,
		stream: {
			isTTY,
			columns: 120,
			write: (text: string) => {
				chunks.push(text);
			},
		},
	};
}

beforeEach(() => {
	writeGlobalColorChoice("never");
	vi.stubEnv("VARIANT_TEST_NO_CLI_PROGRESS", "");
});

afterEach(() => {
	writeGlobalColorChoice("auto");
	vi.unstubAllEnvs();
});

describe("createTaskEventProgress (hidden, piped output)", () => {
	it("degrades to the classic per-line task log", () => {
		const { chunks, stream } = fakeStream(false);
		const printer = new Printer("default", { stderr: stream });
		const progress = createTaskEventProgress("Running build tasks...", printer);

		progress.onTaskEvent({ task: "app:build", status: "running" });
		progress.onTaskEvent({ task: "app:build", status: "done", durationMs: 42 });
		progress.onTaskEvent({ task: "lib:build", status: "cached" });
		progress.onTaskEvent({ task: "bad:build", status: "running" });
		progress.onTaskEvent({ task: "bad:build", status: "failed" });
		progress.finish();

		const output = chunks.join("");
		expect(output).toContain("→ app:build");
		expect(output).toContain("✓ app:build (42ms)");
		expect(output).toContain("· lib:build [cached]");
		expect(output).toContain("✗ bad:build");
		expect(output).not.toContain(ESC);
	});

	it("omits the duration when durationMs is absent", () => {
		const { chunks, stream } = fakeStream(false);
		const printer = new Printer("default", { stderr: stream });
		const progress = createTaskEventProgress("Running build tasks...", printer);

		progress.onTaskEvent({ task: "app:build", status: "done" });
		progress.finish();

		expect(chunks.join("")).toContain("✓ app:build\n");
	});

	it("does not expose onTaskOutput when progress is hidden", () => {
		const { stream } = fakeStream(false);
		const printer = new Printer("default", { stderr: stream });
		const progress = createTaskEventProgress("Running build tasks...", printer);
		expect(progress.onTaskOutput).toBeUndefined();
		progress.finish();
	});

	it("writes nothing through a quiet printer", () => {
		const { chunks, stream } = fakeStream(false);
		const printer = new Printer("quiet", { stderr: stream });
		const progress = createTaskEventProgress("Running build tasks...", printer);

		progress.onTaskEvent({ task: "app:build", status: "running" });
		progress.onTaskEvent({ task: "app:build", status: "done", durationMs: 5 });
		progress.finish();

		expect(chunks).toEqual([]);
	});
});

describe("createTaskEventProgress (visible on a TTY)", () => {
	it("pins running tasks as headers and logs completions permanently", () => {
		const { chunks, stream } = fakeStream(true);
		const printer = new Printer("default", { stderr: stream });
		const progress = createTaskEventProgress("Running build tasks...", printer);

		expect(chunks.join("")).toContain("Running build tasks...");
		progress.onTaskEvent({ task: "app:build", status: "running" });
		expect(chunks.join("")).toContain("→ app:build");
		progress.onTaskEvent({ task: "app:build", status: "done", durationMs: 7 });
		expect(chunks.join("")).toContain("✓ app:build (7ms)\n");
		progress.finish();
		expect(chunks.join("")).toContain(`${ESC}[?25h`);
	});

	it("exposes onTaskOutput while animating and streams prefixed lines", () => {
		const { chunks, stream } = fakeStream(true);
		const printer = new Printer("default", { stderr: stream });
		const progress = createTaskEventProgress("Running build tasks...", printer);
		expect(progress.onTaskOutput).toBeDefined();
		progress.onTaskOutput?.("app:build", "compiled 10 modules");
		expect(chunks.join("")).toContain("app:build │ compiled 10 modules");
		progress.finish();
	});

	it("finish is idempotent", () => {
		const { chunks, stream } = fakeStream(true);
		const printer = new Printer("default", { stderr: stream });
		const progress = createTaskEventProgress("Running build tasks...", printer);
		progress.finish();
		const afterFirst = chunks.length;
		progress.finish();
		expect(chunks.length).toBe(afterFirst);
	});
});
