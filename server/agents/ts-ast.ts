/**
 * F2/F3 — Shared TypeScript AST helpers: find a symbol's NavigationTree node,
 * enclosing-symbol breadcrumbs, function metrics, exported names.
 */
import * as ts from 'typescript';

export interface SymbolSpan {
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  /** Breadcrumb, e.g. `Class › method`. */
  breadcrumb: string;
  name: string;
  kind: string;
  /** Text span offsets for LSP queries. */
  startOffset: number;
  endOffset: number;
}

function normalizePath(p: string): string {
  return p.split('\\').join('/');
}

interface FlatNode {
  name: string;
  kind: string;
  start: number;
  end: number;
  parent: string[];
}

/** Flatten a NavigationTree into nodes with breadcrumb parents. */
export function flattenNavigationTree(tree: ts.NavigationTree): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (node: ts.NavigationTree, parents: string[]): void => {
    const span = node.spans[0];
    const entry: FlatNode = {
      name: node.text,
      kind: String(node.kind),
      start: span ? span.start : -1,
      end: span ? span.start + span.length : -1,
      parent: parents,
    };
    out.push(entry);
    for (const child of node.childItems ?? []) {
      walk(child, [...parents, node.text]);
    }
  };
  walk(tree, []);
  return out;
}

/** Convert a 0-based offset to a 1-based line number. */
export function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/** Find symbol spans matching `name` (supports `Class.method` and overloads). */
export function findSymbolSpans(content: string, fileName: string, symbol: string): SymbolSpan[] | null {
  const sourceFile = safeCreateSourceFile(content, fileName);
  if (!sourceFile) return null;
  const matches: SymbolSpan[] = [];
  const wanted = symbol.includes('.') ? symbol.split('.').map((s) => s.trim()) : [symbol.trim()];
  const wantedLeaf = wanted[wanted.length - 1];

  const visit = (node: ts.Node, parents: string[]): void => {
    let name = '';
    let kind = '';
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      name = node.name ? node.name.getText() : '';
      kind = 'function';
    } else if (ts.isClassDeclaration(node)) {
      name = node.name ? node.name.getText() : '';
      kind = 'class';
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      name = node.name.getText();
      kind = 'type';
    } else if (ts.isVariableStatement(node)) {
      const decl = node.declarationList.declarations[0];
      if (decl && ts.isIdentifier(decl.name)) {
        name = decl.name.getText();
        kind = 'const';
      }
    } else if (ts.isPropertyDeclaration(node)) {
      name = node.name.getText();
      kind = 'property';
    }
    const parentsNext = name && kind !== 'property' ? [...parents, name] : parents;
    if (name === wantedLeaf && parentsContain(parents, wanted)) {
      matches.push({
        startLine: offsetToLine(content, node.getStart(sourceFile)),
        endLine: offsetToLine(content, node.getEnd()),
        breadcrumb: [...parents, name].join(' › '),
        name,
        kind,
        startOffset: node.getStart(sourceFile),
        endOffset: node.getEnd(),
      });
    }
    node.forEachChild((child) => visit(child, parentsNext));
  };
  visit(sourceFile, []);
  return matches;
}

function parentsContain(parents: string[], wanted: string[]): boolean {
  if (wanted.length <= 1) return true;
  const chain = wanted.slice(0, -1);
  let idx = 0;
  for (const p of parents) {
    if (idx < chain.length && p === chain[idx]) idx += 1;
  }
  return idx === chain.length;
}

function safeCreateSourceFile(content: string, fileName: string): ts.SourceFile | null {
  try {
    const kind = /\.tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(normalizePath(fileName), content, ts.ScriptTarget.Latest, true, kind);
  } catch {
    return null;
  }
}

/** Names exported by a source file (for dead-code analysis). */
export function exportedNames(content: string, fileName: string): Array<{ name: string; line: number; kind: string }> {
  const sourceFile = safeCreateSourceFile(content, fileName);
  if (!sourceFile) return [];
  const out: Array<{ name: string; line: number; kind: string }> = [];
  sourceFile.forEachChild((node) => {
    const line = offsetToLine(content, node.getStart(sourceFile));
    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          out.push({ name: (el.propertyName ?? el.name).getText(), line: offsetToLine(content, el.getStart(sourceFile)), kind: 'export' });
        }
      }
      return;
    }
    const hasExport = ((node as { modifiers?: readonly { kind: number }[] }).modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) return;
    if (ts.isFunctionDeclaration(node) && node.name) out.push({ name: node.name.getText(), line, kind: 'function' });
    else if (ts.isClassDeclaration(node) && node.name) out.push({ name: node.name.getText(), line, kind: 'class' });
    else if (ts.isInterfaceDeclaration(node)) out.push({ name: node.name.getText(), line, kind: 'interface' });
    else if (ts.isTypeAliasDeclaration(node)) out.push({ name: node.name.getText(), line, kind: 'type' });
    else if (ts.isEnumDeclaration(node)) out.push({ name: node.name.getText(), line, kind: 'enum' });
    else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.push({ name: decl.name.getText(), line, kind: 'const' });
        else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) out.push({ name: el.name.getText(), line, kind: 'const' });
          }
        }
      }
    }
  });
  return out;
}

export interface FunctionMetrics {
  name: string;
  line: number;
  lengthLines: number;
  cyclomatic: number;
  nesting: number;
  params: number;
}

/** Per-function complexity metrics (F3.6). */
export function functionMetrics(content: string, fileName: string): FunctionMetrics[] {
  const sourceFile = safeCreateSourceFile(content, fileName);
  if (!sourceFile) return [];
  const out: FunctionMetrics[] = [];

  const visit = (node: ts.Node, depth: number): void => {
    const isFn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
      || (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name));
    if (isFn) {
      const name = ts.isArrowFunction(node)
        ? (node.parent as ts.VariableDeclaration).name.getText()
        : node.name ? node.name.getText() : '(anonymous)';
      let cyclomatic = 1;
      let nesting = 0;
      const measure = (n: ts.Node, level: number): void => {
        if (
          ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)
          || ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isCaseClause(n) || ts.isCatchClause(n)
        ) {
          cyclomatic += 1;
        }
        if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
          cyclomatic += 1;
        }
        if (n.kind === ts.SyntaxKind.QuestionToken) {
        }
        if (ts.isConditionalExpression(n)) cyclomatic += 1;
        if (level > nesting) nesting = level;
        if (ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) {
          n.forEachChild((c) => measure(c, level + 1));
          return;
        }
        n.forEachChild((c) => measure(c, level));
      };
      measure(node, 0);
      const params = 'parameters' in node ? (node as ts.FunctionLikeDeclaration).parameters.length : 0;
      out.push({
        name,
        line: offsetToLine(content, node.getStart(sourceFile)),
        lengthLines: offsetToLine(content, node.getEnd()) - offsetToLine(content, node.getStart(sourceFile)) + 1,
        cyclomatic,
        nesting,
        params,
      });
    }
    node.forEachChild((c) => visit(c, depth + 1));
  };
  visit(sourceFile, 0);
  return out;
}

/** Enclosing symbol breadcrumb for a line (F2.3 grep annotation). */
export function enclosingSymbol(content: string, fileName: string, line: number): string | null {
  const sourceFile = safeCreateSourceFile(content, fileName);
  if (!sourceFile) return null;
  let best: { breadcrumb: string; length: number } | null = null;
  const visit = (node: ts.Node, parents: string[]): void => {
    let name = '';
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) name = node.name ? node.name.getText() : '';
    else if (ts.isClassDeclaration(node)) name = node.name ? node.name.getText() : '';
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) name = node.name.getText();
    if (name) {
      const startLine = offsetToLine(content, node.getStart(sourceFile));
      const endLine = offsetToLine(content, node.getEnd());
      if (line >= startLine && line <= endLine) {
        const length = endLine - startLine;
        if (!best || length < (best as { length: number }).length) {
          best = { breadcrumb: [...parents, name].join(' › '), length };
        }
        node.forEachChild((c) => visit(c, [...parents, name]));
        return;
      }
    }
    node.forEachChild((c) => visit(c, name ? [...parents, name] : parents));
  };
  visit(sourceFile, []);
  if (best !== null) return (best as { breadcrumb: string }).breadcrumb;
  return null;
}
