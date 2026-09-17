import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CacheError } from "../../errors.js";
import { readCache, writeCache, writeCacheSync } from "../store.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "variant-store-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

describe("readCache", () => {
	it("returns empty tasks when cache dir does not exist", async () => {
		const dir = path.join(makeTmpDir(), "nonexistent");
		const cache = await readCache(dir);
		expect(cache).toEqual({ tasks: {} });
	});

	it("returns empty tasks when cache file does not exist", async () => {
		const dir = makeTmpDir();
		const cache = await readCache(dir);
		expect(cache).toEqual({ tasks: {} });
	});

	it("reads and parses a valid cache file", async () => {
		const dir = makeTmpDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "cache.json"),
			JSON.stringify({ tasks: { build: { hash: "abc", lastRun: 123 } } }),
		);
		const cache = await readCache(dir);
		expect(cache.tasks["build"]?.hash).toBe("abc");
		expect(cache.tasks["build"]?.lastRun).toBe(123);
	});

	it("throws CacheError on malformed JSON", async () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "cache.json"), "NOT JSON{{{");
		await expect(readCache(dir)).rejects.toBeInstanceOf(CacheError);
	});

	it("CacheError preserves cause", async () => {
		const dir = makeTmpDir();
		writeFileSync(path.join(dir, "cache.json"), "BROKEN");
		try {
			await readCache(dir);
		} catch (err) {
			expect(err).toBeInstanceOf(CacheError);
			expect((err as CacheError).cause).toBeDefined();
		}
	});
});

describe("writeCache", () => {
	it("creates directory and writes valid JSON", async () => {
		const dir = path.join(makeTmpDir(), "nested", "cache");
		await writeCache(dir, { tasks: { t: { lastRun: 1 } } });
		const result = await readCache(dir);
		expect(result.tasks["t"]?.lastRun).toBe(1);
	});

	it("round-trip: write then read returns equal data", async () => {
		const dir = makeTmpDir();
		const data = {
			tasks: {
				build: { hash: "h1", lastRun: 100, lastDurationMs: 50 },
				lint: { lastRun: 200 },
			},
		};
		await writeCache(dir, data);
		const result = await readCache(dir);
		expect(result).toEqual(data);
	});
});

describe("writeCacheSync", () => {
	it("round-trip works synchronously", async () => {
		const dir = path.join(makeTmpDir(), "sync-cache");
		writeCacheSync(dir, { tasks: { x: { lastRun: 99 } } });
		const result = await readCache(dir);
		expect(result.tasks["x"]?.lastRun).toBe(99);
	});

	it("creates directory recursively", async () => {
		const dir = path.join(makeTmpDir(), "a", "b", "c");
		writeCacheSync(dir, { tasks: {} });
		expect(await readCache(dir)).toEqual({ tasks: {} });
	});
});

describe("atomic cache writes", () => {
	/**
	 * The failure this replaced: a crash between `open(O_TRUNC)` and the last
	 * byte left `cache.json` truncated, and `readCache` could only report it as
	 * corrupt — recoverable by hand-deleting the cache directory.
	 *
	 * Skipped where the permission bits cannot be trusted to deny the write:
	 * Windows ignores them, and root ignores them everywhere.
	 */
	const canDenyWrites =
		process.platform !== "win32" &&
		(typeof process.getuid !== "function" || process.getuid() !== 0);

	it.skipIf(!canDenyWrites)(
		"test_atomic_write_preserves_previous_cache",
		async () => {
			const cacheDir = path.join(makeTmpDir(), "cache");
			await writeCache(cacheDir, { tasks: { a: { lastRun: 1 } } });

			chmodSync(cacheDir, 0o500);
			try {
				await expect(
					writeCache(cacheDir, { tasks: { a: { lastRun: 2 } } }),
				).rejects.toThrow(CacheError);
				expect(await readCache(cacheDir)).toEqual({
					tasks: { a: { lastRun: 1 } },
				});
			} finally {
				chmodSync(cacheDir, 0o700);
			}
		},
	);

	it("test_no_temp_files_left_behind: a successful write leaves only cache.json", async () => {
		const dir = makeTmpDir();
		await writeCache(dir, { tasks: { a: { lastRun: 1 } } });
		writeCacheSync(dir, { tasks: { a: { lastRun: 2 } } });

		expect(readdirSync(dir)).toEqual(["cache.json"]);
		expect(await readCache(dir)).toEqual({ tasks: { a: { lastRun: 2 } } });
	});

	it("reports an unwritable location as a CacheError", async () => {
		const dir = makeTmpDir();
		const notADirectory = path.join(dir, "occupied");
		writeFileSync(notADirectory, "x");

		await expect(writeCache(notADirectory, { tasks: {} })).rejects.toThrow(
			CacheError,
		);
	});

	it("writes compact JSON, not an indented document", async () => {
		const dir = makeTmpDir();
		await writeCache(dir, { tasks: { a: { lastRun: 1 } } });

		expect(readFileSync(path.join(dir, "cache.json"), "utf8")).toBe(
			'{"tasks":{"a":{"lastRun":1}}}',
		);
	});
});
