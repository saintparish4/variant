import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSymbolGraph,
	defaultGraphDir,
	findSymbol,
	getFileIndex,
	loadSymbolGraph,
	SYMBOL_GRAPH_VERSION,
	saveSymbolGraph,
	updateSymbolGraph,
} from "../symbol-graph.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-symgraph-"));
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

function writeFixture(dir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
}

const FIXTURE = {
	"src/auth.ts": [
		"export interface Session { user: string }",
		"export function login(name: string): Session { return { user: name }; }",
		"export const VERSION = 1;",
	].join("\n"),
	"src/app.ts": [
		'import { login } from "./auth.js";',
		'import type { Session } from "./auth.js";',
		"export function start(): Session { return login('a'); }",
	].join("\n"),
} as const;

describe("buildSymbolGraph", () => {
	it("indexes exported symbols with kinds and hashes", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, FIXTURE);

		const { graph, stats } = await buildSymbolGraph(dir);

		expect(stats).toEqual({ scanned: 2, parsed: 2, reused: 0, removed: 0 });
		const auth = graph.files["src/auth.ts"];
		expect(auth).toBeDefined();
		const byName = new Map(auth?.symbols.map((s) => [s.name, s]));
		expect(byName.get("login")?.kind).toBe("function");
		expect(byName.get("Session")?.kind).toBe("interface");
		expect(byName.get("Session")?.typeSpace).toBe(true);
		expect(byName.get("VERSION")?.kind).toBe("variable");
		expect(byName.get("login")?.signatureHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("records static, type-only, re-export, and dynamic imports", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, {
			"src/m.ts": [
				'import def from "./a.js";',
				'import * as ns from "./b.js";',
				'import { one, two as alias } from "./c.js";',
				'import type { T } from "./d.js";',
				'export { three } from "./e.js";',
				'export * from "./f.js";',
				'export async function load() { return import("./g.js"); }',
			].join("\n"),
		});

		const { graph } = await buildSymbolGraph(dir);
		const imports = graph.files["src/m.ts"]?.imports ?? [];
		const byModule = new Map(imports.map((i) => [i.module, i]));

		expect(byModule.get("./a.js")?.names).toEqual(["default"]);
		expect(byModule.get("./b.js")?.names).toEqual(["*"]);
		expect(byModule.get("./c.js")?.names).toEqual(["one", "two"]);
		expect(byModule.get("./d.js")?.typeOnly).toBe(true);
		expect(byModule.get("./e.js")?.kind).toBe("reexport");
		expect(byModule.get("./e.js")?.names).toEqual(["three"]);
		expect(byModule.get("./f.js")?.kind).toBe("reexport");
		expect(byModule.get("./f.js")?.names).toEqual(["*"]);
		expect(byModule.get("./g.js")?.kind).toBe("dynamic");
	});

	it("records require() and import-equals as whole-module imports", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, {
			"src/m.ts": [
				'import legacy = require("./legacy.js");',
				'import type Types = require("./types.js");',
				'const config = require("./config.js");',
				"export const both: Types.T = [legacy, config];",
			].join("\n"),
		});

		const { graph } = await buildSymbolGraph(dir);
		const imports = graph.files["src/m.ts"]?.imports ?? [];
		const byModule = new Map(imports.map((i) => [i.module, i]));

		expect(byModule.get("./legacy.js")).toEqual({
			module: "./legacy.js",
			kind: "static",
			typeOnly: false,
			names: ["*"],
		});
		expect(byModule.get("./types.js")?.typeOnly).toBe(true);
		expect(byModule.get("./config.js")).toEqual({
			module: "./config.js",
			kind: "static",
			typeOnly: false,
			names: ["*"],
		});
	});

	it("records the static prefix of a computed specifier as a pattern", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, {
			"src/m.ts": [
				`export const load = (lang: string) => import(\`./locales/\${lang}.js\`);`,
				'export const plugin = (name: string) => require("./plugins/" + name + ".js");',
				"export const literal = () => import(`./g.js`);",
				"export const anything = (p: string) => import(p);",
			].join("\n"),
		});

		const { graph } = await buildSymbolGraph(dir);
		const imports = graph.files["src/m.ts"]?.imports ?? [];

		expect(imports).toEqual(
			expect.arrayContaining([
				{ module: "./locales/", kind: "pattern", typeOnly: false, names: [] },
				{ module: "./plugins/", kind: "pattern", typeOnly: false, names: [] },
				{ module: "./g.js", kind: "dynamic", typeOnly: false, names: [] },
				{ module: "", kind: "pattern", typeOnly: false, names: [] },
			]),
		);
		expect(imports).toHaveLength(4);
	});

	it("notes dynamic imports with non-literal specifiers", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, {
			"src/m.ts": "export async function load(p: string) { return import(p); }",
		});
		const { graph } = await buildSymbolGraph(dir);
		expect(
			graph.files["src/m.ts"]?.notes.some((n) =>
				n.includes("non-literal specifier"),
			),
		).toBe(true);
	});

	it("reuses unchanged files on incremental rebuild", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, FIXTURE);

		const first = await buildSymbolGraph(dir);
		const second = await buildSymbolGraph(dir, { previous: first.graph });

		expect(second.stats).toEqual({
			scanned: 2,
			parsed: 0,
			reused: 2,
			removed: 0,
		});
		expect(second.graph.files).toEqual(first.graph.files);
	});

	it("re-parses only changed files and detects hash-level change kind", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, FIXTURE);
		const first = await buildSymbolGraph(dir);

		// Body-only edit: signatureHash stable, bodyHash changes.
		writeFixture(dir, {
			"src/auth.ts": FIXTURE["src/auth.ts"].replace(
				"return { user: name };",
				"const s = { user: name }; return s;",
			),
		});
		const second = await buildSymbolGraph(dir, { previous: first.graph });

		expect(second.stats.parsed).toBe(1);
		expect(second.stats.reused).toBe(1);
		const before = first.graph.files["src/auth.ts"]?.symbols.find(
			(s) => s.name === "login",
		);
		const after = second.graph.files["src/auth.ts"]?.symbols.find(
			(s) => s.name === "login",
		);
		expect(after?.signatureHash).toBe(before?.signatureHash);
		expect(after?.bodyHash).not.toBe(before?.bodyHash);
	});

	it("counts files deleted since the previous build", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, FIXTURE);
		const first = await buildSymbolGraph(dir);

		unlinkSync(path.join(dir, "src", "app.ts"));
		const second = await buildSymbolGraph(dir, { previous: first.graph });

		expect(second.stats.removed).toBe(1);
		expect(second.graph.files["src/app.ts"]).toBeUndefined();
	});

	it("ignores node_modules, dist, and .d.ts files by default", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, {
			"src/a.ts": "export const a = 1;",
			"src/types.d.ts": "export declare const t: number;",
			"node_modules/pkg/index.ts": "export const x = 1;",
			"dist/a.ts": "export const a = 1;",
		});
		const { graph } = await buildSymbolGraph(dir);
		expect(Object.keys(graph.files)).toEqual(["src/a.ts"]);
	});

	it("rejects unsafe include patterns", async () => {
		const dir = makeTmpDir();
		await expect(
			buildSymbolGraph(dir, { include: ["../**/*.ts"] }),
		).rejects.toThrow(/Unsafe glob pattern/);
	});
});

describe("persistence", () => {
	it("round-trips through save and load", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, FIXTURE);
		const { graph } = await buildSymbolGraph(dir);

		const graphDir = defaultGraphDir(dir);
		await saveSymbolGraph(graphDir, graph);
		const loaded = await loadSymbolGraph(graphDir);

		expect(loaded).toEqual(graph);
	});

	it("returns null for a missing graph file", async () => {
		const dir = makeTmpDir();
		expect(await loadSymbolGraph(defaultGraphDir(dir))).toBeNull();
	});

	it("returns null for corrupted or version-mismatched graphs", async () => {
		const dir = makeTmpDir();
		const graphDir = defaultGraphDir(dir);
		mkdirSync(graphDir, { recursive: true });

		writeFileSync(path.join(graphDir, "symbols.json"), "{not json");
		expect(await loadSymbolGraph(graphDir)).toBeNull();

		writeFileSync(
			path.join(graphDir, "symbols.json"),
			JSON.stringify({
				version: SYMBOL_GRAPH_VERSION + 1,
				generatedAt: "",
				files: {},
			}),
		);
		expect(await loadSymbolGraph(graphDir)).toBeNull();
	});

	it("updateSymbolGraph persists and is incremental across calls", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, FIXTURE);

		const first = await updateSymbolGraph(dir);
		expect(first.stats.parsed).toBe(2);

		const second = await updateSymbolGraph(dir);
		expect(second.stats).toEqual({
			scanned: 2,
			parsed: 0,
			reused: 2,
			removed: 0,
		});
		expect(await loadSymbolGraph(defaultGraphDir(dir))).toEqual(second.graph);
	});
});

describe("queries", () => {
	it("findSymbol returns every file exporting the name", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, {
			"src/a.ts": "export function run(): number { return 1; }",
			"src/b.ts": "export const run = 2;",
		});
		const { graph } = await buildSymbolGraph(dir);

		const hits = findSymbol(graph, "run");
		expect(hits.map((h) => h.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("getFileIndex normalizes Windows-style separators", async () => {
		const dir = makeTmpDir();
		writeFixture(dir, FIXTURE);
		const { graph } = await buildSymbolGraph(dir);

		expect(getFileIndex(graph, "src\\auth.ts")).toBeDefined();
		expect(getFileIndex(graph, "src/auth.ts")).toBeDefined();
		expect(getFileIndex(graph, "src/missing.ts")).toBeUndefined();
	});
});
