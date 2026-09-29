/**
 * @module
 * Persisted symbol index. For every TypeScript
 * file in the workspace it records the imports (module edges), the exported
 * symbols (with signature/body hashes from `surface.ts`), and extraction
 * notes. The index lives at `.variant/graph/symbols.json` and is updated
 * incrementally: a file is only re-parsed when its content hash changed since
 * the previous build, keeping repeat runs cheap on large repos.
 *
 * This is the substrate for the file-level reverse import graph (1.2) and
 * blast-radius traversal (1.3): signature hashes let consumers detect which
 * symbols changed shape without re-running the differ, and import entries
 * provide the raw edges to invert.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Node, Project, SourceFile } from "ts-morph";
import { GraphError } from "../errors.js";
import type { SymbolKind, TsMorph } from "./surface.js";
import { collectExportedSurface } from "./surface.js";

/**
 * Bumped whenever extraction changes what an index records. Per-file entries
 * are reused by content hash, so without a bump an unchanged file keeps the
 * edges an older extractor produced (and silently misses the new ones).
 */
export const SYMBOL_GRAPH_VERSION = 3;

const GRAPH_FILENAME = "symbols.json";

/** One exported symbol of a file. */
export interface SymbolEntry {
	name: string;
	kind: SymbolKind;
	/** SHA-256 of the normalized public shape; differs → signature/type change. */
	signatureHash: string;
	/** SHA-256 of the normalized implementation text; "" for body-less symbols. */
	bodyHash: string;
	/** True when the symbol exists only in type space. */
	typeSpace: boolean;
}

/** One module dependency of a file. */
export interface ImportEntry {
	/**
	 * Module specifier as written (relative path or package name). For a
	 * `pattern`, the literal text a computed specifier starts with, or "" when
	 * nothing about it is known.
	 */
	module: string;
	/**
	 * `pattern` is an `import()` or `require()` whose specifier is computed:
	 * the file may load any module whose specifier starts with `module`.
	 */
	kind: "static" | "reexport" | "dynamic" | "pattern";
	typeOnly: boolean;
	/**
	 * Names taken from the module: exported names for named imports,
	 * "default" for default imports, "*" for namespace/wildcard.
	 * Empty for side-effect and dynamic imports.
	 */
	names: string[];
}

export interface FileSymbolIndex {
	/** SHA-256 of the file content — the incremental-invalidation key. */
	contentHash: string;
	symbols: SymbolEntry[];
	imports: ImportEntry[];
	/** Constructs that prevent full static resolution (lower confidence). */
	notes: string[];
}

export interface SymbolGraph {
	version: number;
	generatedAt: string;
	/** Keyed by workspace-relative POSIX path. */
	files: Record<string, FileSymbolIndex>;
}

export interface BuildSymbolGraphStats {
	scanned: number;
	parsed: number;
	reused: number;
	removed: number;
}

export interface BuildSymbolGraphOptions {
	/** File globs to index. Default: TS/TSX sources, excluding `.d.ts`. */
	include?: string[];
	/** Extra ignore globs on top of node_modules/.git/.variant/dist. */
	ignore?: string[];
	/** Previous graph to update incrementally. */
	previous?: SymbolGraph | null;
	/** Concurrency for parallel readFile. Default 32. */
	parallel?: number;
}

const DEFAULT_INCLUDE = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const DEFAULT_IGNORE = [
	"node_modules/**",
	".git/**",
	".variant/**",
	"dist/**",
	"**/*.d.ts",
];

export function defaultGraphDir(cwd: string): string {
	return path.join(cwd, ".variant", "graph");
}

/**
 * Build (or incrementally update) the symbol graph for a workspace. Files
 * whose content hash matches `options.previous` are reused without parsing.
 */
export async function buildSymbolGraph(
	cwd: string,
	options: BuildSymbolGraphOptions = {},
): Promise<{ graph: SymbolGraph; stats: BuildSymbolGraphStats }> {
	const fg = (await import("fast-glob")).default;
	const include = options.include ?? DEFAULT_INCLUDE;
	for (const p of include) assertSafePattern(p);

	const files = (
		await fg(include, {
			cwd,
			onlyFiles: true,
			ignore: [...DEFAULT_IGNORE, ...(options.ignore ?? [])],
		})
	)
		.map(toPosix)
		.sort();

	const previous =
		options.previous?.version === SYMBOL_GRAPH_VERSION
			? options.previous
			: null;
	const stats: BuildSymbolGraphStats = {
		scanned: files.length,
		parsed: 0,
		reused: 0,
		removed: 0,
	};

	// Read all candidate files in parallel (same worker-pool shape as
	// cache/hashing.ts), then parse only the ones whose hash changed.
	const contents = new Array<string>(files.length);
	const limit = Math.max(1, options.parallel ?? 32);
	let next = 0;
	const worker = async () => {
		while (true) {
			const i = next++;
			if (i >= files.length) return;
			const relPath = files[i];
			if (relPath === undefined) return;
			contents[i] = await readFile(path.join(cwd, relPath), "utf8");
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, files.length || 1) }, worker),
	);

	// ts-morph is loaded lazily and only when at least one file must be parsed.
	let tsm: TsMorph | undefined;
	let project: Project | undefined;

	const out: Record<string, FileSymbolIndex> = {};
	for (let i = 0; i < files.length; i++) {
		const relPath = files[i];
		const content = contents[i];
		if (relPath === undefined || content === undefined) continue;

		const contentHash = sha256(content);
		const prev = previous?.files[relPath];
		if (prev !== undefined && prev.contentHash === contentHash) {
			out[relPath] = prev;
			stats.reused++;
			continue;
		}

		if (tsm === undefined || project === undefined) {
			tsm = await import("ts-morph");
			project = new tsm.Project({ useInMemoryFileSystem: true });
		}
		const sourceFile = project.createSourceFile(relPath, content, {
			overwrite: true,
		});
		out[relPath] = indexSourceFile(sourceFile, contentHash, tsm);
		stats.parsed++;
	}

	if (previous !== null) {
		for (const key of Object.keys(previous.files)) {
			if (!(key in out)) stats.removed++;
		}
	}

	return {
		graph: {
			version: SYMBOL_GRAPH_VERSION,
			generatedAt: new Date().toISOString(),
			files: out,
		},
		stats,
	};
}

/**
 * Convenience wrapper: load the persisted graph, update it incrementally,
 * and save the result back to `graphDir` (default `.variant/graph/`).
 */
export async function updateSymbolGraph(
	cwd: string,
	options: BuildSymbolGraphOptions & { graphDir?: string } = {},
): Promise<{ graph: SymbolGraph; stats: BuildSymbolGraphStats }> {
	const graphDir = options.graphDir ?? defaultGraphDir(cwd);
	const previous = options.previous ?? (await loadSymbolGraph(graphDir));
	const result = await buildSymbolGraph(cwd, { ...options, previous });
	await saveSymbolGraph(graphDir, result.graph);
	return result;
}

/**
 * Read the persisted graph. Returns null when the file is missing, corrupted,
 * or written by an incompatible version — the index is derived data, so the
 * caller should rebuild rather than fail.
 */
export async function loadSymbolGraph(
	graphDir: string,
): Promise<SymbolGraph | null> {
	const filePath = path.join(graphDir, GRAPH_FILENAME);
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new GraphError(
			`Failed to read symbol graph at "${filePath}": ${String(err)}`,
			{ cause: err },
		);
	}
	try {
		const parsed = JSON.parse(raw) as SymbolGraph;
		if (parsed.version !== SYMBOL_GRAPH_VERSION) return null;
		if (typeof parsed.files !== "object" || parsed.files === null) return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function saveSymbolGraph(
	graphDir: string,
	graph: SymbolGraph,
): Promise<void> {
	try {
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			path.join(graphDir, GRAPH_FILENAME),
			JSON.stringify(graph, null, 2),
		);
	} catch (err) {
		throw new GraphError(
			`Failed to write symbol graph to "${graphDir}": ${String(err)}`,
			{ cause: err },
		);
	}
}

/** All files exporting a symbol with the given name. */
export function findSymbol(
	graph: SymbolGraph,
	name: string,
): { file: string; symbol: SymbolEntry }[] {
	const hits: { file: string; symbol: SymbolEntry }[] = [];
	for (const [file, index] of Object.entries(graph.files)) {
		for (const symbol of index.symbols) {
			if (symbol.name === name) hits.push({ file, symbol });
		}
	}
	return hits;
}

/** Index entry for a file, tolerant of OS-specific path separators. */
export function getFileIndex(
	graph: SymbolGraph,
	file: string,
): FileSymbolIndex | undefined {
	return graph.files[toPosix(file)];
}

function indexSourceFile(
	file: SourceFile,
	contentHash: string,
	tsm: TsMorph,
): FileSymbolIndex {
	const surface = collectExportedSurface(file, tsm);
	const { imports, notes: importNotes } = collectImports(file, tsm);

	const symbols: SymbolEntry[] = [...surface.symbols.entries()]
		.map(([name, s]) => ({
			name,
			kind: s.kind,
			signatureHash: sha256(s.signature),
			bodyHash: s.body === "" ? "" : sha256(s.body),
			typeSpace: s.typeSpace,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	return {
		contentHash,
		symbols,
		imports,
		notes: [...new Set([...surface.notes, ...importNotes])],
	};
}

function collectImports(
	file: SourceFile,
	tsm: TsMorph,
): { imports: ImportEntry[]; notes: string[] } {
	const imports: ImportEntry[] = [];
	const notes: string[] = [];

	for (const imp of file.getImportDeclarations()) {
		const names: string[] = [];
		if (imp.getDefaultImport() !== undefined) names.push("default");
		if (imp.getNamespaceImport() !== undefined) names.push("*");
		for (const named of imp.getNamedImports()) names.push(named.getName());
		imports.push({
			module: imp.getModuleSpecifierValue(),
			kind: "static",
			typeOnly: imp.isTypeOnly(),
			names,
		});
	}

	for (const exp of file.getExportDeclarations()) {
		const module = exp.getModuleSpecifierValue();
		if (module === undefined) continue;
		const named = exp.getNamedExports().map((s) => s.getName());
		imports.push({
			module,
			kind: "reexport",
			typeOnly: exp.isTypeOnly(),
			names: named.length > 0 ? named : ["*"],
		});
	}

	// `import x = require("m")`. Which names the file uses is not tracked, so
	// the edge takes all of them.
	for (const decl of file.getDescendantsOfKind(
		tsm.SyntaxKind.ImportEqualsDeclaration,
	)) {
		const reference = decl.getModuleReference();
		if (!tsm.Node.isExternalModuleReference(reference)) continue;
		const expression = reference.getExpression();
		if (expression === undefined || !tsm.Node.isStringLiteral(expression)) {
			continue;
		}
		imports.push({
			module: expression.getLiteralValue(),
			kind: "static",
			typeOnly: decl.isTypeOnly(),
			names: ["*"],
		});
	}

	for (const call of file.getDescendantsOfKind(tsm.SyntaxKind.CallExpression)) {
		const callee = call.getExpression();
		const isImport = callee.getKind() === tsm.SyntaxKind.ImportKeyword;
		// Any call to an identifier named `require` counts. A local function of
		// that name only adds an edge, which widens the result, never narrows it.
		const isRequire =
			tsm.Node.isIdentifier(callee) && callee.getText() === "require";
		if (!isImport && !isRequire) continue;

		const arg = call.getArguments()[0];
		if (
			arg !== undefined &&
			(tsm.Node.isStringLiteral(arg) ||
				tsm.Node.isNoSubstitutionTemplateLiteral(arg))
		) {
			imports.push(
				isImport
					? {
							module: arg.getLiteralValue(),
							kind: "dynamic",
							typeOnly: false,
							names: [],
						}
					: {
							module: arg.getLiteralValue(),
							kind: "static",
							typeOnly: false,
							names: ["*"],
						},
			);
			continue;
		}

		const prefix = arg === undefined ? "" : staticPrefix(arg, tsm);
		imports.push({
			module: prefix,
			kind: "pattern",
			typeOnly: false,
			names: [],
		});
		if (prefix === "") {
			notes.push(
				`${isImport ? "dynamic import()" : "require()"} with a non-literal specifier`,
			);
		}
	}

	return { imports, notes };
}

/**
 * The literal text a computed specifier is known to start with: `./locales/`
 * for `` `./locales/${lang}` `` or `"./locales/" + lang`, and "" when nothing
 * is known.
 */
function staticPrefix(arg: Node, tsm: TsMorph): string {
	if (tsm.Node.isTemplateExpression(arg)) {
		return arg.getHead().getLiteralText();
	}
	if (
		tsm.Node.isBinaryExpression(arg) &&
		arg.getOperatorToken().getKind() === tsm.SyntaxKind.PlusToken
	) {
		const left = arg.getLeft();
		if (
			tsm.Node.isStringLiteral(left) ||
			tsm.Node.isNoSubstitutionTemplateLiteral(left)
		) {
			return left.getLiteralValue();
		}
		return staticPrefix(left, tsm);
	}
	return "";
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function assertSafePattern(pattern: string): void {
	if (path.isAbsolute(pattern)) {
		throw new GraphError(
			`Unsafe glob pattern "${pattern}": patterns must be relative and must not traverse outside the project root.`,
		);
	}
	const segments = pattern.replace(/\\/g, "/").split("/");
	if (segments.some((seg) => seg === "..")) {
		throw new GraphError(
			`Unsafe glob pattern "${pattern}": patterns must be relative and must not traverse outside the project root.`,
		);
	}
}
