import { beforeEach, describe, expect, it } from "vitest";
import {
	ConfigError,
	TaskExecutionError,
	VariantError,
} from "../../../core/errors.js";
import { writeGlobalColorChoice } from "../../visuals/color.js";
import { renderError, renderUnexpectedError } from "../error.js";

function capture(): { write: (text: string) => void; text: () => string } {
	let out = "";
	return {
		write: (text) => {
			out += text;
		},
		text: () => out,
	};
}

beforeEach(() => {
	writeGlobalColorChoice("never");
});

describe("renderError", () => {
	it("leads with the machine-readable code, then the message", () => {
		const sink = capture();

		renderError(
			new VariantError("MY_CODE", "something went wrong"),
			sink.write,
		);

		expect(sink.text()).toContain("[MY_CODE]");
		expect(sink.text()).toContain("something went wrong");
	});

	it("prints the hint when the error carries one", () => {
		const sink = capture();

		renderError(new ConfigError("bad config"), sink.write);

		expect(sink.text()).toContain("[CONFIG_ERROR]");
		expect(sink.text()).toContain("Hint:");
		expect(sink.text()).toContain("variant doctor");
	});

	it("omits the hint line when there is no hint", () => {
		const sink = capture();

		renderError(new VariantError("BARE", "no hint here"), sink.write);

		expect(sink.text()).not.toContain("Hint:");
	});

	it("explains why the failing task was running", () => {
		const sink = capture();
		const err = new TaskExecutionError("web:test", 1);
		err.provenance = {
			taskId: "web:test",
			reason: { kind: "affected-by", changedFiles: ["packages/api/src/db.ts"] },
			dirtyDependents: ["web:build"],
			upstreamTasks: ["api:build"],
		};

		renderError(err, sink.write);

		expect(sink.text()).toContain(
			"ran because: packages/api/src/db.ts changed",
		);
		expect(sink.text()).toContain("also affected: web:build");
	});

	it("keeps the reason above the hint, between failure and fix", () => {
		const sink = capture();
		const err = new TaskExecutionError("web:test", 1);
		err.provenance = {
			taskId: "web:test",
			reason: { kind: "always" },
			dirtyDependents: [],
			upstreamTasks: [],
		};

		renderError(err, sink.write);

		const lines = sink.text().trimEnd().split("\n");
		expect(lines[0]).toContain("[TASK_EXECUTION_ERROR]");
		expect(lines[1]).toContain("ran because:");
		expect(lines[2]).toContain("Hint:");
	});

	it("says nothing extra for an error belonging to no task", () => {
		const sink = capture();

		renderError(new ConfigError("bad config"), sink.write);

		expect(sink.text()).not.toContain("ran because:");
	});

	it("carries the same reason text when color is off", () => {
		const err = new TaskExecutionError("web:test", 1);
		err.provenance = {
			taskId: "web:test",
			reason: { kind: "cache-miss", expectedHash: null, actualHash: "abc123" },
			dirtyDependents: [],
			upstreamTasks: [],
		};

		const plain = capture();
		renderError(err, plain.write);

		writeGlobalColorChoice("always");
		const styled = capture();
		renderError(err, styled.write);

		const reason = "ran because: cache miss — nothing cached for this task yet";
		expect(plain.text()).toContain(reason);
		expect(styled.text()).toContain(reason);
		// Styling is the only difference; suppressing color must not drop content.
		expect(styled.text()).not.toBe(plain.text());
	});
});

describe("renderUnexpectedError", () => {
	it("asks for a bug report and includes the stack", () => {
		const sink = capture();

		renderUnexpectedError(new Error("boom"), sink.write);

		expect(sink.text()).toContain("please file a bug");
		expect(sink.text()).toContain("boom");
	});

	it("stringifies a thrown non-Error value", () => {
		const sink = capture();

		renderUnexpectedError("just a string", sink.write);

		expect(sink.text()).toContain("just a string");
	});
});
