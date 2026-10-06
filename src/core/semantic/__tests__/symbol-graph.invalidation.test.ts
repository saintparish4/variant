/**
 * The persisted symbol index reuses a file's entry by content hash. These
 * tests hold it to one rule: whatever happened between runs, the incremental
 * index equals the one a cold build produces.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Random } from "../../../__tests__/helpers/seeded-random.js";
import {
	seededRandom,
	seeds,
} from "../../../__tests__/helpers/seeded-random.js";
import type { SymbolGraph } from "../symbol-graph.js";
import {
	buildSymbolGraph,
	defaultGraphDir,
	loadSymbolGraph,
	SYMBOL_GRAPH_VERSION,
	saveSymbolGraph,
	updateSymbolGraph,
} from "../symbol-graph.js";

// Every build constructs a ts-morph Project, about half a second each, and a
// round runs two. Twelve rounds of one to three operations each cover every
// operation kind many times over.
const SEQUENCES = 3;
const ROUNDS = 4;
const SEQUENCE_BUDGET_MS = 60_000;

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-symgraph-inval-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// Windows holds directory handles briefly; the OS cleans these up eventually.
		}
	}
	tmpDirs.length = 0;
});

function write(dir: string, relPath: string, content: string): void {
	const abs = path.join(dir, relPath);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

/**
 * A module importing some of the others. `derived` takes its inferred type
 * from an import, so its recorded signature is only stable if each file is
 * indexed without the others.
 */
function moduleSource(random: Random, others: readonly string[]): string {
	const imported = others.filter(() => random.chance(0.4));
	const imports = imported.map(
		(other, i) =>
			`import { value as v${i} } from "./${path.posix.basename(other, ".ts")}.js";`,
	);
	const exports = Array.from(
		{ length: random.int(1, 3) },
		(_, i) =>
			`export function f${i}(x: number): ${random.pick(["number", "string"])} { return ${random.pick(["x", "String(x)"])} as never; }`,
	);
	return [
		...imports,
		`export const value = ${random.pick(["1", '"one"', "true"])};`,
		...(imported.length > 0 ? ["export const derived = v0;"] : []),
		...exports,
	].join("\n");
}

type Operation = "edit" | "delete" | "rename" | "add";

function applyRandomOperation(
	dir: string,
	files: string[],
	random: Random,
	nextId: () => number,
): Operation {
	const operation: Operation =
		files.length <= 1
			? "add"
			: random.pick(["edit", "delete", "rename", "add"]);
	const target = files.length > 0 ? random.pick(files) : undefined;
	switch (operation) {
		case "edit":
			if (target !== undefined) {
				write(dir, target, moduleSource(random, files));
			}
			break;
		case "delete":
			if (target !== undefined) {
				unlinkSync(path.join(dir, target));
				files.splice(files.indexOf(target), 1);
			}
			break;
		case "rename":
			if (target !== undefined) {
				const renamed = `src/m${nextId()}.ts`;
				renameSync(path.join(dir, target), path.join(dir, renamed));
				files.splice(files.indexOf(target), 1, renamed);
			}
			break;
		case "add": {
			const added = `src/m${nextId()}.ts`;
			write(dir, added, moduleSource(random, files));
			files.push(added);
			break;
		}
	}
	return operation;
}

async function coldFiles(dir: string): Promise<SymbolGraph["files"]> {
	return (await buildSymbolGraph(dir)).graph.files;
}

describe("symbol index invalidation", () => {
	it(
		"an incremental index equals a cold build after any edit, delete, rename or add",
		async () => {
			for (const seed of seeds(SEQUENCES)) {
				const random = seededRandom(seed);
				const dir = makeTmpDir();
				let id = 0;
				const nextId = () => id++;
				const files: string[] = [];
				for (let i = 0; i < 4; i++) {
					const file = `src/m${nextId()}.ts`;
					write(dir, file, moduleSource(random, files));
					files.push(file);
				}
				await updateSymbolGraph(dir);

				const history: Operation[] = [];
				for (let round = 0; round < ROUNDS; round++) {
					for (let n = random.int(1, 3); n > 0; n--) {
						history.push(applyRandomOperation(dir, files, random, nextId));
					}

					const incremental = await updateSymbolGraph(dir);

					const context = `seed ${seed}, round ${round}: ${history.join(", ")}`;
					expect(incremental.graph.files, context).toEqual(
						await coldFiles(dir),
					);
					expect(
						incremental.stats.parsed + incremental.stats.reused,
						context,
					).toBe(incremental.stats.scanned);
				}
			}
		},
		SEQUENCE_BUDGET_MS,
	);

	it("a file's entry does not depend on the other files parsed in the same run", async () => {
		const dependent = 'import { a } from "./a.js";\nexport const b = a;';
		const withImport = makeTmpDir();
		write(withImport, "src/a.ts", "export const a = 1;");
		write(withImport, "src/b.ts", dependent);
		const alone = makeTmpDir();
		write(alone, "src/b.ts", dependent);

		const together = await buildSymbolGraph(withImport);
		const apart = await buildSymbolGraph(alone);

		expect(together.graph.files["src/b.ts"]).toEqual(
			apart.graph.files["src/b.ts"],
		);
	});

	it("a rename drops the old path and indexes the new one", async () => {
		const dir = makeTmpDir();
		write(dir, "src/a.ts", "export const a = 1;");
		write(dir, "src/b.ts", 'import { a } from "./a.js";\nexport const b = a;');
		const first = await buildSymbolGraph(dir);

		renameSync(path.join(dir, "src/a.ts"), path.join(dir, "src/c.ts"));
		const second = await buildSymbolGraph(dir, { previous: first.graph });

		expect(second.graph.files).toEqual(await coldFiles(dir));
		expect(second.graph.files["src/a.ts"]).toBeUndefined();
		expect(second.stats.removed).toBe(1);
	});

	it("an index from another extractor version is dropped, even where content hashes match", async () => {
		const dir = makeTmpDir();
		write(dir, "src/a.ts", 'const lazy = require("./b");\nexport const a = 1;');
		write(dir, "src/b.ts", "export const b = 2;");
		const current = await buildSymbolGraph(dir);

		// An older extractor that saw no require() edges: same content hashes,
		// fewer imports. Reusing its entries would silently lose the edge.
		const stale: SymbolGraph = {
			...current.graph,
			version: SYMBOL_GRAPH_VERSION - 1,
			files: Object.fromEntries(
				Object.entries(current.graph.files).map(([file, index]) => [
					file,
					{ ...index, imports: [], notes: [] },
				]),
			),
		};
		const graphDir = defaultGraphDir(dir);
		await saveSymbolGraph(graphDir, stale);

		expect(await loadSymbolGraph(graphDir)).toBeNull();
		const passedIn = await buildSymbolGraph(dir, { previous: stale });
		expect(passedIn.stats.reused).toBe(0);
		expect(passedIn.graph.files).toEqual(current.graph.files);

		const updated = await updateSymbolGraph(dir);
		expect(updated.stats.reused).toBe(0);
		expect(updated.graph.files).toEqual(current.graph.files);
		expect((await loadSymbolGraph(graphDir))?.version).toBe(
			SYMBOL_GRAPH_VERSION,
		);
	});

	it.each([
		["truncated JSON", (valid: string) => valid.slice(0, valid.length / 2)],
		["an empty file", () => ""],
		["a JSON array", () => "[]"],
		[
			"files set to null",
			(valid: string) => JSON.stringify({ ...JSON.parse(valid), files: null }),
		],
	])("a corrupt index (%s) is rebuilt from scratch", async (_, corrupt) => {
		const dir = makeTmpDir();
		write(dir, "src/a.ts", "export const a = 1;");
		write(dir, "src/b.ts", 'import { a } from "./a.js";\nexport const b = a;');
		await updateSymbolGraph(dir);

		const indexPath = path.join(defaultGraphDir(dir), "symbols.json");
		writeFileSync(indexPath, corrupt(readFileSync(indexPath, "utf8")));

		const rebuilt = await updateSymbolGraph(dir);

		expect(rebuilt.stats).toEqual({
			scanned: 2,
			parsed: 2,
			reused: 0,
			removed: 0,
		});
		expect(rebuilt.graph.files).toEqual(await coldFiles(dir));
		expect(await loadSymbolGraph(defaultGraphDir(dir))).toEqual(rebuilt.graph);
	});
});
