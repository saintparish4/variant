import { describe, expect, it } from "vitest";
import type { StrykerObjectUtils } from "../stryker-worker-kill.js";
import {
	strykerObjectUtils,
	tolerateFailedKills,
} from "../stryker-worker-kill.js";

describe("Stryker's worker kill", () => {
	// Windows: taskkill on a worker already on its way out fails, and the
	// error replaced a failing baseline.
	it("succeeds where taskkill could not end the worker", async () => {
		const utils: StrykerObjectUtils = {
			kill: async () => {
				throw new Error("Command failed: taskkill /pid 4242 /T /F");
			},
		};

		tolerateFailedKills(utils);

		await expect(utils.kill(4242)).resolves.toBeUndefined();
	});

	it("still kills", async () => {
		const killed: (number | undefined)[] = [];
		const utils: StrykerObjectUtils = {
			kill: async (pid) => {
				killed.push(pid);
			},
		};

		tolerateFailedKills(utils);
		await utils.kill(4242);

		expect(killed).toEqual([4242]);
	});

	// A Stryker upgrade that moves the file would quietly undo the fix.
	it("is found in the Stryker this package depends on", async () => {
		const utils = await strykerObjectUtils();

		expect(typeof utils?.kill).toBe("function");
	});
});
