/**
 * @module
 * Per-file export-surface extraction shared by the change classifier
 * (`differ.ts`) and the symbol indexer (`symbol-graph.ts`). Every exported
 * symbol is reduced to a normalized `signature` (the public shape callers see)
 * and a `body` (implementation text), so consumers can distinguish API changes
 * from implementation changes.
 *
 * All functions receive the lazily-imported ts-morph module as a parameter so
 * that ts-morph (~50MB) stays off the CLI startup critical path.
 */

import type {
	ClassDeclaration,
	ClassMemberTypes,
	ExportedDeclarations,
	ParameterDeclaration,
	SourceFile,
	Type,
} from "ts-morph";

export type TsMorph = typeof import("ts-morph");

/** Declaration category of an exported symbol. */
export type SymbolKind =
	| "function"
	| "class"
	| "interface"
	| "type"
	| "enum"
	| "variable"
	| "namespace"
	| "reexport"
	| "unknown";

export interface SymbolSurface {
	/** Normalized public shape; a difference here is a signature/type change. */
	signature: string;
	/** Normalized implementation text; a difference here is a body change. */
	body: string;
	/** True when the symbol exists only in type space. */
	typeSpace: boolean;
	kind: SymbolKind;
}

export interface FileSurface {
	symbols: Map<string, SymbolSurface>;
	notes: string[];
}

export function collectExportedSurface(
	file: SourceFile,
	tsm: TsMorph,
): FileSurface {
	const symbols = new Map<string, SymbolSurface>();
	const notes: string[] = [];

	// Re-exports (`export { a } from "./m"`, `export * from "./m"`,
	// `export * as ns from "./m"`) and exports of imported names cannot be
	// resolved inside a single-file project, so track them by specifier text —
	// changes to the underlying module are that module's own diff to report.
	for (const decl of file.getExportDeclarations()) {
		const moduleSpec = decl.getModuleSpecifierValue();
		const declTypeOnly = decl.isTypeOnly();
		const named = decl.getNamedExports();

		if (moduleSpec === undefined) {
			// `export { x }` — x is either a local declaration (resolved below via
			// getExportedDeclarations) or an imported name (a re-export in disguise).
			for (const spec of named) {
				const source = findImportSource(file, spec.getName());
				if (source === undefined) continue;
				const typeOnly = declTypeOnly || spec.isTypeOnly() || source.typeOnly;
				symbols.set(spec.getAliasNode()?.getText() ?? spec.getName(), {
					signature: reexportSignature(spec.getName(), source.module, typeOnly),
					body: "",
					typeSpace: typeOnly,
					kind: "reexport",
				});
			}
			continue;
		}

		if (named.length > 0) {
			for (const spec of named) {
				const typeOnly = declTypeOnly || spec.isTypeOnly();
				symbols.set(spec.getAliasNode()?.getText() ?? spec.getName(), {
					signature: reexportSignature(spec.getName(), moduleSpec, typeOnly),
					body: "",
					typeSpace: typeOnly,
					kind: "reexport",
				});
			}
			continue;
		}

		const namespaceExport = decl.getNamespaceExport();
		if (namespaceExport !== undefined) {
			symbols.set(namespaceExport.getName(), {
				signature: reexportSignature("*", moduleSpec, declTypeOnly),
				body: "",
				typeSpace: declTypeOnly,
				kind: "reexport",
			});
			continue;
		}

		// `export * from "./m"` — the exported names are unknowable per-file.
		symbols.set(`* from ${moduleSpec}`, {
			signature: reexportSignature("*", moduleSpec, declTypeOnly),
			body: "",
			typeSpace: declTypeOnly,
			kind: "reexport",
		});
		notes.push(`export * from "${moduleSpec}" hides which names are exported`);
	}

	for (const [name, decls] of file.getExportedDeclarations()) {
		if (symbols.has(name) || decls.length === 0) continue;

		if (decls.some((d) => tsm.Node.isModuleDeclaration(d))) {
			notes.push(`"${name}" uses namespace/declaration merging`);
		} else if (new Set(decls.map((d) => d.getKind())).size > 1) {
			notes.push(`"${name}" merges declarations of different kinds`);
		}

		const surfaces = decls.map((d) => declarationSurface(d, tsm));
		const first = surfaces[0];
		symbols.set(name, {
			signature: surfaces.map((s) => s.signature).join(" & "),
			body: surfaces
				.map((s) => s.body)
				.filter((b) => b !== "")
				.join(" "),
			typeSpace: surfaces.every((s) => s.typeSpace),
			kind: first === undefined ? "unknown" : first.kind,
		});
	}

	if (hasDynamicImport(file, tsm)) {
		notes.push("dynamic import() prevents full static resolution");
	}

	return { symbols, notes };
}

function reexportSignature(
	name: string,
	module: string,
	typeOnly: boolean,
): string {
	return `reexport ${name} from ${module}${typeOnly ? " (type-only)" : ""}`;
}

function findImportSource(
	file: SourceFile,
	localName: string,
): { module: string; typeOnly: boolean } | undefined {
	for (const imp of file.getImportDeclarations()) {
		const module = imp.getModuleSpecifierValue();
		const typeOnly = imp.isTypeOnly();
		if (imp.getDefaultImport()?.getText() === localName) {
			return { module, typeOnly };
		}
		if (imp.getNamespaceImport()?.getText() === localName) {
			return { module, typeOnly };
		}
		for (const named of imp.getNamedImports()) {
			const local = named.getAliasNode()?.getText() ?? named.getName();
			if (local === localName) {
				return { module, typeOnly: typeOnly || named.isTypeOnly() };
			}
		}
	}
	return undefined;
}

function declarationSurface(
	decl: ExportedDeclarations,
	tsm: TsMorph,
): SymbolSurface {
	if (tsm.Node.isFunctionDeclaration(decl)) {
		return {
			signature: functionSignature(decl, tsm),
			body: significantText(
				`${decl.getBody()?.getText() ?? ""} ${parameterDefaults(decl)}`,
				tsm,
			),
			typeSpace: false,
			kind: "function",
		};
	}

	if (tsm.Node.isVariableDeclaration(decl)) {
		const init = decl.getInitializer();
		if (
			init !== undefined &&
			(tsm.Node.isArrowFunction(init) || tsm.Node.isFunctionExpression(init))
		) {
			return {
				signature:
					normalize(decl.getTypeNode()?.getText() ?? "") ||
					functionSignature(init, tsm),
				body: significantText(
					`${init.getBody().getText()} ${parameterDefaults(init)}`,
					tsm,
				),
				typeSpace: false,
				kind: "function",
			};
		}
		const typeText =
			decl.getTypeNode()?.getText() ??
			inferTypeText(() =>
				decl
					.getType()
					.getBaseTypeOfLiteralType()
					.getText(undefined, tsm.TypeFormatFlags.NoTruncation),
			);
		return {
			signature: normalize(typeText),
			body: significantText(init?.getText() ?? "", tsm),
			typeSpace: false,
			kind: "variable",
		};
	}

	if (tsm.Node.isClassDeclaration(decl)) {
		return classSurface(decl, tsm);
	}

	if (tsm.Node.isInterfaceDeclaration(decl)) {
		return {
			signature: significantText(decl.getText(), tsm),
			body: "",
			typeSpace: true,
			kind: "interface",
		};
	}

	if (tsm.Node.isTypeAliasDeclaration(decl)) {
		return {
			signature: significantText(decl.getText(), tsm),
			body: "",
			typeSpace: true,
			kind: "type",
		};
	}

	if (tsm.Node.isEnumDeclaration(decl)) {
		return {
			signature: significantText(decl.getText(), tsm),
			body: "",
			typeSpace: false,
			kind: "enum",
		};
	}

	if (tsm.Node.isModuleDeclaration(decl)) {
		return {
			signature: significantText(decl.getText(), tsm),
			body: "",
			typeSpace: false,
			kind: "namespace",
		};
	}

	// `export default <expr>`, export assignments, … — their full text is
	// their public shape.
	return {
		signature: significantText(decl.getText(), tsm),
		body: "",
		typeSpace: false,
		kind: "unknown",
	};
}

interface SignatureBearer {
	getTypeParameters(): { getText(): string }[];
	getParameters(): ParameterDeclaration[];
	getReturnTypeNode(): { getText(): string } | undefined;
	getReturnType(): Type;
}

function functionSignature(fn: SignatureBearer, tsm: TsMorph): string {
	const typeParams = fn
		.getTypeParameters()
		.map((t) => t.getText())
		.join(", ");
	const params = fn
		.getParameters()
		.map((p) => parameterSignature(p, tsm))
		.join(", ");
	const returnType =
		fn.getReturnTypeNode()?.getText() ??
		inferTypeText(() =>
			fn.getReturnType().getText(undefined, tsm.TypeFormatFlags.NoTruncation),
		);
	return normalize(`<${typeParams}>(${params}) => ${returnType}`);
}

/**
 * Parameter shape as callers see it: rest-ness, type, and optionality.
 * Names are excluded (renames don't affect callers); default-value expressions
 * count as body, only the resulting optionality counts as signature.
 */
function parameterSignature(p: ParameterDeclaration, tsm: TsMorph): string {
	const rest = p.isRestParameter() ? "..." : "";
	const optional = p.hasQuestionToken() || p.hasInitializer() ? "?" : "";
	const type =
		p.getTypeNode()?.getText() ??
		inferTypeText(() =>
			p.getType().getText(undefined, tsm.TypeFormatFlags.NoTruncation),
		);
	return `${rest}${type}${optional}`;
}

function parameterDefaults(fn: {
	getParameters(): ParameterDeclaration[];
}): string {
	return fn
		.getParameters()
		.map((p) => p.getInitializer()?.getText() ?? "")
		.filter((t) => t !== "")
		.join(" ");
}

function classSurface(cls: ClassDeclaration, tsm: TsMorph): SymbolSurface {
	const signatureParts: string[] = [];
	const bodyParts: string[] = [];

	const typeParams = cls
		.getTypeParameters()
		.map((t) => t.getText())
		.join(", ");
	const heritage = cls
		.getHeritageClauses()
		.map((h) => h.getText())
		.join(" ");
	const decorators = cls
		.getDecorators()
		.map((d) => d.getText())
		.join(" ");
	signatureParts.push(`class<${typeParams}> ${heritage} ${decorators}`);

	for (const member of cls.getMembers()) {
		if (tsm.Node.isConstructorDeclaration(member)) {
			const params = member
				.getParameters()
				.map((p) => {
					const modifiers = p
						.getModifiers()
						.map((m) => m.getText())
						.join(" ");
					return `${modifiers} ${parameterSignature(p, tsm)}`.trim();
				})
				.join(", ");
			signatureParts.push(`constructor(${params})`);
			bodyParts.push(member.getBody()?.getText() ?? "");
			bodyParts.push(parameterDefaults(member));
			continue;
		}

		if (isPrivateMember(member, tsm)) {
			// Private members are implementation detail: renaming or retyping them
			// cannot affect consumers, so their entire text counts as body.
			bodyParts.push(member.getText());
			continue;
		}

		if (tsm.Node.isMethodDeclaration(member)) {
			const staticMod = member.isStatic() ? "static " : "";
			const optional = member.hasQuestionToken() ? "?" : "";
			signatureParts.push(
				`${staticMod}${member.getName()}${optional}${functionSignature(member, tsm)}`,
			);
			bodyParts.push(member.getBody()?.getText() ?? "");
			bodyParts.push(parameterDefaults(member));
			continue;
		}

		if (tsm.Node.isPropertyDeclaration(member)) {
			const staticMod = member.isStatic() ? "static " : "";
			const readonlyMod = member.isReadonly() ? "readonly " : "";
			const optional = member.hasQuestionToken() ? "?" : "";
			const type =
				member.getTypeNode()?.getText() ??
				inferTypeText(() =>
					member
						.getType()
						.getBaseTypeOfLiteralType()
						.getText(undefined, tsm.TypeFormatFlags.NoTruncation),
				);
			signatureParts.push(
				`${staticMod}${readonlyMod}${member.getName()}${optional}: ${type}`,
			);
			bodyParts.push(member.getInitializer()?.getText() ?? "");
			continue;
		}

		if (tsm.Node.isGetAccessorDeclaration(member)) {
			const type =
				member.getReturnTypeNode()?.getText() ??
				inferTypeText(() =>
					member
						.getReturnType()
						.getText(undefined, tsm.TypeFormatFlags.NoTruncation),
				);
			signatureParts.push(`get ${member.getName()}: ${type}`);
			bodyParts.push(member.getBody()?.getText() ?? "");
			continue;
		}

		if (tsm.Node.isSetAccessorDeclaration(member)) {
			const param = member.getParameters()[0];
			signatureParts.push(
				`set ${member.getName()}(${param === undefined ? "" : parameterSignature(param, tsm)})`,
			);
			bodyParts.push(member.getBody()?.getText() ?? "");
			continue;
		}

		// Static blocks and anything unrecognized are implementation detail.
		bodyParts.push(member.getText());
	}

	return {
		signature: normalize(signatureParts.join(" | ")),
		body: significantText(bodyParts.filter((b) => b !== "").join(" "), tsm),
		typeSpace: false,
		kind: "class",
	};
}

function isPrivateMember(member: ClassMemberTypes, tsm: TsMorph): boolean {
	const name = tsm.Node.hasName(member) ? member.getName() : "";
	if (name.startsWith("#")) return true;
	return tsm.Node.isScoped(member) && member.getScope() === tsm.Scope.Private;
}

function hasDynamicImport(file: SourceFile, tsm: TsMorph): boolean {
	return file
		.getDescendantsOfKind(tsm.SyntaxKind.CallExpression)
		.some((c) => c.getExpression().getKind() === tsm.SyntaxKind.ImportKeyword);
}

function inferTypeText(get: () => string): string {
	try {
		return get();
	} catch {
		return "<unresolved>";
	}
}

/**
 * Token stream of the source with comments and whitespace dropped, using the
 * real TypeScript scanner — unlike regex stripping, this never corrupts string
 * literals that happen to contain `//` or `/*`.
 *
 * A bare scanner cannot tell where a `${…}` substitution ends or whether `/`
 * starts a regex; the parser answers both by asking the scanner to rescan.
 * Without that, everything after either construct scans as one token that
 * keeps its whitespace, so a comment added below one read as a code change.
 * Both rescans here only ever split or merge tokens, never drop text, so a
 * wrong guess can make a change look bigger but never hide one.
 */
export function significantText(src: string, tsm: TsMorph): string {
	if (src.trim() === "") return "";
	const { SyntaxKind } = tsm.ts;
	const scanner = tsm.ts.createScanner(
		tsm.ts.ScriptTarget.Latest,
		/* skipTrivia */ true,
		tsm.ts.LanguageVariant.Standard,
		src,
	);
	const parts: string[] = [];
	// Open `{` count inside each substitution being scanned, innermost last.
	const substitutionBraces: number[] = [];
	let previous = SyntaxKind.Unknown;
	let kind = scanner.scan();
	while (kind !== SyntaxKind.EndOfFileToken) {
		if (
			kind === SyntaxKind.CloseBraceToken &&
			substitutionBraces.at(-1) === 0
		) {
			substitutionBraces.pop();
			kind = scanner.reScanTemplateToken(/* isTaggedTemplate */ false);
		} else if (
			kind === SyntaxKind.OpenBraceToken ||
			kind === SyntaxKind.CloseBraceToken
		) {
			const depth = substitutionBraces.pop();
			if (depth !== undefined) {
				substitutionBraces.push(
					kind === SyntaxKind.OpenBraceToken ? depth + 1 : depth - 1,
				);
			}
		} else if (
			(kind === SyntaxKind.SlashToken ||
				kind === SyntaxKind.SlashEqualsToken) &&
			!endsOperand(previous, tsm)
		) {
			kind = scanner.reScanSlashToken();
		}
		if (
			kind === SyntaxKind.TemplateHead ||
			kind === SyntaxKind.TemplateMiddle
		) {
			substitutionBraces.push(0);
		}
		parts.push(scanner.getTokenText());
		previous = kind;
		kind = scanner.scan();
	}
	return parts.join(" ");
}

/**
 * Whether a token can end an operand, making a following `/` a division. The
 * same rule JavaScript tokenizers use when no parser is available.
 */
function endsOperand(kind: number, tsm: TsMorph): boolean {
	const { SyntaxKind } = tsm.ts;
	switch (kind) {
		case SyntaxKind.Identifier:
		case SyntaxKind.PrivateIdentifier:
		case SyntaxKind.NumericLiteral:
		case SyntaxKind.BigIntLiteral:
		case SyntaxKind.StringLiteral:
		case SyntaxKind.NoSubstitutionTemplateLiteral:
		case SyntaxKind.TemplateTail:
		case SyntaxKind.RegularExpressionLiteral:
		case SyntaxKind.CloseParenToken:
		case SyntaxKind.CloseBracketToken:
		case SyntaxKind.CloseBraceToken:
		case SyntaxKind.PlusPlusToken:
		case SyntaxKind.MinusMinusToken:
		case SyntaxKind.ThisKeyword:
		case SyntaxKind.SuperKeyword:
		case SyntaxKind.TrueKeyword:
		case SyntaxKind.FalseKeyword:
		case SyntaxKind.NullKeyword:
			return true;
		default:
			return false;
	}
}

function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
