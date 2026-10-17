// A Stryker host whose run leaves a directory the cleanup cannot remove, as
// a sandbox Windows still holds after its processes were killed. It reports a
// finished run and stays alive, as the real host does, to be ended by variant.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

process.on("message", (request) => {
	const locked = path.join(request.tempDirName, "locked");
	mkdirSync(locked, { recursive: true });
	writeFileSync(path.join(locked, "held"), "");
	chmodSync(locked, 0o500);
	process.send({ kind: "finished" });
});
