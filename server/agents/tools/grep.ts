/**
 * agent__grep — search file contents across the active workspace with a
 * regular expression. Returns "path:line: text" matches; skips node_modules/
 * .git and binary or huge files.
 *
 * Supports: multi-pattern (patterns array), multi-glob (globs array), multi-
 * subpath (subpaths array), context lines, wholeLines (receipt mode), sort
 * "density", pagination (continueFrom), and per-file match cap.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import {
  str, num, bool,
  compilePattern, globToRegExp, truncateOutput,
  requireWorkspace, resolveWithPermission,
  MAX_MATCHES, MAX_MATCH_FILES, MAX_SCAN_BYTES,
  MAX_OUTPUT_CHARS, MAX_LINE_CHARS, MAX_MATCHES_PER_FILE,
} from './shared.js';
import { walkFiles } from './list.js';
import { recordRead } from '../read-policy.js';
import { sha256 } from '../edit-diagnostics.js';

const GENERIC_KEYWORDS = new Set([
  'done', 'error', 'finish', 'end', 'start', 'stop', 'run', 'ok', 'test',
  'event', 'state', 'type', 'data', 'file', 'name', 'value', 'key', 'main',
  'init', 'load', 'save', 'open', 'close', 'next', 'change', 'update',
]);

function isBroadPattern(source: string): boolean {
  if (source.includes('\\b')) return false;
  if (source === '.' || source === '.*') return true;
  const alts = source.split('|').map((part) => part.replace(/[\^$'"\s]/g, ''));
  return alts.length > 0 && alts.every((part) => GENERIC_KEYWORDS.has(part.toLowerCase()) || part === '' || part === '.');
}

const ARG_ALIASES: Record<string, string> = {
  path: 'subpath', directory: 'subpath', dir: 'subpath',
  query: 'pattern', regex: 'pattern',
  max_results: 'maxResults', case_sensitive: 'caseSensitive',
  whole_lines: 'wholeLines', continue_from: 'continueFrom',
};
const ALLOWED_ARGS = new Set([
  'pattern', 'patterns', 'glob', 'globs', 'subpath', 'subpaths',
  'caseSensitive', 'maxResults', 'context', 'wholeLines', 'sort', 'continueFrom',
]);

function normalizeArgs(raw: Record<string, unknown>): {
  args: Record<string, unknown>;
  unknown: string[];
  aliasesUsed: string[];
} {
  const args: Record<string, unknown> = {};
  const unknown: string[] = [];
  const aliasesUsed: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const canonical = ARG_ALIASES[key] ?? key;
    if (!ALLOWED_ARGS.has(canonical)) { unknown.push(key); continue; }
    if (ARG_ALIASES[key] && !aliasesUsed.includes(key)) aliasesUsed.push(key);
    if (args[canonical] === undefined) args[canonical] = value;
  }
  return { args, unknown, aliasesUsed };
}

/**
 * P0b — when a subpath doesn't exist, walk the workspace root once and find
 * files whose basename matches or starts with the input's basename. Cheap
 * heuristic that catches typos and wrong extensions.
 */
function suggestPaths(input: string, ctx?: AgentToolContext): string[] {
  let root: string;
  try { root = requireWorkspace(ctx).root; } catch { return []; }
  const basename = path.basename(input).toLowerCase();
  if (!basename) return [];
  try {
    const walked = walkFiles(root);
    return walked.files
      .filter((f) => {
        const fb = path.basename(f).toLowerCase();
        return fb === basename || (basename.length >= 4 && fb.includes(basename.slice(0, 4)));
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function grepTool(rawArgs: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { args, unknown, aliasesUsed } = normalizeArgs(rawArgs);
  if (unknown.length > 0) {
    return {
      ok: false, isError: true,
      text: `grep: unknown argument(s): ${unknown.join(', ')}. Accepted: pattern(s), glob(s), subpath(s) (alias: "path"), caseSensitive, maxResults, context, wholeLines, sort, continueFrom.`,
    };
  }
  const rawPattern = str(args, 'pattern').trim();
  const rawPatterns = Array.isArray(args.patterns)
    ? args.patterns.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const patterns = rawPatterns.length > 0 ? rawPatterns : rawPattern ? [rawPattern] : [];
  if (patterns.length === 0) {
    return { ok: false, isError: true, text: 'grep needs a "pattern" (regular expression) or a "patterns" array.' };
  }
  const broadPatterns = patterns.filter((source) => isBroadPattern(source));
  const multiPattern = patterns.length > 1;
  const caseSensitive = bool(args, 'caseSensitive');
  const regexes: Array<{ source: string; re: RegExp }> = [];
  for (const source of patterns) {
    try {
      regexes.push({ source, re: compilePattern(source, caseSensitive) });
    } catch (error) {
      return {
        ok: false,
        isError: true,
        text: `Invalid pattern /${source}/: ${error instanceof Error ? error.message : 'compile failed'}.`,
      };
    }
  }

  const globList: string[] = [];
  const singleGlob = str(args, 'glob').trim();
  if (singleGlob) globList.push(singleGlob);
  if (Array.isArray(args.globs)) {
    for (const entry of args.globs) {
      if (typeof entry === 'string' && entry.trim()) {
        const trimmed = entry.trim();
        if (!globList.includes(trimmed)) globList.push(trimmed);
      }
    }
  }
  const globRes = globList.map((entry) => globToRegExp(entry));

  const rawSubpaths = Array.isArray(args.subpaths)
    ? args.subpaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const subpathSingle = str(args, 'subpath').trim();
  const subpaths = rawSubpaths.length > 0 ? rawSubpaths : subpathSingle ? [subpathSingle] : [];
  const roots: Array<{ absolute: string; relative: string }> = [];
  const explicitFiles: Array<{ displayPath: string; absolute: string }> = [];
  for (const sub of subpaths) {
    const resolved = await resolveWithPermission('grep', sub, ctx);
    let stats;
    try {
      stats = statSync(resolved.absolute);
    } catch {
      const candidates = suggestPaths(sub, ctx);
      return {
        ok: false, isError: true,
        text: `subpath "${sub}" not found${candidates.length ? ` — did you mean: ${candidates.slice(0, 4).join(', ')}?` : ''}.`,
      };
    }
    if (stats.isFile()) {
      explicitFiles.push({ displayPath: resolved.relative, absolute: resolved.absolute });
    } else {
      roots.push({ absolute: resolved.absolute, relative: resolved.relative });
    }
  }
  if (roots.length === 0 && explicitFiles.length === 0) {
    roots.push({ absolute: requireWorkspace(ctx).root, relative: '.' });
  }

  const maxResults = Math.min(Math.max(num(args, 'maxResults') ?? MAX_MATCHES, 1), MAX_MATCHES);
  const context = Math.min(Math.max(Math.trunc(num(args, 'context') ?? 0), 0), 10);
  const wholeLines = bool(args, 'wholeLines');
  const receiptMode = context > 0 || wholeLines;
  const density = str(args, 'sort').trim().toLowerCase() === 'density' && !receiptMode;

  const continueToken = str(args, 'continueFrom').trim();
  let resumeFileIdx = 0;
  let resumeLine = 0;
  if (continueToken) {
    const m = continueToken.match(/^g:(\d+):(\d+)$/);
    if (!m) {
      return {
        ok: false,
        isError: true,
        text: `Invalid continueFrom "${continueToken}" — expected the g:<fileIdx>:<lineIdx> token from a previous grep footer.`,
      };
    }
    resumeFileIdx = parseInt(m[1], 10);
    resumeLine = parseInt(m[2], 10);
  }

  const fileOrder: Array<{ displayPath: string; absolute: string }> = [];
  const seenPaths = new Set<string>();
  let walkTruncated = false;
  for (const root of roots) {
    const walked = walkFiles(root.absolute);
    walkTruncated = walkTruncated || walked.truncated;
    for (const file of walked.files) {
      if (globRes.length > 0 && !globRes.some((re) => re.test(file) || re.test(path.basename(file)))) continue;
      const displayPath = root.relative === '.' ? file : `${root.relative}/${file}`;
      if (seenPaths.has(displayPath)) continue;
      seenPaths.add(displayPath);
      fileOrder.push({ displayPath, absolute: path.join(root.absolute, file) });
    }
  }

  for (const ef of explicitFiles) {
    if (seenPaths.has(ef.displayPath)) continue;
    seenPaths.add(ef.displayPath);
    fileOrder.push(ef);
  }

  interface FileScan {
    displayPath: string;
    absolute: string;
    content: string;
    view: string[];
    mtimeMs: number;
    /** 1-based line numbers with the pattern indexes that matched. */
    hits: Array<{ lineNo: number; matched: number[] }>;
    perFileCapHit: boolean;
  }
  const scans: FileScan[] = [];
  const matchedFiles = new Set<string>();
  const perFileTruncated: string[] = [];
  const binaryNames: string[] = [];
  const bigSkippedNames: string[] = [];
  let scanned = 0;
  let binarySkipped = 0;
  let bigSkipped = 0;
  let totalMatches = 0;
  let stopFileIdx = -1;
  let stopLine = 0;
  let maxStopped = false;

  const probeTokens = [...new Set(
    patterns.join(' ')
      .split(/[^A-Za-z0-9]+/)
      .flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 4 && !GENERIC_KEYWORDS.has(w)),
  )].slice(0, 4);
  const probes: Array<{ t: string; re: RegExp; count: number; examples: string[] }> = [];
  for (const t of probeTokens) {
    try { probes.push({ t, re: compilePattern(t, false), count: 0, examples: [] }); }
    catch {  }
  }

  scan: for (let fileIdx = resumeFileIdx; fileIdx < fileOrder.length; fileIdx += 1) {
    if (totalMatches >= maxResults || matchedFiles.size >= MAX_MATCH_FILES) {
      stopFileIdx = fileIdx;
      stopLine = 0;
      maxStopped = totalMatches >= maxResults;
      break;
    }
    const target = fileOrder[fileIdx];
    let content = '';
    let mtimeMs = 0;
    try {
      const stats = statSync(target.absolute);
      if (stats.size === 0) continue;
      if (stats.size > MAX_SCAN_BYTES) {
        bigSkipped += 1;
        bigSkippedNames.push(target.displayPath);
        continue;
      }
      content = readFileSync(target.absolute, 'utf8');
      mtimeMs = stats.mtimeMs;
    } catch {
      continue;
    }
    if (content.includes('\0')) {
      binarySkipped += 1;
      if (binaryNames.length < 6) binaryNames.push(target.displayPath);
      continue;
    }
    scanned += 1;
    const lines = content.split('\n');
    const view = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

    const hits: FileScan['hits'] = [];
    let perFileCapHit = false;
    const startIdx = fileIdx === resumeFileIdx && resumeLine > 0 ? resumeLine - 1 : 0;
    for (let index = startIdx; index < view.length; index += 1) {
      if (hits.length >= MAX_MATCHES_PER_FILE) {
        perFileCapHit = true;
        break;
      }
      if (totalMatches + hits.length >= maxResults) {
        stopFileIdx = fileIdx;
        stopLine = index + 1;
        maxStopped = true;
        break;
      }
      const line = view[index];
      const matched: number[] = [];
      for (let r = 0; r < regexes.length; r += 1) {
        if (regexes[r].re.test(line)) matched.push(r);
      }
      if (matched.length === 0) {
        if (totalMatches === 0 && hits.length === 0) {
          for (const probe of probes) {
            if (probe.count > 20) continue;
            if (probe.re.test(line)) {
              probe.count += 1;
              if (probe.examples.length < 2) {
                probe.examples.push(`${target.displayPath}:${index + 1}: ${line.trim().slice(0, 120)}`);
              }
            }
          }
        }
        continue;
      }
      hits.push({ lineNo: index + 1, matched });
    }
    if (stopFileIdx >= 0) break scan;
    if (hits.length === 0) continue;
    if (perFileCapHit) perFileTruncated.push(target.displayPath);
    matchedFiles.add(target.displayPath);
    totalMatches += hits.length;
    scans.push({ displayPath: target.displayPath, absolute: target.absolute, content, view, mtimeMs, hits, perFileCapHit });
  }

  if (density) {
    scans.sort((a, b) => b.hits.length - a.hits.length);
  }

  const matches: string[] = [];
  let budget = MAX_OUTPUT_CHARS;
  let budgetStopped = false;
  let receiptCount = 0;
  const receiptFooters: string[] = [];
  /** FIX 1: never silently cut a line again — the ellipsis is the contract. */
  const flatLine = (displayPath: string, lineNo: number, text: string): string => {
    const trimmed = text.trim();
    const cut = trimmed.length > MAX_LINE_CHARS;
    return `${displayPath}:${lineNo}: ${cut ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed}`;
  };

  if (multiPattern) {
    const perPatternBudget = Math.max(2_000, Math.floor(MAX_OUTPUT_CHARS / patterns.length));
    let usedChars = 0;
    for (let r = 0; r < patterns.length; r += 1) {
      let groupBudget = perPatternBudget;
      let groupCount = 0;
      let droppedText = 0;
      const rows: string[] = [];
      for (const scan of scans) {
        for (const hit of scan.hits) {
          if (!hit.matched.includes(r)) continue;
          groupCount += 1;
          const row = flatLine(scan.displayPath, hit.lineNo, scan.view[hit.lineNo - 1] ?? '');
          if (row.length + 1 <= groupBudget) {
            rows.push(row);
            groupBudget -= row.length + 1;
          } else {
            droppedText += 1;
          }
        }
      }
      const head = `## /${patterns[r]}/ (${groupCount} match(es)${droppedText > 0 ? `; ${droppedText} line(s) dropped at group budget` : ''})`;
      usedChars += head.length + rows.join('\n').length + 2;
      matches.push(head, ...rows);
    }
    if (usedChars > MAX_OUTPUT_CHARS) budgetStopped = true;
  } else if (!receiptMode) {
    for (const scan of scans) {
      for (const hit of scan.hits) {
        const row = flatLine(scan.displayPath, hit.lineNo, scan.view[hit.lineNo - 1] ?? '');
        if (row.length + 1 > budget) {
          budgetStopped = true;
          break;
        }
        matches.push(row);
        budget -= row.length + 1;
      }
      if (budgetStopped) break;
    }
  } else {
    for (const scan of scans) {
      if (budgetStopped) break;
      const windows: Array<{ from: number; to: number; hits: number }> = [];
      for (const hit of scan.hits) {
        const from = Math.max(1, hit.lineNo - context);
        const to = Math.min(scan.view.length, hit.lineNo + context);
        const last = windows[windows.length - 1];
        if (last && from <= last.to + 2) {
          last.to = Math.max(last.to, to);
          last.hits += 1;
        } else {
          windows.push({ from, to, hits: 1 });
        }
      }
      let lastReceipt: { from: number; to: number; rev: number } | null = null;
      for (const window of windows.slice(0, 12)) {
        if (budgetStopped) break;
        const mergedNote = window.hits > 1 ? ` (${window.hits} hits merged)` : '';
        const header = `── ${scan.displayPath} · lines ${window.from}–${window.to}${mergedNote}`;
        if (header.length + 1 > budget) {
          budgetStopped = true;
          break;
        }
        matches.push(header);
        budget -= header.length + 1;
        for (let n = window.from; n <= window.to; n += 1) {
          const row = `${String(n).padStart(5)}${scan.hits.some((h) => h.lineNo === n) ? '*' : '|'} ${scan.view[n - 1]}`;
          if (row.length + 1 > budget) {
            budgetStopped = true;
            break;
          }
          matches.push(row);
          budget -= row.length + 1;
        }
        const receiptEntry = recordRead(ctx.sessionId, scan.absolute, scan.content, scan.mtimeMs, window.from, window.to);
        lastReceipt = { from: window.from, to: window.to, rev: receiptEntry?.rev ?? 1 };
        receiptCount += 1;
      }
      receiptFooters.push(
        `[${scan.displayPath} | sha256:${sha256(scan.content).slice(0, 12)} | ${windows.length} window(s)${windows.length > 12 ? ` (showing 12 of ${windows.length})` : ''}; receipt retained for lines ` +
          `${lastReceipt ? `${lastReceipt.from}–${lastReceipt.to}` : '?'} (read#${lastReceipt?.rev ?? 1})]`,
      );
    }
  }

  if (totalMatches === 0) {
    const scopeParts: string[] = [];
    if (subpaths.length > 0) {
      scopeParts.push(`scope: ${subpaths.join(', ')}`);
    } else {
      scopeParts.push('scope: WORKSPACE ROOT (no subpath given)');
    }
    if (globList.length > 0) scopeParts.push(`glob ${globList.join(', ')}`);
    const scope = scopeParts.join('; ');
    const alts = patterns.length === 1
      ? patterns[0].split('|').map((s) => s.trim()).filter(Boolean)
      : patterns;
    const altNote = alts.length > 1
      ? `\nEvery alternative was tested: ${alts.map((a) => `/${a}/ → 0`).join(', ')} — these names do not exist in scope.`
      : '';
    let probeNote = '';
    const probeHits = probes.filter((p) => p.count > 0);
    const probeMisses = probes.filter((p) => p.count === 0);
    if (probes.length > 0) {
      const lines: string[] = ['Related-token scan (case-insensitive):'];
      for (const p of probeHits) {
        if (p.count > 20) {
          lines.push(`  ${p.t}: ${p.count} hits (too common to list — refine)`);
        } else {
          lines.push(`  ${p.t}: ${p.count} hit(s)`, ...p.examples.map((e) => `    ${e}`));
        }
      }
      if (probeMisses.length > 0) {
        lines.push(`  ${probeMisses.map((p) => p.t).join(', ')}: 0 — no trace of these words anywhere`);
      }
      probeNote = `\n${lines.join('\n')}`;
    }
    const aliasNote = aliasesUsed.length > 0
      ? `\n[note: "${aliasesUsed.join(', ')}" accepted as alias(es) — use canonical names next time]`
      : '';
    const broadNote = broadPatterns.length > 0
      ? `[warn: /${broadPatterns.join('/, /')}/ is a broad generic-keyword pattern — scope it with subpath or anchor with \\b]\n`
      : '';
    return {
      ok: true,
      isError: false,
      text: `${broadNote}No matches for /${patterns.join('/, /')}/ — ${scope}; scanned ${scanned} file(s)${walkTruncated ? ' (file walk truncated)' : ''}.${altNote}${probeNote}${aliasNote}`,
    };
  }

  const notes: string[] = [];
  if (maxStopped) notes.push(`stopped at ${maxResults} matches`);
  if (matchedFiles.size >= MAX_MATCH_FILES) notes.push(`stopped at ${MAX_MATCH_FILES} files`);
  if (walkTruncated) notes.push('file walk truncated');
  if (binarySkipped > 0) {
    notes.push(
      `${binarySkipped} binary file(s) skipped${binaryNames.length ? `: ${binaryNames.join(', ')}${binarySkipped > binaryNames.length ? ', …' : ''}` : ''}`,
    );
  }
  if (bigSkipped > 0) {
    const names = bigSkippedNames.slice(0, 6).join(', ');
    notes.push(
      `${bigSkipped} file(s) over ${MAX_SCAN_BYTES / 1000} KB skipped — ${names}${bigSkipped > 6 ? ', …' : ''} (use agent__read_file instead)`,
    );
  }
  if (perFileTruncated.length > 0) {
    const names = perFileTruncated.slice(0, 6).join(', ');
    notes.push(
      `${perFileTruncated.length} file(s) truncated at ${MAX_MATCHES_PER_FILE} matches: ${names}${perFileTruncated.length > 6 ? ', …' : ''} — narrow the pattern for those files`,
    );
  }
  if (scans.length >= 2) {
    const ranked = [...scans].sort((a, b) => b.hits.length - a.hits.length).slice(0, 5);
    notes.push(`top files by matches: ${ranked.map((s) => `${s.displayPath}: ${s.hits.length}`).join(', ')}`);
  }
  if (subpaths.length === 0) {
    const byDir = new Map<string, number>();
    for (const scan of scans) {
      const top = scan.displayPath.includes('/') ? scan.displayPath.split('/')[0] : '.';
      byDir.set(top, (byDir.get(top) ?? 0) + scan.hits.length);
    }
    const topDir = [...byDir.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDir && topDir[0] !== '.' && topDir[1] >= Math.max(3, Math.ceil(totalMatches * 0.6))) {
      notes.push(`matches concentrated in "${topDir[0]}/" — retry with subpath: "${topDir[0]}"`);
    }
  }
  if (budgetStopped) notes.push('stopped at the output budget — narrow the pattern or lower context');
  if (multiPattern && receiptMode) notes.push('read receipts require a single pattern — multi-pattern renders flat lines');

  if (stopFileIdx >= 0 && !density) {
    notes.push(`pagination: next "g:${stopFileIdx}:${stopLine}" — pass back as continueFrom for the next page`);
  } else if (stopFileIdx >= 0 && density) {
    notes.push('pagination unavailable with sort=density — raise maxResults or narrow the pattern');
  }

  const footers = receiptFooters.length > 0 ? `\n${receiptFooters.join('\n')}` : '';
  const broadNote =
    broadPatterns.length > 0
      ? `[warn: /${broadPatterns.join('/, /')}/ is a broad generic-keyword pattern — scope it with subpath or anchor with \\b, or the noise will keep coming]\n`
      : '';
  return {
    ok: true,
    isError: false,
    text: truncateOutput(
      `${broadNote}${matches.join('\n')}${footers}\n\n[${totalMatches} match(es) in ${matchedFiles.size} file(s)` +
        `${receiptCount > 0 ? `; ${receiptCount} read receipt(s) granted` : ''}${notes.length ? `; ${notes.join(', ')}` : ''}]`,
    ),
  };
}
