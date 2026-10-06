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
 *
 * Every path taken or returned here is relative to `cwd`. Git works from the
 * repository root instead: `diff --name-only` prints root-relative paths and
 * `<ref>:<path>` reads one unless it starts with `./`. The two agree only when
 * `cwd` is the root, so a project kept in a subdirectory once had each changed
 * file name nothing on disk, classify as deleted (a false `breaking`), match
 * nothing in the import graph, and select no tests.
 */

import path from "node:path";

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

/**
 * git parses any argument starting with `-` as an option, and a trailing `--`
 * protects only the paths after it, so a ref like `--output=<file>` would make
 * `git diff` write a file. Git refuses to create a ref whose name starts with
 * `-`, so such a value names nothing and is answered here without running git.
 */
function isOptionLike(ref: string): boolean {
	return ref.startsWith("-");
}

/**
 * Splits `-z` output. Without `-z` git prints a path holding non-ASCII bytes,
 * a quote or a backslash in quoted, octal-escaped form, which names no file.
 */
function toFileList(stdout: string | null): string[] | null {
	if (stdout === null) return null;
	return stdout.split("\0").filter((file) => file.length > 0);
}

/**
 * `git diff --name-only` for `range`, as paths relative to `cwd`. A file
 * changed elsewhere in the repository comes back as `../…` rather than being
 * dropped, which is what `--relative` would do: a caller cannot widen for a
 * change it never sees.
 */
async function listDiff(cwd: string, range: string): Promise<string[] | null> {
	const [stdout, prefix] = await Promise.all([
		git(cwd, ["diff", "--name-only", "-z", range, "--"]),
		git(cwd, ["rev-parse", "--show-prefix"]),
	]);
	const files = toFileList(stdout);
	const cwdFromRoot = prefix?.trim() ?? "";
	if (files === null || cwdFromRoot === "") return files;
	// Rooted, so the answer cannot depend on the process's own directory.
	return files.map((file) =>
		path.posix.relative(`/${cwdFromRoot}`, `/${file}`),
	);
}

/** The `./` is what makes git resolve the path from `cwd`. */
function blobAt(ref: string, relPath: string): string {
	return `${ref}:./${toPosix(relPath)}`;
}

/** Contents of `relPath` as of `ref`, or null when it did not exist there. */
export async function readFileAtRef(
	cwd: string,
	ref: string,
	relPath: string,
): Promise<string | null> {
	if (isOptionLike(ref)) return null;
	return git(cwd, ["show", blobAt(ref, relPath)]);
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
				input: `${chunk.map((p) => blobAt(ref, p)).join("\n")}\n`,
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
 * The commit `ref` names, or null when it names none: a typo, a branch that
 * was never fetched, `HEAD~1` in a one-commit repository, or no repository.
 */
export async function resolveCommit(
	cwd: string,
	ref: string,
): Promise<string | null> {
	if (isOptionLike(ref)) return null;
	const stdout = await git(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${ref}^{commit}`,
	]);
	const sha = stdout?.trim();
	return sha === undefined || sha === "" ? null : sha;
}

/** Files differing between `ref` and the working tree. */
export async function listChangedFiles(
	cwd: string,
	ref: string,
): Promise<string[] | null> {
	if (isOptionLike(ref)) return null;
	return listDiff(cwd, ref);
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
	if (isOptionLike(ref)) return null;
	return listDiff(cwd, `${ref}...HEAD`);
}
