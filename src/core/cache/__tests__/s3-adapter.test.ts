import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheError } from "../../errors.js";
import { createS3CacheAdapter } from "../adapters/s3-adapter.js";

// vi.hoisted() runs before vi.mock() factories and before any imports, so
// these references are fully initialised when the class fields are evaluated.
const mockSend = vi.hoisted(() => vi.fn());
const s3ClientCount = vi.hoisted(() => ({ value: 0 }));

// All four classes use class syntax — arrow functions are NOT valid constructors
// and Vitest 4.x calls `new impl()` internally, which throws for arrow fns.
vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: class {
		send = mockSend;
		constructor() {
			s3ClientCount.value++;
		}
	},
	HeadObjectCommand: class {
		input: Record<string, unknown>;
		constructor(args: Record<string, unknown>) {
			this.input = args;
		}
	},
	GetObjectCommand: class {
		input: Record<string, unknown>;
		constructor(args: Record<string, unknown>) {
			this.input = args;
		}
	},
	PutObjectCommand: class {
		input: Record<string, unknown>;
		constructor(args: Record<string, unknown>) {
			this.input = args;
		}
	},
}));

function noSuchKeyError(): Error {
	return Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
}

beforeEach(() => {
	mockSend.mockReset();
	s3ClientCount.value = 0;
});

describe("S3CacheAdapter.has()", () => {
	it("returns true when HeadObjectCommand succeeds", async () => {
		mockSend.mockResolvedValue({});
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		expect(await adapter.has("abc123")).toBe(true);
	});

	it("returns false on NoSuchKey error", async () => {
		mockSend.mockRejectedValue(noSuchKeyError());
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		expect(await adapter.has("abc123")).toBe(false);
	});

	it("returns false on NotFound error", async () => {
		mockSend.mockRejectedValue(
			Object.assign(new Error("NotFound"), { name: "NotFound" }),
		);
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		expect(await adapter.has("abc123")).toBe(false);
	});

	it("throws CacheError for unexpected errors", async () => {
		mockSend.mockRejectedValue(new Error("NetworkError"));
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		await expect(adapter.has("abc123")).rejects.toBeInstanceOf(CacheError);
	});

	it("uses default prefix in object key", async () => {
		mockSend.mockResolvedValue({});
		const adapter = createS3CacheAdapter({ bucket: "b" });
		await adapter.has("hashval");
		const cmd = mockSend.mock.calls[0]?.[0] as {
			input?: { Key?: string };
		};
		expect(cmd?.input?.Key).toBe("variant/hashval");
	});

	it("uses custom prefix in object key", async () => {
		mockSend.mockResolvedValue({});
		const adapter = createS3CacheAdapter({ bucket: "b", prefix: "ci/" });
		await adapter.has("hashval");
		const cmd = mockSend.mock.calls[0]?.[0] as {
			input?: { Key?: string };
		};
		expect(cmd?.input?.Key).toBe("ci/hashval");
	});
});

describe("S3CacheAdapter.get()", () => {
	it("returns bytes when GetObjectCommand succeeds", async () => {
		const bytes = new Uint8Array([7, 8, 9]);
		mockSend.mockResolvedValue({
			Body: { transformToByteArray: async () => bytes },
		});
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		expect(await adapter.get("key1")).toEqual(bytes);
	});

	it("returns null on NoSuchKey", async () => {
		mockSend.mockRejectedValue(noSuchKeyError());
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		expect(await adapter.get("key1")).toBeNull();
	});

	it("returns null when Body is undefined", async () => {
		mockSend.mockResolvedValue({ Body: undefined });
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		expect(await adapter.get("key1")).toBeNull();
	});

	it("throws CacheError for unexpected errors", async () => {
		mockSend.mockRejectedValue(new Error("InternalError"));
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		await expect(adapter.get("key1")).rejects.toBeInstanceOf(CacheError);
	});
});

describe("S3CacheAdapter.set()", () => {
	it("calls PutObjectCommand with correct Bucket, Key, Body, and ContentType", async () => {
		mockSend.mockResolvedValue({});
		const bytes = new Uint8Array([1, 2]);
		const adapter = createS3CacheAdapter({
			bucket: "my-bucket",
			prefix: "test/",
		});
		await adapter.set("key2", bytes);
		expect(mockSend).toHaveBeenCalledOnce();
		const cmd = mockSend.mock.calls[0]?.[0] as {
			input?: {
				Bucket?: string;
				Key?: string;
				Body?: Uint8Array;
				ContentType?: string;
			};
		};
		expect(cmd?.input?.Bucket).toBe("my-bucket");
		expect(cmd?.input?.Key).toBe("test/key2");
		expect(cmd?.input?.Body).toBe(bytes);
		expect(cmd?.input?.ContentType).toBe("application/octet-stream");
	});

	it("throws CacheError on PutObjectCommand failure", async () => {
		mockSend.mockRejectedValue(new Error("AccessDenied"));
		const adapter = createS3CacheAdapter({ bucket: "my-bucket" });
		await expect(adapter.set("key3", new Uint8Array())).rejects.toBeInstanceOf(
			CacheError,
		);
	});
});

describe("S3CacheAdapter — shared S3Client", () => {
	it("reuses a single S3Client instance across multiple calls", async () => {
		mockSend.mockResolvedValue({});
		const adapter = createS3CacheAdapter({ bucket: "b" });
		await adapter.has("k1");
		await adapter.has("k2");
		expect(s3ClientCount.value).toBe(1);
	});
});
