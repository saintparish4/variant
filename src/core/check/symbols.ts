/**
 * @module
 * The named function, method or class each changed line is in, for the
 * report. The semantic differ records exported names without positions, so
 * this reads them from the syntax tree directly.
 */

import type { Node } from "ts-morph";

export type SymbolLookup = (line: number) => string | undefined;

interface Span {
	name: string;
	start: number;
	end: number;
}

/**
 * One ts-morph Project for every file of a run: constructing it is the
 * expensive part. Each file is removed after it is read.
 */
export function createSymbolReader(): (
	file: string,
	content: string,
) => Promise<SymbolLookup> {
	let project: import("ts-morph").Project | undefined;
	return async (file, content) => {
		const tsm = await import("ts-morph");
		project ??= new tsm.Project({ useInMemoryFileSystem: true });
		const source = project.createSourceFile(`/${file}`, content, {
			overwrite: true,
		});
		const spans: Span[] = [];
		const add = (name: string | undefined, node: Node): void => {
			if (name === undefined || name === "") return;
			spans.push({
				name,
				start: node.getStartLineNumber(),
				end: node.getEndLineNumber(),
			});
		};
		source.forEachDescendant((node) => {
			if (
				tsm.Node.isFunctionDeclaration(node) ||
				tsm.Node.isClassDeclaration(node)
			) {
				add(node.getName(), node);
			} else if (
				tsm.Node.isMethodDeclaration(node) ||
				tsm.Node.isGetAccessorDeclaration(node) ||
				tsm.Node.isSetAccessorDeclaration(node)
			) {
				const owner = node.getParent();
				const ownerName = tsm.Node.isClassDeclaration(owner)
					? owner.getName()
					: undefined;
				add(
					ownerName === undefined
						? node.getName()
						: `${ownerName}.${node.getName()}`,
					node,
				);
			} else if (tsm.Node.isConstructorDeclaration(node)) {
				const owner = node.getParent();
				add(
					tsm.Node.isClassDeclaration(owner)
						? `${owner.getName() ?? "class"}.constructor`
						: undefined,
					node,
				);
			} else if (tsm.Node.isVariableDeclaration(node)) {
				const initializer = node.getInitializer();
				if (
					tsm.Node.isArrowFunction(initializer) ||
					tsm.Node.isFunctionExpression(initializer)
				) {
					add(node.getName(), node);
				}
			}
		});
		project.removeSourceFile(source);
		return (line) => {
			let best: Span | undefined;
			for (const span of spans) {
				if (line < span.start || line > span.end) continue;
				if (
					best === undefined ||
					span.end - span.start < best.end - best.start
				) {
					best = span;
				}
			}
			return best?.name;
		};
	};
}
