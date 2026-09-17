import * as z from "zod";

const defaultCache = {
	mode: "content" as const,
	directory: ".variant/cache",
};

export const taskConfigSchema = z.object({
	inputs: z.array(z.string()).optional(),
	dependsOn: z.array(z.string()).optional(),
	command: z.string().optional(),
	/** Phase 4: scheduler hint. */
	cpuHeavy: z.boolean().optional(),
});

export const remoteCacheConfigSchema = z.object({
	type: z.enum(["http", "s3"]),
	/** Base URL for the HTTP backend. */
	url: z.string().optional(),
	/** S3 bucket name. */
	bucket: z.string().optional(),
	/** Key prefix for S3 objects. Default: `"variant/"`. */
	prefix: z.string().optional(),
	/** AWS region or S3-compatible endpoint region. */
	region: z.string().optional(),
	/** Custom endpoint URL for R2, MinIO, etc. */
	endpoint: z.string().optional(),
	/** Extra HTTP headers sent with every request (e.g. Authorization). */
	headers: z.record(z.string(), z.string()).optional(),
	/** Per-request timeout in milliseconds. Default: 10 000. */
	timeout: z.number().optional(),
	/**
	 * Maximum HTTP GET response body in bytes. Guards against a hostile or
	 * buggy endpoint exhausting memory. Default: 1 MiB. HTTP backend only.
	 */
	maxResponseBytes: z.number().optional(),
});

export const variantConfigSchema = z
	.object({
		strategy: z.enum(["adaptive", "strict"]).default("adaptive"),
		cache: z
			.object({
				mode: z.literal("content").default(defaultCache.mode),
				directory: z.string().default(defaultCache.directory),
				/** Optional remote cache backend shared across machines. */
				remote: remoteCacheConfigSchema.optional(),
				/**
				 * Threshold used in `variant insight` to estimate the cost of a
				 * remote cache miss (milliseconds). When omitted the raw
				 * `lastDurationMs` of each task is used directly.
				 */
				costPerMissMs: z.number().optional(),
				/** Evict local cache entries older than this many days. */
				ttlDays: z.number().optional(),
			})
			.default(defaultCache),
		tasks: z.record(z.string(), taskConfigSchema).default({}),
		workspace: z
			.object({
				enabled: z.boolean().default(false),
				scripts: z.array(z.string()).default(["build", "test", "lint"]),
			})
			.optional(),
		git: z
			.object({
				baseRef: z.string().default("HEAD~1"),
				enabled: z.boolean().default(true),
			})
			.optional(),
		semanticDiff: z
			.object({
				enabled: z.boolean().default(false),
			})
			.optional(),
		scheduler: z
			.object({
				policy: z
					.enum(["auto", "light-first", "pack-heavy", "critical-path"])
					.default("auto"),
			})
			.optional(),
		performance: z
			.object({
				criticalPaths: z.array(z.string()).default([]),
				lintOnlyForNonCritical: z.boolean().default(false),
			})
			.optional(),
	})
	.superRefine((val, ctx) => {
		const taskNames = new Set(Object.keys(val.tasks));
		for (const [name, cfg] of Object.entries(val.tasks)) {
			for (const dep of cfg.dependsOn ?? []) {
				if (!taskNames.has(dep)) {
					ctx.addIssue({
						code: "custom",
						path: ["tasks", name, "dependsOn"],
						message: `references unknown task "${dep}" — add it to config.tasks or remove the reference`,
					});
				}
			}
		}
	});
