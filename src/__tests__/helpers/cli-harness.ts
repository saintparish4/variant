/**
 * @module
 * Shared plumbing for tests that drive a real command end to end: a temp
 * workspace, a scoped cwd, and an output capture.
 *
 * Output is captured by installing a {@link Printer} backed by string buffers
 * rather than by spying on `console` — the same seam the CLI uses for
 * `-q`/`-v`, so these tests exercise the real output path.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrinterMode } from "../../cli/visuals/printer.js";
import { Printer, setGlobalPrinter } from "../../cli/visuals/printer.js";

export interface OutputCapture {
	printer: Printer;
	stdout(): string;
	stderr(): string;
}

export function captureOutput(mode: PrinterMode = "default"): OutputCapture {
	let out = "";
	let err = "";
	const printer = new Printer(mode, {
		stdout: {
			write: (text) => {
				out += text;
			},
		},
		stderr: {
			write: (text) => {
				err += text;
			},
		},
	});
	return { printer, stdout: () => out, stderr: () => err };
}

/** Same capture, installed process-wide for commands that use `getPrinter()`. */
export function captureGlobalOutput(
	mode: PrinterMode = "default",
): OutputCapture {
	const capture = captureOutput(mode);
	setGlobalPrinter(capture.printer);
	return capture;
}

/**
 * Hands output back to a printer that discards everything.
 *
 * Not `new Printer("default")`: when a test times out, vitest abandons its
 * promise but the command keeps running, and `getPrinter()` resolves at write
 * time — so that late write lands wherever the global printer points. Pointing
 * it at a sink keeps stray output out of the reporter's display. A late write
 * that lands inside the *next* test still corrupts that test's buffer and
 * fails it loudly, which is what should happen.
 */
export function restoreGlobalPrinter(): void {
	const discard = { write: () => {} };
	setGlobalPrinter(new Printer("silent", { stdout: discard, stderr: discard }));
}

const workspaces: string[] = [];

export function createTempWorkspace(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), `variant-${prefix}-`));
	workspaces.push(dir);
	return dir;
}

/** Writes a map of workspace-relative paths to contents, creating parents. */
export function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [relPath, contents] of Object.entries(files)) {
		const absolute = path.join(dir, relPath);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents);
	}
}

const GIT_IDENTITY = ["-c", "user.email=t@t.com", "-c", "user.name=T"];

/** Runs git in `dir` with a fixed identity, so commits work on any machine. */
export function git(dir: string, ...args: string[]): void {
	execFileSync("git", [...GIT_IDENTITY, ...args], {
		cwd: dir,
		stdio: "ignore",
	});
}

/**
 * A temp workspace committed as the first commit of a new repository on
 * `main`. Change analysis rejects a base ref that names no commit, so a test
 * of `pr` or `diff` needs a real history to compare against.
 */
export function createGitWorkspace(
	prefix: string,
	files: Record<string, string>,
): string {
	const dir = createTempWorkspace(prefix);
	writeFiles(dir, files);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--allow-empty", "-m", "initial");
	return dir;
}

/** Call from `afterEach`. Windows may still hold handles; the OS cleans up. */
export function cleanupTempWorkspaces(): void {
	for (const dir of workspaces) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows holds directory handles briefly after child processes exit.
		}
	}
	workspaces.length = 0;
}

/**
 * Commands read `process.cwd()` directly (Commander gives them no other
 * anchor), so a temp workspace has to be made the process cwd for the call.
 */
export async function withCwd<T>(
	dir: string,
	fn: () => Promise<T>,
): Promise<T> {
	const original = process.cwd;
	process.cwd = () => dir;
	try {
		return await fn();
	} finally {
		process.cwd = original;
	}
}
