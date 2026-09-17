import type { PluginErrorHook } from "../../core/plugins/types.js";
import { getColors } from "../visuals/color.js";
import { getPrinter } from "../visuals/printer.js";
import { errorLines } from "./writer.js";

/**
 * The reporting hook the CLI installs on the PluginRegistry. A plugin hook
 * that throws is a warning, never a failure — the build continues with that
 * plugin's contribution missing, so this only surfaces what went wrong.
 */
export const reportPluginError: PluginErrorHook = (
	err,
	pluginName,
	hook,
	task,
) => {
	const colors = getColors();
	const where = task
		? `${pluginName}.${hook} (${task})`
		: `${pluginName}.${hook}`;
	const detail = err instanceof Error ? err.message : String(err);
	errorLines(
		getPrinter(),
		`${colors.yellow("[variant plugin]")} ${where} threw: ${detail}`,
	);
};
