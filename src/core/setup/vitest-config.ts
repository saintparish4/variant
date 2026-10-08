/**
 * @module
 * Adds the adapter to a Vitest config: one import and one entry in
 * `test.reporters`.
 *
 * A config is a program, and only its common shapes can be edited with
 * confidence. Anything else is left exactly as it is and the caller is told
 * what to add by hand: a wrong edit to someone's test config costs them more
 * than a line of typing.
 */

import type {
	ArrayLiteralExpression,
	Node,
	ObjectLiteralExpression,
	SourceFile,
} from "ts-morph";

export const ADAPTER_MODULE = "@blzsky/variant/vitest";

export type ConfigEdit =
	| { kind: "edited"; text: string }
	/** The adapter is already there. */
	| { kind: "present" }
	| { kind: "manual"; reason: string };

/** Helpers that only wrap the config and pass it through. */
const WRAPPERS = new Set(["defineConfig", "defineProject", "mergeConfig"]);

type TsMorph = typeof import("ts-morph");

function indentationOf(source: string): string {
	const indented = /^([ \t]+)\S/m.exec(source);
	if (indented === null) return "\t";
	return indented[1]?.startsWith("\t") ? "\t" : (indented[1] ?? "\t");
}

/**
 * The object literal a config expression comes down to, through the wrappers
 * and through one variable. Undefined when it is built some other way.
 */
function configObject(
	node: Node | undefined,
	tsm: TsMorph,
	hops = 0,
): ObjectLiteralExpression | undefined {
	if (node === undefined || hops > 4) return undefined;
	const { Node: N } = tsm;

	if (N.isObjectLiteralExpression(node)) return node;
	if (N.isParenthesizedExpression(node) || N.isAsExpression(node)) {
		return configObject(node.getExpression(), tsm, hops + 1);
	}
	if (N.isSatisfiesExpression(node)) {
		return configObject(node.getExpression(), tsm, hops + 1);
	}
	if (N.isCallExpression(node)) {
		if (!WRAPPERS.has(node.getExpression().getText())) return undefined;
		// `mergeConfig(base, own)`: the last argument is this file's own.
		return configObject(node.getArguments().at(-1), tsm, hops + 1);
	}
	if (N.isArrowFunction(node)) {
		const body = node.getBody();
		return N.isBlock(body) ? undefined : configObject(body, tsm, hops + 1);
	}
	if (N.isIdentifier(node)) {
		const declaration = node
			.getSourceFile()
			.getVariableDeclaration(node.getText());
		return configObject(declaration?.getInitializer(), tsm, hops + 1);
	}
	return undefined;
}

function objectProperty(
	object: ObjectLiteralExpression,
	name: string,
	tsm: TsMorph,
): Node | undefined | "unreadable" {
	const property = object.getProperty(name);
	if (property === undefined) return undefined;
	return tsm.Node.isPropertyAssignment(property)
		? property.getInitializer()
		: "unreadable";
}

function addImport(file: SourceFile, name: string, isDefault: boolean): void {
	file.addImportDeclaration({
		moduleSpecifier: ADAPTER_MODULE,
		...(isDefault ? { defaultImport: name } : { namedImports: [name] }),
	});
}

/** Vitest's defaults plus the adapter; see `variantReporters`. */
const WITH_DEFAULTS = "variantReporters";

/**
 * The config for a package that runs Vitest with none. It sets nothing but
 * the reporters, so the run is otherwise the one the package had.
 */
export function newConfig(): string {
	return `import { ${WITH_DEFAULTS} } from "${ADAPTER_MODULE}";\n\nexport default {\n\ttest: {\n\t\treporters: ${WITH_DEFAULTS}(),\n\t},\n};\n`;
}

export async function withAdapter(
	source: string,
	fileName: string,
): Promise<ConfigEdit> {
	if (source.includes(ADAPTER_MODULE)) return { kind: "present" };
	if (/\.cjs$/.test(fileName) || /\bmodule\.exports\b/.test(source)) {
		return { kind: "manual", reason: "it is a CommonJS config" };
	}

	const tsm = await import("ts-morph");
	const project = new tsm.Project({
		useInMemoryFileSystem: true,
		manipulationSettings: {
			indentationText: indentationOf(source) as never,
			quoteKind: /from\s+'/.test(source)
				? tsm.QuoteKind.Single
				: tsm.QuoteKind.Double,
			useTrailingCommas: true,
		},
	});
	const file = project.createSourceFile(
		`config${extensionOf(fileName)}`,
		source,
	);

	const exported = file
		.getExportAssignment((assignment) => !assignment.isExportEquals())
		?.getExpression();
	const config = configObject(exported, tsm);
	if (config === undefined) {
		return {
			kind: "manual",
			reason: "its default export is not a plain config object",
		};
	}

	// `variant` is the name the docs use; a config that already has one keeps
	// its own and gets the named export.
	const clash = file.getLocals().some((local) => local.getName() === "variant");
	const name = clash ? "variantReporter" : "variant";

	const test = objectProperty(config, "test", tsm);
	if (test === "unreadable") {
		return {
			kind: "manual",
			reason: "its `test` option is not written inline",
		};
	}
	// A config naming no reporters runs with Vitest's defaults, and has to
	// keep them: see `variantReporters`.
	if (test === undefined) {
		config.addPropertyAssignment({
			name: "test",
			initializer: (writer) =>
				writer.block(() => writer.write(`reporters: ${WITH_DEFAULTS}(),`)),
		});
		addImport(file, WITH_DEFAULTS, false);
		return { kind: "edited", text: file.getFullText() };
	}
	if (!tsm.Node.isObjectLiteralExpression(test)) {
		return {
			kind: "manual",
			reason: "its `test` option is not an object literal",
		};
	}

	const existing = objectProperty(test, "reporters", tsm);
	if (existing === "unreadable") {
		return {
			kind: "manual",
			reason: "its `reporters` are not written inline",
		};
	}
	if (existing === undefined) {
		test.insertPropertyAssignment(0, {
			name: "reporters",
			initializer: `${WITH_DEFAULTS}()`,
		});
		addImport(file, WITH_DEFAULTS, false);
		return { kind: "edited", text: file.getFullText() };
	}
	if (!tsm.Node.isArrayLiteralExpression(existing)) {
		return {
			kind: "manual",
			reason: "its `reporters` option is not an array literal",
		};
	}
	(existing as ArrayLiteralExpression).addElement(`${name}()`);
	addImport(file, name, !clash);
	return { kind: "edited", text: file.getFullText() };
}

function extensionOf(fileName: string): string {
	return /\.[cm]?[jt]s$/.exec(fileName)?.[0] ?? ".ts";
}

/** What to add by hand when the config could not be edited. */
export function manualInstructions(file: string): string[] {
	return [
		`Add the adapter to ${file} yourself:`,
		`  import { ${WITH_DEFAULTS} } from "${ADAPTER_MODULE}";`,
		`  test: { reporters: ${WITH_DEFAULTS}() }`,
		"If the config already lists reporters, import the default export as `variant` and add `variant()` to that list instead.",
	];
}
