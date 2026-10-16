/**
 * F3.6 — agent__code_metrics: per-function complexity/length/nesting/params,
 * per-file LOC + exports, optional git-churn hotspot blend.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { functionMetrics, exportedNames } from '../ts-ast.js';
import { walkFiles } from './list.js';
import { globToRegExp } from './shared.js';
import { defineTool } from './registry.js';

const WARN_FN_LINES = 80;
const WARN_CYCLO = 15;
const WARN_NESTING = 4;
const WARN_FILE_LINES = 800;

async function codeMetricsTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const subpath = str(args, 'subpath').trim() || '.';
  const resolved = await resolveWithPermission('code_metrics', subpath, ctx);
  const top = Math.min(Math.max(num(args, 'top') ?? 15, 1), 100);
  const sort = str(args, 'sort').trim().toLowerCase() || 'complexity';

  const globRe = globToRegExp('**/*.{ts,tsx,js,jsx}');
  const files = walkFiles(resolved.absolute).files.filter((f) => globRe.test(f)).slice(0, 1500);
  if (files.length === 0) {
    return { ok: true, isError: false, text: `No TS/JS files under "${subpath}".` };
  }

  const churn = new Map<string, number>();
  try {
    const { runShellCommand } = await import('../exec.js');
    const outcome = await runShellCommand('git log --since=90.days --name-only --pretty=format:', {
      cwd: root,
      timeoutMs: 15_000,
    });
    if (outcome.exitCode === 0) {
      for (const line of outcome.stdout.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        churn.set(t, (churn.get(t) ?? 0) + 1);
      }
    }
  } catch {  }

  interface Row {
    file: string;
    name: string;
    line: number;
    lengthLines: number;
    cyclomatic: number;
    nesting: number;
    params: number;
    hotspot: number;
  }
  const rows: Row[] = [];
  const fileLines: Array<{ file: string; loc: number; exports: number }> = [];
  let warnings = 0;

  for (const file of files) {
    let content: string;
    try { content = readFileSync(path.join(resolved.absolute, file), 'utf8'); } catch { continue; }
    const loc = content.split('\n').length;
    const exports = exportedNames(content, file).length;
    fileLines.push({ file, loc, exports });
    if (loc > WARN_FILE_LINES) warnings += 1;
    const commits = churn.get(file) ?? 0;
    for (const m of functionMetrics(content, file)) {
      if (m.lengthLines > WARN_FN_LINES || m.cyclomatic > WARN_CYCLO || m.nesting > WARN_NESTING) warnings += 1;
      rows.push({
        file,
        name: m.name,
        line: m.line,
        lengthLines: m.lengthLines,
        cyclomatic: m.cyclomatic,
        nesting: m.nesting,
        params: m.params,
        hotspot: commits * m.lengthLines,
      });
    }
  }

  rows.sort((a, b) => {
    if (sort === 'length') return b.lengthLines - a.lengthLines;
    if (sort === 'hotspot') return b.hotspot - a.hotspot;
    return b.cyclomatic - a.cyclomatic;
  });

  const lines: string[] = [];
  lines.push(`# code_metrics — ${subpath} · ${files.length} file(s) · sort=${sort}`);
  lines.push('');
  lines.push(`top ${Math.min(top, rows.length)} function(s) by ${sort}:`);
  for (const r of rows.slice(0, top)) {
    const flags: string[] = [];
    if (r.lengthLines > WARN_FN_LINES) flags.push(`len>${WARN_FN_LINES}`);
    if (r.cyclomatic > WARN_CYCLO) flags.push(`cyclo>${WARN_CYCLO}`);
    if (r.nesting > WARN_NESTING) flags.push(`nest>${WARN_NESTING}`);
    lines.push(`  ${r.file}:${r.line}  ${r.name}  ${r.lengthLines} lines · cyclo ${r.cyclomatic} · nest ${r.nesting} · ${r.params} params${r.hotspot > 0 ? ` · hotspot ${r.hotspot}` : ''}${flags.length > 0 ? `  ⚠ ${flags.join(', ')}` : ''}`);
  }
  lines.push('');
  const bigFiles = fileLines.filter((f) => f.loc > WARN_FILE_LINES).sort((a, b) => b.loc - a.loc).slice(0, 10);
  if (bigFiles.length > 0) {
    lines.push(`file(s) > ${WARN_FILE_LINES} LOC:`);
    for (const f of bigFiles) lines.push(`  ${f.file}  ${f.loc} LOC · ${f.exports} exports`);
    lines.push('');
  }
  lines.push(`thresholds: fn > ${WARN_FN_LINES} lines · cyclomatic > ${WARN_CYCLO} · nesting > ${WARN_NESTING} · file > ${WARN_FILE_LINES} LOC — ${warnings} warning(s).`);
  return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
}

export const codeMetricsSpec = defineTool({
  def: {
    wireName: 'agent__code_metrics',
    description: 'Per-function complexity/length/nesting metrics + file LOC/export counts + git-churn hotspot; sort by complexity|length|hotspot.',
    inputSchema: {
      type: 'object',
      properties: {
        subpath: { type: 'string', description: 'Scope directory (default ".").' },
        top: { type: 'number', description: 'Top N functions (default 15, max 100).' },
        sort: { type: 'string', enum: ['complexity', 'length', 'hotspot'], description: 'Sort key (default "complexity").' },
      },
    },
  },
  handler: codeMetricsTool,
  readOnly: true,
  category: 'quality',
});
