/**
 * @module
 * File-system writer for trace sessions. Atomic writes (tmp + rename) so a
 * crashed dev server never leaves a half-written JSON.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceFile } from "./types.js";

const DEFAULT_DIR = ".variant/traces";

export async function writeTrace(
	cwd: string,
	trace: TraceFile,
	outDir: string = DEFAULT_DIR,
): Promise<string> {
	const dir = path.resolve(cwd, outDir);
	await mkdir(dir, { recursive: true });
	const final = path.join(dir, `${trace.sessionId}.json`);
	const tmp = `${final}.tmp`;
	await writeFile(tmp, JSON.stringify(trace, null, 2));
	await rename(tmp, final);
	return final;
}

export function newSessionId(): string {
	const t = Date.now().toString(36);
	const r = Math.random().toString(36).substring(2, 10);
	return `${t}-${r}`;
}
