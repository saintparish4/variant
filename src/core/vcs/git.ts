/**
 * @module
 * The git porcelain the rest of `core` builds on — `cache/git-diff`,
 * `semantic/blast-radius` and `pr` all read VCS state through here so the
 * "git is unavailable" fallback and the argument-injection guards are written
 * once instead of once per caller.
 *
 * Every function degrades rather than throwing: git may be missing, the repo
 * may be shallow, the ref may not exist. `null` means "no VCS information" —
 * callers skip the optimization instead of failing the build.
 */

/**
 * git pathspecs are POSIX-separated internally regardless of host OS. A path
 * built with `path.relative` carries backslashes on Windows, which `git show`
 * fails to resolve — silently making every file look new (and every export
 * look added, i.e. a false `breaking`).
 */
function toPosix(relPath: string): string {
	return relPath.replace(/\\/g, "/");
}

// execa is a heavy dependency and `core/cache/git-diff.ts` is on the static
// import path of every command via cli/context.ts. Loading it lazily here
// keeps it out of the startup cost of commands that never touch git.
async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { execa } = await import("execa");
		const { stdout } = await execa("git", args, { cwd });
		return stdout;
	} catch {
		return null;
	}
}

function toFileList(stdout: string | null): string[] | null {
	if (stdout === null) return null;
	return stdout
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Contents of `relPath` as of `ref`, or null when it did not exist there. */
export async function readFileAtRef(
	cwd: string,
	ref: string,
	relPath: string,
): Promise<string | null> {
	return git(cwd, ["show", `${ref}:${toPosix(relPath)}`]);
}

/**
 * Requests per `git cat-file --batch` invocation. The whole response is
 * buffered in memory, so this bounds the peak at ~one chunk of blobs while
 * still collapsing hundreds of process spawns into a handful.
 */
const CAT_FILE_BATCH_SIZE = 256;

/**
 * Contents of many paths as of `ref`, in one `git cat-file --batch` per chunk
 * instead of one `git show` per file — a 50-file diff went from 50 process
 * spawns to one.
 *
 * Returns null when the batch could not be run or its output could not be
 * parsed, so the caller can fall back to per-file `readFileAtRef`. A path that
 * did not exist at `ref` maps to null, matching `readFileAtRef`.
 */
export async function readFilesAtRef(
	cwd: string,
	ref: string,
	relPaths: string[],
): Promise<Map<string, string | null> | null> {
	const out = new Map<string, string | null>();
	if (relPaths.length === 0) return out;

	// Requests are newline-delimited, so a path containing a newline would be
	// read as two requests and desynchronize every response after it. Such
	// paths are legal in git but vanishingly rare — refuse the batch and let
	// the caller spawn per file rather than risk misattributing contents.
	if (relPaths.some((p) => p.includes("\n") || p.includes("\0"))) return null;

	const { execa } = await import("execa");
	for (let start = 0; start < relPaths.length; start += CAT_FILE_BATCH_SIZE) {
		const chunk = relPaths.slice(start, start + CAT_FILE_BATCH_SIZE);
		let stdout: Uint8Array;
		try {
			const result = await execa("git", ["cat-file", "--batch"], {
				cwd,
				input: `${chunk.map((p) => `${ref}:${toPosix(p)}`).join("\n")}\n`,
				encoding: "buffer",
				// The response framing is byte-exact; execa's default of
				// trimming the final newline would truncate the last record.
				stripFinalNewline: false,
			});
			stdout = result.stdout;
		} catch {
			return null;
		}
		if (!parseCatFileBatch(stdout, chunk, out)) return null;
	}
	return out;
}

const NEWLINE = 0x0a;

/**
 * `cat-file` hands back the exact blob, while execa strips the final newline
 * from `git show`. The two readers are used interchangeably — the batch falls
 * back to per-file — so they must return identical strings.
 */
function stripFinalNewline(text: string): string {
	if (text.endsWith("\r\n")) return text.slice(0, -2);
	if (text.endsWith("\n")) return text.slice(0, -1);
	return text;
}

/**
 * Parse `git cat-file --batch` output, which is positional: one response per
 * request, in order. A found object is `<sha> <type> <size>\n<contents>\n`; a
 * missing one is `<request> missing\n`. Returns false on any desync, because a
 * partially-parsed batch would attribute one file's contents to another.
 */
function parseCatFileBatch(
	stdout: Uint8Array,
	requested: string[],
	out: Map<string, string | null>,
): boolean {
	const decoder = new TextDecoder();
	let offset = 0;

	for (const relPath of requested) {
		const lineEnd = stdout.indexOf(NEWLINE, offset);
		if (lineEnd === -1) return false;
		const header = decoder.decode(stdout.subarray(offset, lineEnd));
		offset = lineEnd + 1;

		const parts = header.split(" ");
		const type = parts[1];
		if (type !== "blob") {
			// "missing", "ambiguous", or a tree/commit we cannot read as text.
			// Absent at this ref is the same answer readFileAtRef gives.
			out.set(relPath, null);
			continue;
		}
		const size = Number(parts[2]);
		if (!Number.isInteger(size) || size < 0) return false;
		const end = offset + size;
		if (end > stdout.length) return false;
		out.set(
			relPath,
			stripFinalNewline(decoder.decode(stdout.subarray(offset, end))),
		);
		// Skip the payload plus the newline git appends after it.
		offset = end + 1;
	}
	return true;
}

/**
 * The commit a prediction was made against, so a logged prediction can be
 * matched to the test run that actually happened. Null outside a repository,
 * or on a repository with no commits yet.
 */
export async function readHeadSha(cwd: string): Promise<string | null> {
	const stdout = await git(cwd, ["rev-parse", "HEAD"]);
	const sha = stdout?.trim();
	return sha === undefined || sha === "" ? null : sha;
}

/**
 * Files differing between `ref` and the working tree.
 *
 * The trailing `--` terminates option parsing so a crafted ref (one starting
 * with `-`) is always treated as a revision, never as a git flag.
 */
export async function listChangedFiles(
	cwd: string,
	ref: string,
): Promise<string[] | null> {
	return toFileList(await git(cwd, ["diff", "--name-only", ref, "--"]));
}

/**
 * Files a branch adds relative to `ref` — the three-dot range, which diffs
 * against the merge base. This is what a PR shows: commits landing on the base
 * branch after the branch point are not attributed to the PR.
 */
export async function listChangedFilesSinceMergeBase(
	cwd: string,
	ref: string,
): Promise<string[] | null> {
	return toFileList(
		await git(cwd, ["diff", "--name-only", `${ref}...HEAD`, "--"]),
	);
}
