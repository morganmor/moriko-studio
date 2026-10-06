/**
 * FOLD SCANNER — reads a whole file and folds it into a block tree
 * (VSCode-style "fold all"), so a reader sees every block's SIGNATURE plus a
 * `⋯ N lines` body marker instead of the body itself.
 *
 * Scanners picked by file extension:
 *  - brace languages (JS/TS/Java/C/Go/Rust/JSON/CSS/PHP/C#/Kotlin/…): a
 *    single-pass state machine counting `{`/`}` depth, aware of line/block
 *    comments, `#` comments (Perl/PHP/Ruby family), string literals (incl.
 *    C# verbatim @"…" and Kotlin `"""`), template literals, regex literals
 *    and JSX-text apostrophes ("Don't" is prose, not a string opener).
 *    Braces inside strings or comments never skew the depth — the classic
 *    naive-scanner bug.
 *  - indent languages: Python(.py/.pyi) — and YAML reuses the same colon +
 *    indentation heuristic. The scan is string/comment-aware: triple-quoted
 *    docstrings are inert, and an opener only counts at bracket depth 0 (so
 *    dict labels and slices cannot open phantom blocks).
 *  - anything else: NO map (`scanned: 'none'`) — honest failure beats a
 *    wrong guess.
 *
 * Deliberately NOT tree-sitter: zero dependencies. The safety net for exotic
 * syntax is honest failure (`balanced: false`) — the caller then shows NO map
 * instead of a wrong one.
 */

export interface FoldBlock {
  /** Opening line(s), whitespace-collapsed — the signature. */
  signature: string;
  /** 1-based line where the signature starts (may precede the brace line). */
  from: number;
  /** 1-based closing line (inclusive). */
  to: number;
  /** Nesting depth: 0 = top level. */
  depth: number;
  children: FoldBlock[];
}

export interface FoldResult {
  /** Top-level blocks (depth 0). */
  blocks: FoldBlock[];
  /**
   * false = the scan cannot be trusted (unbalanced braces, unterminated
   * string/comment, broken file, exotic syntax, or no scanner for the type).
   * The map must NOT be shown — it would be wrong.
   */
  balanced: boolean;
  /** Which scanner produced the result ('none' = unsupported file type). */
  scanned: 'brace' | 'indent' | 'none';
}

/** How many lines above the `{` a multi-line signature may span. */
const SIGNATURE_LOOKBACK = 6;
/** Render-time cap on shown blocks (the SCAN always builds the full tree). */
export const FOLD_BLOCK_CAP = 600;
const SIGNATURE_MAX_CHARS = 160;

const INDENT_EXTENSIONS = new Set(['.py', '.pyi']);
/** Indent-heuristic reusers: `key:` + deeper indent matches the scanner. */
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
/** Languages the brace scanner is allowed to touch. Anything else: no map. */
const BRACE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.json', '.jsonc',
  '.css', '.scss', '.less',
  '.java', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs',
  '.go', '.rs', '.kt', '.kts',
  '.php', '.phtml',
  '.sql', '.graphql', '.gql',
  '.vue', '.svelte',
  '.prisma', '.proto',
]);
/** Brace-family languages where `#` opens a line comment. */
const HASH_COMMENT_EXTENSIONS = new Set(['.php', '.phtml', '.pl', '.pm', '.rb']);

function capSignature(text: string): string {
  return text.length > SIGNATURE_MAX_CHARS ? `${text.slice(0, SIGNATURE_MAX_CHARS)}…` : text;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Fold a whole file into a block tree. Never throws — worst case is
 * `balanced: false`, which callers must treat as "no map".
 */
export function foldContent(content: string, filename: string): FoldResult {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
  const lines = content.split('\n');
  if (INDENT_EXTENSIONS.has(ext) || YAML_EXTENSIONS.has(ext)) return scanIndent(lines);
  if (BRACE_EXTENSIONS.has(ext)) {
    return scanBrace(lines, { hashComment: HASH_COMMENT_EXTENSIONS.has(ext) });
  }
  return { blocks: [], balanced: false, scanned: 'none' };
}


/**
 * Scan one char at a time with an explicit context stack. `code` frames carry
 * the brace depth they opened at; `template` frames are backtick literals and
 * `string` frames are double-quoted strings (Ruby `#{…}` interpolation pushes
 * a fresh code frame inside them). `${…}` in templates pushes one too, so
 * interpolation still balances while the surrounding text stays literal.
 */
function scanBrace(lines: string[], opts: { hashComment: boolean } = { hashComment: false }): FoldResult {
  type Frame = { kind: 'code'; base: number } | { kind: 'template' } | { kind: 'string'; quote: '"' };
  const frames: Frame[] = [{ kind: 'code', base: 0 }];
  let depth = 0;

  const spans: Array<{ sigStart: number; from: number; node: FoldBlock }> = [];
  const roots: FoldBlock[] = [];

  const REGEX_OK_PREV = new Set(['(', '[', '{', '}', ';', ',', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>']);
  const REGEX_OK_WORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void',
    'new', 'do', 'else', 'yield', 'await', 'throw',
    'if', 'for', 'while', 'switch', 'with', 'catch',
  ]);
  /** Control keywords — a `/` right after their `(…)` may open a regex. */
  const REGEX_OK_AFTER_PAREN = new Set(['if', 'for', 'while', 'switch', 'with', 'catch']);
  /** The last completed word before each `(`, restored when the `)` closes. */
  const parenOwners: string[] = [];
  let prevChar = '';
  let lastWord = '';
  let word = '';
  let sawStrayClose = false;
  let sawUnterminatedLiteral = false;

  const closeBlock = (closeIdx: number): void => {
    const span = spans.pop() as { sigStart: number; from: number; node: FoldBlock };
    if (span.from - 1 === closeIdx) return;
    span.node.signature = joinSignature(lines, span.sigStart, span.from - 1);
    span.node.to = closeIdx + 1;
    if (spans.length > 0) spans[spans.length - 1].node.children.push(span.node);
    else roots.push(span.node);
  };

  outer: for (let li = 0; li < lines.length; li += 1) {
    let line = lines[li];
    if (li === 0 && line.startsWith('#!')) continue;

    charloop: for (let ci = 0; ci < line.length; ci += 1) {
      const ch = line[ci];
      const frame = frames[frames.length - 1];

      if (frame.kind === 'template') {
        if (ch === '\\') { ci += 1; continue; }
        if (ch === '`') { frames.pop(); prevChar = '`'; continue; }
        if (ch === '$' && line[ci + 1] === '{') {
          ci += 1;
          frames.push({ kind: 'code', base: depth });
          prevChar = '';
          continue;
        }
        continue;
      }

      if (frame.kind === 'string') {
        if (ch === '\\') { ci += 1; continue; }
        if (ch === '"') { frames.pop(); prevChar = '"'; lastWord = ''; word = ''; continue; }
        if (opts.hashComment && ch === '#' && line[ci + 1] === '{') {
          ci += 1;
          frames.push({ kind: 'code', base: depth });
          prevChar = '';
          continue;
        }
        continue;
      }

      if (opts.hashComment && ch === '#') {
        const prevRaw = ci > 0 ? line[ci - 1] : '';
        if (prevRaw !== '$' && prevRaw !== '@') break;
      }

      if (ch === '/' && line[ci + 1] === '/') break;

      if (ch === '/' && line[ci + 1] === '*') {
        let idx = line.indexOf('*/', ci + 2);
        if (idx >= 0) { ci = idx + 1; continue; }
        li += 1;
        while (li < lines.length) {
          idx = lines[li].indexOf('*/');
          if (idx >= 0) {
            line = lines[li];
            ci = idx + 1;
            continue charloop;
          }
          li += 1;
        }
        sawUnterminatedLiteral = true;
        prevChar = '/';
        break outer;
      }

      if (ch === '"' && line[ci + 1] === '"' && line[ci + 2] === '"') {
        let idx = line.indexOf('"""', ci + 3);
        if (idx >= 0) { ci = idx + 2; prevChar = '"'; lastWord = ''; word = ''; continue; }
        li += 1;
        while (li < lines.length) {
          idx = lines[li].indexOf('"""');
          if (idx >= 0) {
            line = lines[li];
            ci = idx + 2;
            prevChar = '"';
            lastWord = '';
            word = '';
            continue charloop;
          }
          li += 1;
        }
        sawUnterminatedLiteral = true;
        prevChar = '"';
        break outer;
      }

      if (ch === '@' && line[ci + 1] === '"') {
        let cj = ci + 2;
        let closedIdx = -1;
        for (;;) {
          while (cj < lines[li].length) {
            const rc = lines[li][cj];
            if (rc === '"' && lines[li][cj + 1] === '"') { cj += 2; continue; }
            if (rc === '"') { closedIdx = cj; break; }
            cj += 1;
          }
          if (closedIdx >= 0) break;
          li += 1;
          if (li >= lines.length) break;
          cj = 0;
        }
        if (closedIdx < 0) { sawUnterminatedLiteral = true; prevChar = '"'; break outer; }
        line = lines[li];
        ci = closedIdx;
        prevChar = '"';
        lastWord = '';
        word = '';
        continue charloop;
      }

      if (ch === '"') {
        frames.push({ kind: 'string', quote: '"' });
        continue;
      }

      if (ch === "'") {
        if (ci > 0 && isWordChar(line[ci - 1]) && ci + 1 < line.length && isWordChar(line[ci + 1])) {
          prevChar = "'";
          continue;
        }
        ci += 1;
        while (ci < line.length && line[ci] !== "'") {
          if (line[ci] === '\\') ci += 1;
          ci += 1;
        }
        prevChar = "'";
        lastWord = '';
        word = '';
        continue;
      }

      if (ch === '`') { frames.push({ kind: 'template' }); continue; }

      if (ch === '/') {
        const afterWord = lastWord !== '' && word === '' && REGEX_OK_WORDS.has(lastWord);
        if (REGEX_OK_PREV.has(prevChar) || afterWord) {
          let cj = ci + 1;
          let inClass = false;
          let closed = false;
          while (cj < line.length) {
            const rc = line[cj];
            if (rc === '\\') { cj += 2; continue; }
            if (rc === '[') inClass = true;
            else if (rc === ']') inClass = false;
            else if (rc === '/' && !inClass) { closed = true; break; }
            cj += 1;
          }
          if (closed) {
            while (cj + 1 < line.length && /[a-z]/.test(line[cj + 1])) cj += 1;
            ci = cj + 1 >= line.length ? line.length : cj + 1;
            prevChar = '/';
            lastWord = '';
            word = '';
            continue;
          }
        }
        prevChar = '/';
        continue;
      }

      if (ch === '(') {
        parenOwners.push(word !== '' ? word : lastWord);
        lastWord = '';
        word = '';
        prevChar = '(';
        continue;
      }

      if (ch === ')') {
        const restored = parenOwners.length > 0 ? (parenOwners.pop() as string) : '';
        lastWord = REGEX_OK_AFTER_PAREN.has(restored) ? restored : '';
        word = '';
        prevChar = ')';
        continue;
      }

      if (ch === '{') {
        if (frames.length === 1) {
          const sigStart = signatureStart(lines, li);
          spans.push({
            sigStart,
            from: li + 1,
            node: { signature: '', from: sigStart + 1, to: li + 1, depth: spans.length, children: [] },
          });
        }
        depth += 1;
        prevChar = '{';
        lastWord = '';
        word = '';
        continue;
      }

      if (ch === '}') {
        const codeFrame = frames[frames.length - 1] as { kind: 'code'; base: number };
        if (frames.length > 1 && depth === codeFrame.base) {
          frames.pop();
        } else if (frames.length > 1) {
          depth -= 1;
        } else if (depth > 0) {
          depth -= 1;
          if (spans.length > 0) closeBlock(li);
        } else {
          sawStrayClose = true;
        }
        prevChar = '}';
        lastWord = '';
        word = '';
        continue;
      }

      if (!/\s/.test(ch)) prevChar = ch;
      if (isWordChar(ch)) word += ch;
      else { lastWord = word; word = ''; }
    }
    if (word) { lastWord = word; word = ''; }
  }

  const balanced =
    depth === 0 && frames.length === 1 && !sawStrayClose && !sawUnterminatedLiteral &&
    validateFoldTree(roots);
  return { blocks: roots, balanced, scanned: 'brace' };
}

/** A statement keyword starting a line — the signature walk must stop there. */
const STATEMENT_START =
  /^(const|let|var|import|export|class|function|type|interface|enum|namespace|return|throw|try|catch|do|if|for|while|switch)\b/;
/** A line ending mid-expression — the signature above it is still open. */
const CONTINUES_LINE = /(?:[,([{=?:&|+\-*/\\]|=>)$/;

/** Walk upward from the brace line to collect a multi-line signature. */
function signatureStart(lines: string[], braceLine: number): number {
  let start = braceLine;
  let steps = 0;
  while (start - 1 >= 0 && steps < SIGNATURE_LOOKBACK) {
    const prev = lines[start - 1].trim();
    if (!prev) break;
    if (/[;{}]$/.test(prev)) break;
    if (prev.startsWith('}')) break;
    if (prev.startsWith('//') || prev.startsWith('/*') || prev.startsWith('*')) break;
    if (/["'`]$/.test(prev)) break;
    if (STATEMENT_START.test(prev) && !CONTINUES_LINE.test(prev)) break;
    start -= 1;
    steps += 1;
  }
  return start;
}

/** Join the signature lines and clamp their length. */
function joinSignature(lines: string[], start: number, braceLine: number): string {
  const joined = lines
    .slice(start, braceLine + 1)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return capSignature(joined);
}

/**
 * Cheap post-scan invariant check: every block's window is sane and nests
 * inside its parent. A violated invariant means the scan misparsed — degrade
 * to `balanced: false` instead of shipping a wrong map.
 */
function validateFoldTree(blocks: FoldBlock[]): boolean {
  const check = (b: FoldBlock, parent: FoldBlock | undefined): boolean => {
    if (b.from < 1 || b.to < b.from) return false;
    if (parent !== undefined) {
      if (b.from < parent.from || b.to > parent.to) return false;
      if (b.depth !== parent.depth + 1) return false;
    }
    let prevFrom = 0;
    for (const c of b.children) {
      if (c.from < prevFrom) return false;
      if (check(c, b) === false) return false;
      prevFrom = c.from;
    }
    return true;
  };
  let prevFrom = 0;
  for (const r of blocks) {
    if (r.from < prevFrom) return false;
    if (check(r, undefined) === false) return false;
    prevFrom = r.from;
  }
  return true;
}


function scanIndent(lines: string[]): FoldResult {
  const roots: FoldBlock[] = [];
  const stack: Array<{ indent: number; node: FoldBlock }> = [];
  let lastContent = 0;

  interface LineInfo { code: string; delta: number; depthAfter: number; inert: boolean; }
  const infos: LineInfo[] = new Array(lines.length);

  let inTriple: string | null = null;
  let brackDepth = 0;
  let sawInvalidBrackets = false;

  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li].replace(/\t/g, '    ');
    let code = '';
    let delta = 0;
    let ci = 0;
    while (ci < raw.length) {
      const ch = raw[ci];
      if (inTriple !== null) {
        const end = raw.indexOf(inTriple, ci);
        if (end === -1) { ci = raw.length; continue; }
        ci = end + 3;
        inTriple = null;
        continue;
      }
      if (ch === "'" && raw[ci + 1] === "'" && raw[ci + 2] === "'") {
        const end = raw.indexOf("'''", ci + 3);
        if (end === -1) { inTriple = "'''"; ci = raw.length; continue; }
        ci = end + 3;
        continue;
      }
      if (ch === '"' && raw[ci + 1] === '"' && raw[ci + 2] === '"') {
        const end = raw.indexOf('"""', ci + 3);
        if (end === -1) { inTriple = '"""'; ci = raw.length; continue; }
        ci = end + 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let cj = ci + 1;
        for (;;) {
          if (cj >= raw.length) { ci = raw.length; break; }
          if (raw[cj] === '\\') { cj += 2; continue; }
          if (raw[cj] === ch) { ci = cj + 1; break; }
          cj += 1;
        }
        continue;
      }
      if (ch === '#') break;
      if (ch === '(' || ch === '[' || ch === '{') delta += 1;
      else if (ch === ')' || ch === ']' || ch === '}') delta -= 1;
      code += ch;
      ci += 1;
    }
    brackDepth += delta;
    if (brackDepth < 0) { sawInvalidBrackets = true; brackDepth = 0; }
    infos[li] = { code: code.trim(), delta, depthAfter: brackDepth, inert: code.trim() === '' };
  }
  const unterminatedTriple = inTriple !== null;

  for (let li = 0; li < lines.length; li += 1) {
    const info = infos[li];
    if (info.inert) continue;

    const raw = lines[li].replace(/\t/g, '    ');
    const indent = raw.length - raw.trimStart().length;

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      const node = (stack.pop() as { indent: number; node: FoldBlock }).node;
      node.to = lastContent;
      if (stack.length > 0) stack[stack.length - 1].node.children.push(node);
      else roots.push(node);
    }

    lastContent = li + 1;

    if (info.code.endsWith(':') && info.depthAfter === 0) {
      let nextIndent = -1;
      for (let nj = li + 1; nj < lines.length; nj += 1) {
        if (infos[nj].inert) continue;
        const nRaw = lines[nj].replace(/\t/g, '    ');
        nextIndent = nRaw.length - nRaw.trimStart().length;
        break;
      }
      if (nextIndent > indent) {
        let sigStart = li;
        let steps = 0;
        while (sigStart - 1 >= 0 && steps < SIGNATURE_LOOKBACK) {
          const above = lines[sigStart - 1].trim();
          if (!above) break;
          if (above.startsWith('@')) { sigStart -= 1; steps += 1; continue; }
          if (infos[sigStart - 1].inert) break;
          if (/[,([{]$/.test(infos[sigStart - 1].code)) { sigStart -= 1; steps += 1; continue; }
          break;
        }
        const signature = infos
          .slice(sigStart, li + 1)
          .map((i) => i.code)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        stack.push({
          indent,
          node: { signature: capSignature(signature), from: sigStart + 1, to: li + 1, depth: stack.length, children: [] },
        });
      }
    }
  }

  while (stack.length > 0) {
    const node = (stack.pop() as { indent: number; node: FoldBlock }).node;
    node.to = lastContent;
    if (stack.length > 0) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
  }

  const balanced = !unterminatedTriple && !sawInvalidBrackets && validateFoldTree(roots);
  return { blocks: roots, balanced, scanned: 'indent' };
}
