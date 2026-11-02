/**
 * edit-heal.ts — post-edit self-repair shared by EVERY edit tool.
 *
 * Runs BEFORE the syntax guard, on the content an edit is about to write:
 *
 *  1. DUPLICATE / SEAM OVERLAP (1-5 lines)
 *     - a block the edit repeated inside the written region is removed;
 *     - a 1-5 line overlap at the TOP or BOTTOM seam of the edit region
 *       (the model re-typed the anchor lines) is removed.
 *     Only duplication that is NEW (not already present in the original file)
 *     and only statement-like blocks are touched, so legitimate repeated data
 *     (array values, blank lines, bare `}`) is never destroyed.
 *
 *  2. DELIMITER AUTO-HEAL ( {}, (), [] )
 *     Scanning ignores strings, template literals and comments. When the file
 *     was BALANCED before the edit and the edit broke it at the boundary:
 *       - surplus closers near the region are deleted;
 *       - up to 3 missing `}` are re-added at the end of the region.
 *     Anything still unbalanced is reported with its exact line number.
 *
 *  3. SYNTAX + REDECLARATION
 *     JSON.parse / TypeScript parser diagnostics with line:col, plus duplicate
 *     block-scoped declarations (const/let, imports, classes) in the same
 *     scope. Functions/interfaces/type aliases are exempt (overloads and
 *     declaration merging are legal).
 *
 * Every automatic repair and every remaining problem is returned so the edit
 * tool can report it to the model immediately — no build/test round-trip.
 */
import path from 'node:path';
import * as ts from 'typescript';

export interface HealOutcome {
  /** Healed content — byte-identical to the input when nothing was repaired. */
  content: string;
  changed: boolean;
  /** Automatic repairs applied (each one names the line(s) it touched). */
  repairs: string[];
  /** Problems left for the model, each with its exact line number. */
  warnings: string[];
}

const MAX_SEAM = 5;
const MAX_REPAIRS = 3;

/** Lines that carry no meaning on their own — never treated as duplicates. */
const STRUCTURAL = /^(?:[)\]}]+[;,) ]*|\{|\}|else\s*\{?|\};?|<\/?[A-Za-z][\w.:-]*(?:\s[^>]*)?\/?>|\/>)$/;

function isTrivialLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.length < 3) return true;
  return STRUCTURAL.test(trimmed);
}

/** A line worth treating as an accidentally repeated statement. */
function isCodeStatement(line: string): boolean {
  const trimmed = line.trim();
  if (isTrivialLine(trimmed) || trimmed.length < 12) return false;
  if (/\b(const|let|var|function|class|import|export|return|if|else|for|while|switch|case|try|catch|await|async|interface|type|enum|new|throw|def|public|private)\b/.test(trimmed)) {
    return true;
  }
  if (/^[\w$.[\]'"]+\s*(=|\+=|-=|\*=|\/=|\?\?=|\|\|=|&&=|:=)\s*\S/.test(trimmed)) return true;
  return /^[\w$.]+\([^)]*\)\s*;?$/.test(trimmed);
}

function splitLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  return raw.length > 1 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
}

function clip(text: string, max = 70): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** 0-based [start, end] window of lines the edit actually changed. */
function changedWindow(beforeLines: string[], afterLines: string[]): { start: number; end: number } {
  const minLen = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { start: prefix, end: Math.max(prefix, afterLines.length - suffix - 1) };
}

function countBlock(lines: string[], block: string[]): number {
  if (block.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + block.length <= lines.length; i += 1) {
    let same = true;
    for (let j = 0; j < block.length; j += 1) {
      if (lines[i + j] !== block[j]) {
        same = false;
        break;
      }
    }
    if (same) {
      count += 1;
      i += block.length - 1;
    }
  }
  return count;
}

/** Removes duplicated blocks the edit introduced; returns the cleaned lines. */
function healDuplicates(beforeLines: string[], afterLines: string[], repairs: string[]): string[] {
  const lines = [...afterLines];
  if (lines.length === 0) return lines;
  let { start, end } = changedWindow(beforeLines, lines);
  start = Math.max(0, Math.min(start, lines.length - 1));
  end = Math.max(start, Math.min(end, lines.length - 1));

  const remove = (from: number, count: number, block: string[], why: string): boolean => {
    if (count <= 0 || from < 0 || from + count > lines.length) return false;
    // Only duplication the edit INTRODUCED — never a pre-existing repetition.
    if (countBlock(beforeLines, block) >= countBlock(lines, block)) return false;
    lines.splice(from, count);
    const span = count > 1 ? `L${from + 1}–L${from + count}` : `L${from + 1}`;
    repairs.push(`${why}: removed ${count} line(s) at ${span} (\`${clip(block[0])}\`)`);
    return true;
  };

  // 1) Overlap with the block directly ABOVE the edited region.
  for (let k = Math.min(MAX_SEAM, start, lines.length - start); k >= 1; k -= 1) {
    const above = lines.slice(start - k, start);
    const head = lines.slice(start, start + k);
    if (head.length !== k || !above.every((line, i) => line === head[i])) continue;
    if (k === 1 && !isCodeStatement(head[0])) continue;
    if (remove(start, k, head, 'seam overlap above the edit region')) {
      end = Math.max(start, end - k);
      break;
    }
  }

  // 2) Overlap with the block directly BELOW the edited region.
  for (let k = Math.min(MAX_SEAM, end + 1, lines.length - end - 1); k >= 1; k -= 1) {
    const tail = lines.slice(end - k + 1, end + 1);
    const below = lines.slice(end + 1, end + 1 + k);
    if (tail.length !== k || !below.every((line, i) => line === tail[i])) continue;
    if (k === 1 && !isCodeStatement(tail[0])) continue;
    if (remove(end - k + 1, k, tail, 'seam overlap below the edit region')) {
      end = Math.max(start, end - k);
      break;
    }
  }

  // 3) Blocks repeated back-to-back INSIDE the written region.
  for (let i = start; i <= end && i < lines.length; i += 1) {
    for (let k = 1; k <= MAX_SEAM; k += 1) {
      if (i + 2 * k > lines.length) break;
      const first = lines.slice(i, i + k);
      const second = lines.slice(i + k, i + 2 * k);
      if (!first.every((line, j) => line === second[j])) continue;
      if (k === 1 && !isCodeStatement(first[0])) continue;
      if (remove(i + k, k, second, 'duplicate block inside the edit region')) {
        end = Math.max(start, end - k);
        i -= 1;
        break;
      }
    }
  }

  return lines;
}

interface DelimScan {
  extra: Array<{ ch: string; line: number }>;
  unclosed: Array<{ ch: string; line: number }>;
}

const CLOSER_OF: Record<string, string> = { '}': '{', ')': '(', ']': '[' };

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'typeof', 'void', 'delete',
  'in', 'of', 'instanceof', 'new', 'yield', 'await', 'else', 'do',
]);

const COND_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'catch']);

/**
 * Consume `/pattern/flags` on a single line when valid; returns the index
 * immediately past the trailing flags, or -1 when `/` is not a RegExp literal.
 */
function consumeRegexLiteral(text: string, slashIndex: number): number {
  let j = slashIndex + 1;
  if (j >= text.length || text[j] === '\n' || text[j] === '\r' || text[j] === '/' || text[j] === '*') {
    return -1;
  }
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      if (j + 1 >= text.length || text[j + 1] === '\n' || text[j + 1] === '\r') return -1;
      j += 2;
      continue;
    }
    if (c === '[') {
      inClass = true;
      j += 1;
      continue;
    }
    if (c === ']' && inClass) {
      inClass = false;
      j += 1;
      continue;
    }
    if (c === '/' && !inClass) {
      j += 1;
      while (j < text.length && /[dgimsuvy]/.test(text[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

/**
 * Delimiter scanner — ignores strings, RegExp literals (including `[...]`
 * character classes and escapes), template literals (including nested `${…}`
 * interpolations) and both comment forms.
 */
function scanDelimiters(text: string): DelimScan {
  const stack: Array<{ ch: string; line: number; afterCond?: boolean }> = [];
  const extra: Array<{ ch: string; line: number }> = [];
  const templateStackLengths: number[] = [];
  let line = 1;
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let canStartRegex = true;
  let lastWord = '';

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '\n') {
      line += 1;
      if (mode === 'line') mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'line') {
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      if (ch === '\\') {
        if (next === '\n') line += 1;
        else if (next === '\r' && text[i + 2] === '\n') {
          line += 1;
          i += 3;
          continue;
        }
        i += 2;
        continue;
      }
      if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"')) {
        mode = 'code';
        canStartRegex = false;
        lastWord = '';
      }
      i += 1;
      continue;
    }
    if (mode === 'template') {
      if (ch === '\\') {
        if (next === '\n') line += 1;
        else if (next === '\r' && text[i + 2] === '\n') {
          line += 1;
          i += 3;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === '`') {
        mode = 'code';
        canStartRegex = false;
        lastWord = '';
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        templateStackLengths.push(stack.length);
        stack.push({ ch: '${', line });
        mode = 'code';
        canStartRegex = true;
        lastWord = '';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      mode = 'line';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = 'block';
      i += 2;
      continue;
    }
    if (ch === '/' && canStartRegex) {
      const regexEnd = consumeRegexLiteral(text, i);
      if (regexEnd !== -1) {
        canStartRegex = false;
        lastWord = '';
        i = regexEnd;
        continue;
      }
    }
    if (ch === "'") {
      mode = 'single';
      i += 1;
      continue;
    }
    if (ch === '"') {
      mode = 'double';
      i += 1;
      continue;
    }
    if (ch === '`') {
      mode = 'template';
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      const afterCond = ch === '(' && COND_PAREN_KEYWORDS.has(lastWord);
      stack.push({ ch, line, afterCond });
      canStartRegex = true;
      lastWord = '';
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      const top = stack[stack.length - 1];
      const tplBase = templateStackLengths[templateStackLengths.length - 1];
      if (ch === '}' && tplBase !== undefined && stack[tplBase]?.ch === '${' && stack.length - 1 === tplBase) {
        templateStackLengths.pop();
        stack.pop();
        mode = 'template';
        canStartRegex = false;
      } else if (top && top.ch === CLOSER_OF[ch]) {
        const popped = stack.pop();
        canStartRegex = ch === '}' || Boolean(popped?.afterCond);
      } else {
        extra.push({ ch, line });
        canStartRegex = false;
      }
      lastWord = '';
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
      const word = text.slice(i, end);
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(word);
      lastWord = word;
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < text.length && /[A-Za-z0-9_.]/.test(text[end])) end += 1;
      canStartRegex = false;
      lastWord = '';
      i = end;
      continue;
    }
    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      canStartRegex = false;
      lastWord = '';
      i += 2;
      continue;
    }
    if (ch === '!' && next !== '=') {
      lastWord = '';
      i += 1;
      continue;
    }
    canStartRegex = ',;:?=+-*%&|^~<>'.includes(ch);
    lastWord = '';
    i += 1;
  }

  // Interpolation sentinels are not real delimiters — never report them.
  const unclosed = stack
    .filter((entry) => entry.ch !== '${')
    .map((entry) => ({ ch: entry.ch, line: entry.line }));
  return { extra, unclosed };
}

/**
 * Restores delimiter balance when an edit broke an otherwise balanced file.
 *
 * REMOVAL ONLY. Deleting a genuinely duplicated closer is recoverable — a
 * syntax error is reported and the model fixes it. INVENTING a closer is not:
 * the scanner cannot see inside every literal, and appending a brace to a file
 * that was already correct silently changes the program. So a missing closer
 * is reported with its line number and left for the model to place.
 *
 * A surplus closer is only removed when it stands ALONE on its line — a brace
 * sharing a line with code may be a character inside a string or template
 * literal, and deleting that would corrupt real content.
 */
function healDelimiters(
  beforeText: string,
  lines: string[],
  window: { start: number; end: number },
  repairs: string[],
  warnings: string[],
): string[] {
  const before = scanDelimiters(beforeText);
  if (before.extra.length > 0 || before.unclosed.length > 0) {
    // The file was already unbalanced — do not guess, only report the edit's own.
    const after = scanDelimiters(lines.join('\n'));
    reportRemaining(after, window, warnings);
    return lines;
  }

  let scan = scanDelimiters(lines.join('\n'));
  if (scan.extra.length === 0 && scan.unclosed.length === 0) return lines;

  const low = window.start - MAX_SEAM;
  const high = window.end + MAX_SEAM;

  let fixed = 0;
  while (fixed < MAX_REPAIRS) {
    const target = scan.extra.find((entry) => {
      if (entry.line - 1 < low || entry.line - 1 > high) return false;
      const trimmed = (lines[entry.line - 1] ?? '').trim();
      return trimmed === entry.ch;
    });
    if (!target) break;
    lines[target.line - 1] = '';
    repairs.push('removed a surplus `' + target.ch + '` standing alone at L' + target.line);
    fixed += 1;
    scan = scanDelimiters(lines.join('\n'));
  }

  reportRemaining(scan, window, warnings);
  return lines;
}

/** Reports only what still matters — unclosed/mismatched delimiters by line. */
function reportRemaining(scan: DelimScan, window: { start: number; end: number }, warnings: string[]): void {
  for (const entry of scan.unclosed.slice(0, MAX_REPAIRS)) {
    const inEdit = entry.line - 1 >= window.start - MAX_SEAM && entry.line - 1 <= window.end + MAX_SEAM;
    warnings.push(
      `unclosed \`${entry.ch}\` opened at L${entry.line}${inEdit ? ' (inside the written block)' : ''}`,
    );
  }
  for (const entry of scan.extra.slice(0, MAX_REPAIRS)) {
    warnings.push(`unmatched \`${entry.ch}\` at L${entry.line}`);
  }
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Fast in-memory syntax + duplicate-declaration analysis with line numbers. */
function analyzeCode(absolute: string, content: string): { syntax: string[]; redecl: string[] } {
  const ext = path.extname(absolute).toLowerCase();
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (ext === '.json') {
    try {
      JSON.parse(content);
      return { syntax: [], redecl: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'parse error';
      const position = /position (\d+)/i.exec(message);
      if (position) {
        const offset = Math.min(Number(position[1]), normalized.length);
        const lineNo = normalized.slice(0, offset).split('\n').length;
        const snippet = clip(lines[lineNo - 1] ?? '');
        return { syntax: [`invalid JSON at L${lineNo}: ${message} (\`${snippet}\`)`], redecl: [] };
      }
      return { syntax: [`invalid JSON: ${message}`], redecl: [] };
    }
  }

  if (!CODE_EXTENSIONS.has(ext)) return { syntax: [], redecl: [] };

  const kind = ext === '.tsx'
    ? ts.ScriptKind.TSX
    : ext === '.jsx'
      ? ts.ScriptKind.JSX
      : ext === '.ts' || ext === '.mts' || ext === '.cts'
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(path.basename(absolute), content, ts.ScriptTarget.ES2022, true, kind);
  } catch {
    return { syntax: [], redecl: [] };
  }

  const diagnostics =
    (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  const syntax = diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .slice(0, MAX_REPAIRS)
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      if (diagnostic.start === undefined) return message;
      const lc = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      const snippet = clip(lines[lc.line] ?? '');
      return `L${lc.line + 1}:${lc.character + 1} ${message} (at: \`${snippet}\`)`;
    });

  return { syntax, redecl: findRedeclarations(sourceFile) };
}

/**
 * Duplicate declarations in the SAME scope. Block-scoped bindings only
 * (const/let, imports, classes) — `var`, functions, interfaces and type
 * aliases are exempt because redeclaration/merging is legal there.
 */
function findRedeclarations(sourceFile: ts.SourceFile): string[] {
  const scopes: ts.Node[] = [sourceFile];
  const collect = (node: ts.Node): void => {
    ts.forEachChild(node, (child) => {
      if (ts.isBlock(child) || ts.isModuleBlock(child) || ts.isCaseBlock(child)) scopes.push(child);
      collect(child);
    });
  };
  collect(sourceFile);

  const problems: string[] = [];
  for (const scope of scopes) {
    const names = new Map<string, number[]>();
    const add = (name: string, position: number): void => {
      const list = names.get(name) ?? [];
      list.push(position);
      names.set(name, list);
    };

    ts.forEachChild(scope, (child) => {
      if (ts.isVariableStatement(child)) {
        const blockScoped = (child.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
        if (!blockScoped) return;
        for (const declaration of child.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration.name.getStart(sourceFile));
        }
        return;
      }
      if (ts.isImportDeclaration(child) && child.importClause) {
        const clause = child.importClause;
        if (clause.name) add(clause.name.text, clause.name.getStart(sourceFile));
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) add(element.name.text, element.name.getStart(sourceFile));
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          add(bindings.name.text, bindings.name.getStart(sourceFile));
        }
        return;
      }
      if (ts.isClassDeclaration(child) && child.name) add(child.name.text, child.name.getStart(sourceFile));
    });

    for (const [name, positions] of names) {
      if (positions.length < 2) continue;
      const lineNumbers = positions.map((position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1);
      problems.push(`\`${name}\` declared ${positions.length}× in the same scope (L${lineNumbers.join(', L')})`);
      if (problems.length >= MAX_REPAIRS) return problems;
    }
  }
  return problems;
}

/**
 * Heals an edit about to be written. `before` is the file content prior to the
 * edit ('' for a brand-new file). Returns the content to write plus the notes
 * the edit tool must show the model.
 */
export function healEditedContent(before: string, after: string, absolute: string): HealOutcome {
  const repairs: string[] = [];
  const warnings: string[] = [];
  const eol = after.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /(?:\r\n|\n)$/.test(after);

  // BRAND-NEW FILE (before === ''): the duplicate/seam heuristics are defined
  // by before-vs-after. With no previous state there is no seam and no
  // introduced duplication — countBlock([], block) is always 0, so the guard
  // would pass and every legitimate repetition in the new content would be
  // deleted as if the edit had repeated it. Detection only, never mutation.
  if (before.length === 0) {
    const analysis = analyzeCode(absolute, after);
    warnings.push(...analysis.syntax, ...analysis.redecl);
    return { content: after, changed: false, repairs, warnings };
  }

  const beforeLines = splitLines(before);
  let lines = splitLines(after);
  if (lines.length === 0) {
    return { content: after, changed: false, repairs, warnings };
  }

  lines = healDuplicates(beforeLines, lines, repairs);
  const ext = path.extname(absolute).toLowerCase();
  const afterDupContent =
    repairs.length > 0 ? lines.join(eol) + (hadTrailingNewline ? eol : '') : after;

  // For TS/JS/JSX/TSX code files: if the TypeScript AST parser already parses
  // the candidate with 0 syntax errors, the delimiters are provably balanced —
  // NEVER mutate lines with `healDelimiters` and NEVER emit false-positive
  // `unclosed` / `unmatched` delimiter warnings.
  if (CODE_EXTENSIONS.has(ext)) {
    const preAnalysis = analyzeCode(absolute, afterDupContent);
    if (preAnalysis.syntax.length === 0) {
      warnings.push(...preAnalysis.redecl);
      return {
        content: afterDupContent,
        changed: repairs.length > 0,
        repairs,
        warnings,
      };
    }
  }

  const delimWarnings: string[] = [];
  const window = changedWindow(beforeLines, lines);
  lines = healDelimiters(before, lines, window, repairs, delimWarnings);

  const content = lines.join(eol) + (hadTrailingNewline ? eol : '');
  const changed = repairs.length > 0;
  const finalContent = changed ? content : after;

  const analysis = analyzeCode(absolute, finalContent);
  if (!CODE_EXTENSIONS.has(ext) || analysis.syntax.length > 0) {
    warnings.push(...delimWarnings);
  }
  warnings.push(...analysis.syntax, ...analysis.redecl);

  return { content: finalContent, changed, repairs, warnings };
}

/** Renders the heal report appended to an edit tool's result text. */
export function formatHealNotes(outcome: HealOutcome): string {
  if (outcome.repairs.length === 0 && outcome.warnings.length === 0) return '';
  const blocks: string[] = [];
  if (outcome.repairs.length > 0) {
    blocks.push(
      `⟲ auto-heal (${outcome.repairs.length}) — the file was saved CLEAN:\n` +
        outcome.repairs.map((repair) => `  • ${repair}`).join('\n'),
    );
  }
  if (outcome.warnings.length > 0) {
    blocks.push(`⚠ detector:\n${outcome.warnings.map((warning) => `  • ${warning}`).join('\n')}`);
  }
  return `\n${blocks.join('\n')}`;
}
