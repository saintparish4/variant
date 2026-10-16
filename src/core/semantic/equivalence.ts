/**
 * @module
 * Whether two versions of a file are the same program, written differently.
 *
 * The differ compares significant tokens, which cannot see that a formatter
 * dropping redundant parentheses changed nothing: at the token level
 * `(a + b) * c` and `a + b * c` differ by the same parentheses. The syntax
 * tree already holds precedence, so the comparison here unwraps parentheses
 * in the tree and compares what is left. Found on pyra, where Biome removed
 * the parentheses around an arrow function's body.
 */

import type { Node, Project } from "ts-morph";

export type ProgramComparer = (
	filePath: string,
	before: string,
	after: string,
) => Promise<boolean>;

type TsMorph = typeof import("ts-morph");

/**
 * The tree as a string: each node's kind, with token text at the leaves.
 * Parentheses are unwrapped, except where they change meaning (`("use
 * strict")` is no directive), trailing commas before a closing bracket are
 * dropped, and the optional-chain flag is kept: `(a?.b).c` throws where
 * `a?.b.c` does not.
 */
function shape(node: Node, tsm: TsMorph, out: string[]): void {
	const { SyntaxKind, ts } = tsm;
	// ts-morph lists comments among a block's statements.
	if (
		node.getKind() === SyntaxKind.SingleLineCommentTrivia ||
		node.getKind() === SyntaxKind.MultiLineCommentTrivia ||
		tsm.Node.isJSDoc(node)
	) {
		return;
	}
	if (
		tsm.Node.isParenthesizedExpression(node) &&
		!(
			tsm.Node.isExpressionStatement(node.getParent()) &&
			tsm.Node.isStringLiteral(node.getExpression())
		)
	) {
		shape(node.getExpression(), tsm, out);
		return;
	}
	const children = node.getChildren();
	if (children.length === 0) {
		if (node.getKind() !== SyntaxKind.EndOfFileToken) out.push(node.getText());
		return;
	}
	const chain = (node.compilerNode.flags & ts.NodeFlags.OptionalChain) !== 0;
	out.push(`(${node.getKindName()}${chain ? "?" : ""}`);
	children.forEach((child, index) => {
		const isLastComma =
			child.getKind() === SyntaxKind.CommaToken &&
			index === children.length - 1 &&
			node.getKind() === SyntaxKind.SyntaxList;
		if (!isLastComma) shape(child, tsm, out);
	});
	out.push(")");
}

/** One ts-morph Project for every file compared: constructing it is the cost. */
export function createProgramComparer(): ProgramComparer {
	let project: Project | undefined;
	let id = 0;
	return async (filePath, before, after) => {
		const tsm = await import("ts-morph");
		project ??= new tsm.Project({ useInMemoryFileSystem: true });
		const extension = /\.[cm]?tsx?$/.exec(filePath)?.[0] ?? ".ts";
		const n = id++;
		const a = project.createSourceFile(`/__a_${n}${extension}`, before);
		const b = project.createSourceFile(`/__b_${n}${extension}`, after);
		try {
			const left: string[] = [];
			const right: string[] = [];
			shape(a, tsm, left);
			shape(b, tsm, right);
			return left.join(" ") === right.join(" ");
		} finally {
			project.removeSourceFile(a);
			project.removeSourceFile(b);
		}
	};
}
