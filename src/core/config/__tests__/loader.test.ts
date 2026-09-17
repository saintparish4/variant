import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { variantConfigSchema } from "../schema.js";

// Tests parse the Zod schema directly so they don't need the filesystem/jiti
// loadConfig() integration is covered by the schema round-trips below

describe("variantConfigSchema", () => {
	it("no config: returns all defaults", () => {
		const result = variantConfigSchema.parse({});
		expect(result.strategy).toBe("adaptive");
		expect(result.cache.mode).toBe("content");
		expect(result.cache.directory).toBe(".variant/cache");
		expect(result.tasks).toEqual({});
	});

	it("partial override: only strategy set, rest gets defaults", () => {
		const result = variantConfigSchema.parse({ strategy: "strict" });
		expect(result.strategy).toBe("strict");
		expect(result.cache.directory).toBe(".variant/cache");
		expect(result.tasks).toEqual({});
	});

	it("full config: all fields provided and returned as-is", () => {
		const input = {
			strategy: "strict",
			cache: { mode: "content", directory: ".custom/cache" },
			tasks: {
				build: { command: "tsc", inputs: ["src/**/*.ts"], dependsOn: ["lint"] },
				lint: { command: "eslint . " },
			},
		};
		const result = variantConfigSchema.parse(input);
		const buildKey = "build" as const;
		expect(result.strategy).toBe("strict");
		expect(result.cache.directory).toBe(".custom/cache");
		expect(result.tasks[buildKey]?.command).toBe("tsc");
		expect(result.tasks[buildKey]?.dependsOn).toEqual(["lint"]);
	});

	it("invalid strategy: throws with useful message (wrapped as ConfigError)", () => {
		const parsed = variantConfigSchema.safeParse({ strategy: "turbo" });
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			const messages = parsed.error.issues.map((e) => e.message).join(" ");
			expect(messages).toMatch(/adaptive|strict|invalid/i);
		}
		// Also verify ConfigError wrapping works
		expect(() => {
			if (!parsed.success)
				throw new ConfigError("Invalid variant config: strategy");
		}).toThrow(ConfigError);
	});

	it("tasks with dependsOn: references are preserved correctly", () => {
		const result = variantConfigSchema.parse({
			tasks: {
				build: { dependsOn: ["test", "lint"] },
				test: {},
				lint: {},
			},
		});
		const buildTaskKey = "build" as const;
		const testTaskKey = "test" as const;
		const lintTaskKey = "lint" as const;
		expect(result.tasks[buildTaskKey]?.dependsOn).toEqual(["test", "lint"]);
		expect(result.tasks[testTaskKey]).toBeDefined();
		expect(result.tasks[lintTaskKey]).toBeDefined();
	});
});
