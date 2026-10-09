/**
 * @module
 * AST-based change classifier. Compares two snapshots of the same file and
 * decides whether the change is non-impacting (comments / whitespace), internal
 * (implementation-only — function bodies, non-exported code), or breaking
 * (exported public API shape changed).
 *
 * The exported surface is compared structurally — parameters, return types, and
 * type shapes — never implementation text, so a body-only edit of an exported
 * function classifies as `internal`. Each changed symbol carries a `ChangeKind`
 * (`signature | body | type`) so downstream consumers can gate blast-radius
 * propagation precisely. Constructs that cannot be resolved from a single file
 * (`export *`, dynamic `import()`, declaration merging) lower the confidence
 * score instead of silently passing.
 */

import type { Project, SourceFile } from "ts-morph";
import type { TsMorph } from "./surface.js";
import { collectExportedSurface, significantText } from "./surface.js";

export type SemanticClass = "non-impacting" | "internal" | "breaking";

/**
 * How an exported symbol changed:
 * - `signature` — runtime-visible API shape (parameters, return type, value type)
 * - `body` — implementation only; the public surface is unchanged
 * - `type` — type-space only (interfaces, type aliases, type-only re-exports)
 */
export type ChangeKind = "signature" | "body" | "type";

export interface SymbolChange {
	name: string;
	kind: ChangeKind;
}

export interface ClassifyInput {
	filePath: string;
	before: string;
	after: string;
}

export interface ClassifyResult {
	filePath: string;
	classification: SemanticClass;
	exportedSymbols: {
		added: string[];
		removed: string[];
		changed: SymbolChange[];
	};
	/** 1 when the export surface fully resolved; lowered per unresolvable construct. */
	confidence: number;
	/** Reasons the confidence was lowered (empty when confidence is 1). */
	confidenceNotes: string[];
	/**
	 * True when either version does not parse. The comparison of a recovered
	 * syntax tree can be wrong in either direction, so such a file is
	 * `breaking` whatever the comparison said.
	 */
	syntaxErrors: boolean;
}

export type ChangeClassifier = (
	input: ClassifyInput,
) => Promise<ClassifyResult>;

/**
 * A classifier owning one ts-morph `Project`, reused across every file it is
 * given.
 *
 * Constructing a `Project` builds a TypeScript compiler host and dominates the
 * cost of classification, so a per-file Project makes an N-file diff N times
 * more expensive than it needs to be. `symbol-graph.ts` already creates one
 * Project and calls `createSourceFile(..., { overwrite: true })` per file; this
 * is the same pattern behind a closure. Callers classifying more than one file
 * should hoist a classifier instead of calling `classifyChange` in a loop.
 *
 * The returned function is safe to drive concurrently.
 */
export function createClassifier(): ChangeClassifier {
	// Memoized as a promise, not a value, so concurrent first calls await one
	// construction rather than racing to build several Projects. The import is
	// lazy because ts-morph is ~50MB and must stay off the startup path.
	let host: Promise<{ tsm: TsMorph; project: Project }> | undefined;
	let nextId = 0;

	return async (input: ClassifyInput): Promise<ClassifyResult> => {
		host ??= (async () => {
			const tsm = await import("ts-morph");
			return {
				tsm,
				project: new tsm.Project({
					useInMemoryFileSystem: true,
					compilerOptions: { allowJs: true },
				}),
			};
		})();
		const { tsm, project } = await host;

		// Distinct names per call: two classifications in flight at once must
		// not overwrite each other's source files in the shared Project. The
		// extension decides the grammar, so a .tsx file must stay .tsx: JSX is a
		// syntax error in a .ts file.
		const id = nextId++;
		const ext = sourceExtension(input.filePath);
		const beforeFile = project.createSourceFile(
			`__before_${id}${ext}`,
			input.before,
			{ overwrite: true },
		);
		const afterFile = project.createSourceFile(
			`__after_${id}${ext}`,
			input.after,
			{ overwrite: true },
		);
		try {
			return compareSurfaces(input, beforeFile, afterFile, tsm);
		} finally {
			// Without this the Project accumulates every file it has ever been
			// handed, which is the memory leak version of the problem it solves.
			project.removeSourceFile(beforeFile);
			project.removeSourceFile(afterFile);
		}
	};
}

/**
 * Process-wide default classifier. One-shot callers (and the test suite) get
 * Project reuse without having to thread a classifier through.
 */
let defaultClassifier: ChangeClassifier | undefined;

export async function classifyChange(
	input: ClassifyInput,
): Promise<ClassifyResult> {
	defaultClassifier ??= createClassifier();
	return defaultClassifier(input);
}

function compareSurfaces(
	input: ClassifyInput,
	beforeFile: SourceFile,
	afterFile: SourceFile,
	tsm: TsMorph,
): ClassifyResult {
	const beforeApi = collectExportedSurface(beforeFile, tsm);
	const afterApi = collectExportedSurface(afterFile, tsm);

	const added: string[] = [];
	const removed: string[] = [];
	const changed: SymbolChange[] = [];

	for (const [name, after] of afterApi.symbols) {
		const before = beforeApi.symbols.get(name);
		if (before === undefined) {
			added.push(name);
		} else if (before.signature !== after.signature) {
			changed.push({
				name,
				kind: before.typeSpace && after.typeSpace ? "type" : "signature",
			});
		} else if (before.body !== after.body) {
			changed.push({ name, kind: "body" });
		}
	}
	for (const name of beforeApi.symbols.keys()) {
		if (!afterApi.symbols.has(name)) removed.push(name);
	}

	const surfaceChanged =
		added.length > 0 ||
		removed.length > 0 ||
		changed.some((c) => c.kind !== "body");

	const parseNotes = [
		...(hasParseErrors(beforeFile) ? ["base"] : []),
		...(hasParseErrors(afterFile) ? ["working-tree"] : []),
	].map(
		(side) =>
			`the ${side} version does not parse; classified as breaking without trusting the comparison`,
	);

	let classification: SemanticClass;
	if (surfaceChanged || parseNotes.length > 0) {
		classification = "breaking";
	} else if (
		changed.length > 0 ||
		significantText(input.before, tsm) !== significantText(input.after, tsm)
	) {
		classification = "internal";
	} else {
		classification = "non-impacting";
	}

	const confidenceNotes = [
		...new Set([...parseNotes, ...beforeApi.notes, ...afterApi.notes]),
	];
	const confidence = Math.max(
		0.3,
		Math.round((1 - confidenceNotes.length * 0.15) * 100) / 100,
	);

	return {
		filePath: input.filePath,
		classification,
		exportedSymbols: { added, removed, changed },
		confidence,
		confidenceNotes,
		syntaxErrors: parseNotes.length > 0,
	};
}

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
]);

function sourceExtension(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	const ext = dot === -1 ? "" : filePath.slice(dot);
	return SOURCE_EXTENSIONS.has(ext) ? ext : ".ts";
}

/**
 * `parseDiagnostics` is internal to the TypeScript compiler, but it has held
 * the parser's errors for years and reading it is free. The public routes to
 * the same answer build a Program or parse the file a second time.
 */
function hasParseErrors(file: SourceFile): boolean {
	const { parseDiagnostics } = file.compilerNode as {
		parseDiagnostics?: readonly unknown[];
	};
	return (parseDiagnostics?.length ?? 0) > 0;
}
