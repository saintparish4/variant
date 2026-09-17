import { CacheError } from "../../errors.js";
import type { RemoteCacheAdapter } from "../remote-adapter.js";

export interface S3CacheAdapterOptions {
	/** S3 bucket name. */
	bucket: string;
	/** Key prefix for all cache objects. Default: `"variant/"`. */
	prefix?: string;
	/** AWS region (e.g. `"us-east-1"`). */
	region?: string;
	/** Custom endpoint URL — for R2, MinIO, or other S3-compatible stores. */
	endpoint?: string;
	/** Explicit credentials (falls back to SDK credential chain if omitted). */
	credentials?: { accessKeyId: string; secretAccessKey: string };
}

// Minimal duck-type interfaces so we never import SDK types at compile time.
// The real @aws-sdk/client-s3 satisfies all of these at runtime.
interface S3BodyShape {
	transformToByteArray(): Promise<Uint8Array>;
}

interface S3ClientLike {
	send(command: unknown): Promise<{ Body?: S3BodyShape }>;
}

interface S3ModuleLike {
	S3Client: new (opts: {
		region?: string;
		endpoint?: string;
		credentials?: { accessKeyId: string; secretAccessKey: string };
	}) => S3ClientLike;
	HeadObjectCommand: new (opts: { Bucket: string; Key: string }) => unknown;
	GetObjectCommand: new (opts: { Bucket: string; Key: string }) => unknown;
	PutObjectCommand: new (opts: {
		Bucket: string;
		Key: string;
		Body: Uint8Array;
		ContentType: string;
	}) => unknown;
}

async function importS3(): Promise<S3ModuleLike> {
	try {
		// Using a runtime string (not a literal) so TS skips module resolution for
		// this optional peer dep — the cast is safe because we verify the shape at
		// test time via vi.mock and at runtime via the SDK contract.
		const specifier: string = "@aws-sdk/client-s3";
		return (await import(specifier)) as S3ModuleLike;
	} catch {
		throw new CacheError(
			"S3 remote cache requires @aws-sdk/client-s3. Install it with: pnpm add @aws-sdk/client-s3",
		);
	}
}

export function createS3CacheAdapter(
	options: S3CacheAdapterOptions,
): RemoteCacheAdapter {
	const {
		bucket,
		prefix = "variant/",
		region,
		endpoint,
		credentials,
	} = options;

	// Lazily initialised — shared across all method calls on this adapter.
	let statePromise:
		| Promise<{ client: S3ClientLike; mod: S3ModuleLike }>
		| undefined;

	async function getState(): Promise<{
		client: S3ClientLike;
		mod: S3ModuleLike;
	}> {
		if (statePromise === undefined) {
			statePromise = importS3().then((mod) => {
				const client = new mod.S3Client({
					...(region !== undefined ? { region } : {}),
					...(endpoint !== undefined ? { endpoint } : {}),
					...(credentials !== undefined ? { credentials } : {}),
				});
				return { client, mod };
			});
		}
		return statePromise;
	}

	function objectKey(key: string): string {
		return `${prefix}${key}`;
	}

	return {
		async has(key: string): Promise<boolean> {
			const { client, mod } = await getState();
			try {
				await client.send(
					new mod.HeadObjectCommand({ Bucket: bucket, Key: objectKey(key) }),
				);
				return true;
			} catch (err) {
				if (isNoSuchKey(err)) return false;
				throw new CacheError(
					`S3 HeadObject failed for key "${key}": ${String(err)}`,
					{ cause: err },
				);
			}
		},

		async get(key: string): Promise<Uint8Array | null> {
			const { client, mod } = await getState();
			try {
				const res = await client.send(
					new mod.GetObjectCommand({ Bucket: bucket, Key: objectKey(key) }),
				);
				if (res.Body === undefined) return null;
				return await res.Body.transformToByteArray();
			} catch (err) {
				if (isNoSuchKey(err)) return null;
				throw new CacheError(
					`S3 GetObject failed for key "${key}": ${String(err)}`,
					{ cause: err },
				);
			}
		},

		async set(key: string, value: Uint8Array): Promise<void> {
			const { client, mod } = await getState();
			try {
				await client.send(
					new mod.PutObjectCommand({
						Bucket: bucket,
						Key: objectKey(key),
						Body: value,
						ContentType: "application/octet-stream",
					}),
				);
			} catch (err) {
				throw new CacheError(
					`S3 PutObject failed for key "${key}": ${String(err)}`,
					{ cause: err },
				);
			}
		},
	};
}

function isNoSuchKey(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const name = (err as Record<string, unknown>)["name"];
	return name === "NoSuchKey" || name === "NotFound";
}
