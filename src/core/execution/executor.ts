import type { TaskConfig } from "../../types/index.js";
import { TaskExecutionError } from "../errors.js";

export type TaskExecutor = (
	name: string,
	cfg: TaskConfig,
	pm: string,
	cwd: string,
	/**
	 * When set, the task's stdout/stderr is captured and streamed here line by
	 * line instead of inheriting the terminal — used by the CLI to keep child
	 * output from tearing through animated progress rendering.
	 */
	onOutput?: (line: string) => void,
) => Promise<void>;

export const executeTask: TaskExecutor = async (
	name,
	cfg,
	pm,
	cwd,
	onOutput,
) => {
	// Lazy imports keep startup fast (`variant --help` stays < 100ms).
	const { execa, ExecaError } = await import("execa");
	const { default: stringArgv } = await import("string-argv");

	const command = cfg.command ?? `${pm} run ${name}`;
	const [cmd, ...args] = stringArgv(command);

	if (!cmd) {
		throw new TaskExecutionError(name, 1, `Empty command for task "${name}"`);
	}

	try {
		if (onOutput === undefined) {
			await execa(cmd, args, { cwd, stdio: "inherit" });
		} else {
			const subprocess = execa(cmd, args, { cwd, all: true, buffer: false });
			// Iteration streams interleaved stdout+stderr lines, waits for the
			// subprocess to end, and throws the ExecaError on failure.
			for await (const line of subprocess.iterable({ from: "all" })) {
				onOutput(line);
			}
		}
	} catch (err: unknown) {
		if (err instanceof ExecaError) {
			const exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
			const signal = typeof err.signal === "string" ? err.signal : null;
			const message = signal
				? `Task "${name}" killed by ${signal}`
				: `Task "${name}" failed with exit code ${exitCode}`;
			throw new TaskExecutionError(name, exitCode, message, { cause: err });
		}
		// Non-execa error (rare: spawn failure, etc.). Preserve cause anyway.
		throw new TaskExecutionError(
			name,
			1,
			`Task "${name}" failed: ${String(err)}`,
			{ cause: err },
		);
	}
};
