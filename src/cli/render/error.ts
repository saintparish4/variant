import type { VariantError } from "../../core/errors.js";
import { getColors } from "../visuals/color.js";
import { provenanceLines } from "./provenance.js";

/** A sink for text; `process.stderr.write` satisfies it. */
export type WriteText = (text: string) => void;

const writeStderr: WriteText = (text) => {
	process.stderr.write(text);
};

/**
 * Renders a fatal error for the CLI top level.
 *
 * Deliberately bypasses the {@link Printer}: `-q`/`-qq` suppress progress and
 * results, not the reason the process is about to exit non-zero.
 */
export function renderError(
	err: VariantError,
	write: WriteText = writeStderr,
): void {
	const colors = getColors();
	write(`${colors.red(`[${err.code}]`)} ${err.message}\n`);
	// Context between the failure and the fix: what happened, why this task was
	// running, then what to do about it.
	if (err.provenance) {
		for (const line of provenanceLines(err.provenance)) {
			write(`${colors.dim(`  ${line}`)}\n`);
		}
	}
	if (err.hint) write(`${colors.dim(`  Hint: ${err.hint}`)}\n`);
}

/** Renders an error that escaped every typed-error path — always a bug. */
export function renderUnexpectedError(
	err: unknown,
	write: WriteText = writeStderr,
): void {
	const detail =
		err instanceof Error ? (err.stack ?? err.message) : String(err);
	write(`Unexpected error — please file a bug:\n${detail}\n`);
}
