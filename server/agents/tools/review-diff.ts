/**
 * F3.8 — agent__review_diff: static checklist over the session's changes
 * (touched files) or a git diff. Reports issues; never modifies anything.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, truncateOutput, requireWorkspace } from './shared.js';
import { runShellCommand } from '../exec.js';
import { functionMetrics } from '../ts-ast.js';
import { defineTool } from './registry.js';
import { touchedFiles } from './diagnostics.js';

interface Issue {
  category: string;
  location: string;
  detail: string;
}

const RULES: Array<{ category: string; re: RegExp; detail: (m: RegExpMatchArray) => string }> = [
  { category: 'debug-leftover', re: /(?:^|\s)(console\.log|debugger)\b/, detail: (m) => `${m[1]} left in code` },
  { category: 'todo', re: /(?:TODO|FIXME)\b/, detail: (m) => `${m[0]} marker` },
  { category: 'any', re: /:\s*any\b/, detail: () => 'new `any` usage' },
  { category: 'ts-ignore', re: /@ts-(?:ignore|expect-error)/, detail: (m) => `${m[0]}` },
  { category: 'eslint-disable', re: /eslint-disable/, detail: () => 'eslint-disable' },
  { category: 'repo-rule', re: /\btitle=\s*["'{]/, detail: () => 'native title= attribute in UI (repo rule: use theme Tip)' },
  { category: 'repo-rule', re: /\blocalStorage\./, detail: () => 'localStorage usage (repo rule: forbidden)' },
  { category: 'game', re: /new\s+THREE\.\w*(?:Geometry|Material|Texture)/, detail: (m) => `${m[0]} — check .dispose() in the same file` },
  { category: 'game', re: /setPixelRatio\(\s*window\.devicePixelRatio\s*\)/, detail: () => 'setPixelRatio without Math.min cap' },
];

async function reviewDiffTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const scope = str(args, 'scope').trim().toLowerCase() || 'session';

  const files = new Set<string>();
  if (scope === 'session') {
    for (const abs of touchedFiles()) files.add(abs);
    if (files.size === 0) {
      return { ok: true, isError: false, text: 'No files touched this session. Use scope "git" to review the git diff instead.' };
    }
  } else {
    const outcome = await runShellCommand('git diff --name-only HEAD', { cwd: root, timeoutMs: 15_000 });
    if (outcome.exitCode !== 0) {
      return { ok: false, isError: true, text: `git diff failed (exit=${outcome.exitCode}). Is this a git repo?` };
    }
    for (const line of outcome.stdout.split('\n')) {
      const t = line.trim();
      if (t) files.add(path.join(root, t.split('/').join(path.sep)));
    }
    const untracked = await runShellCommand('git ls-files --others --exclude-standard', { cwd: root, timeoutMs: 15_000 });
    if (untracked.exitCode === 0) {
      for (const line of untracked.stdout.split('\n')) {
        const t = line.trim();
        if (t) files.add(path.join(root, t.split('/').join(path.sep)));
      }
    }
  }

  const issues: Issue[] = [];
  let checked = 0;
  for (const abs of [...files].slice(0, 100)) {
    let content: string;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    if (!/\.(ts|tsx|js|jsx|css)$/.test(abs)) continue;
    checked += 1;
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const rule of RULES) {
        const m = line.match(rule.re);
        if (m) {
          issues.push({ category: rule.category, location: `${rel}:${i + 1}`, detail: rule.detail(m) });
        }
      }
    }

    // Metrics thresholds for new functions (3D/game + repo quality).
    if (/\.(ts|tsx|js|jsx)$/.test(abs)) {
      for (const m of functionMetrics(content, path.basename(abs))) {
        if (m.lengthLines > 80) issues.push({ category: 'metrics', location: `${rel}:${m.line}`, detail: `${m.name}: ${m.lengthLines} lines (> 80)` });
        if (m.cyclomatic > 15) issues.push({ category: 'metrics', location: `${rel}:${m.line}`, detail: `${m.name}: cyclomatic ${m.cyclomatic} (> 15)` });
      }
      // Server import style: server/** must import relative with .js
      if (rel.startsWith('server/')) {
        for (let i = 0; i < lines.length; i += 1) {
          const m = lines[i].match(/from\s+'(\.\.?\/[^']*?)'/);
          if (m && !/\.(js|json)$/.test(m[1])) {
            issues.push({ category: 'repo-rule', location: `${rel}:${i + 1}`, detail: `server import without .js extension: ${m[1]}` });
          }
        }
      }
    }
  }

  const byCategory = new Map<string, Issue[]>();
  for (const issue of issues) {
    const list = byCategory.get(issue.category) ?? [];
    list.push(issue);
    byCategory.set(issue.category, list);
  }

  const lines: string[] = [`# review_diff (${scope}) — ${checked} file(s) checked, ${issues.length} issue(s):`];
  if (issues.length === 0) {
    lines.push('✓ no issues from the static checklist.');
    return { ok: true, isError: false, text: lines.join('\n') };
  }
  for (const [category, list] of byCategory) {
    lines.push(`✗ ${category} (${list.length}):`);
    for (const issue of list.slice(0, 15)) {
      lines.push(`  ${issue.location}  ${issue.detail}`);
    }
    if (list.length > 15) lines.push(`  … and ${list.length - 15} more`);
  }
  lines.push('');
  lines.push('This is a static checklist, not a substitute for review. Nothing was modified.');
  return { ok: false, isError: true, text: truncateOutput(lines.join('\n')) };
}

export const reviewDiffSpec = defineTool({
  def: {
    wireName: 'agent__review_diff',
    description: 'Static review checklist over session changes or git diff: debug leftovers, new any/ts-ignore, repo rules, game dispose pitfalls.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'git'], description: 'Scope (default "session").' },
      },
    },
  },
  handler: reviewDiffTool,
  readOnly: true,
  category: 'quality',
});
