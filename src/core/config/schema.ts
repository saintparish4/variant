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

export const variantConfigSchema = z
	.object({
		strategy: z.enum(["adaptive", "strict"]).default("adaptive"),
		cache: z
			.object({
				mode: z.literal("content").default(defaultCache.mode),
				directory: z.string().default(defaultCache.directory),
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
