/**
 * F3.3 — agent__lint: runs the PROJECT's own linter when configured
 * (biome / eslint / oxlint / ruff). Never installs anything; clear message
 * when no linter exists. fix:true is a MUTATION (vault snapshot per file).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, bool, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { runProcess } from '../exec.js';
import { auditToolCall } from '../audit.js';
import { snapshotFile } from '../vault.js';
import { defineTool } from './registry.js';

type LinterKind = 'biome' | 'eslint' | 'oxlint' | 'ruff' | 'none';

function detectLinter(cwd: string): { kind: LinterKind; configHint: string } {
  if (existsSync(path.join(cwd, 'biome.json')) || existsSync(path.join(cwd, 'biome.jsonc'))) return { kind: 'biome', configHint: 'biome.json' };
  const eslintCfg = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', '.eslintrc.js', '.eslintrc.json', '.eslintrc'].find((f) => existsSync(path.join(cwd, f)));
  if (eslintCfg) return { kind: 'eslint', configHint: eslintCfg };
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    if (pkg.devDependencies?.['oxlint']) return { kind: 'oxlint', configHint: 'package.json' };
  } catch { /* no package.json */ }
  if (existsSync(path.join(cwd, 'ruff.toml')) || existsSync(path.join(cwd, '.ruff.toml'))) return { kind: 'ruff', configHint: 'ruff.toml' };
  try {
    const pyproject = readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');
    if (pyproject.includes('[tool.ruff]')) return { kind: 'ruff', configHint: 'pyproject.toml' };
  } catch { /* no pyproject */ }
  return { kind: 'none', configHint: '' };
}

interface LintIssue {
  file: string;
  line: number;
  col: number;
  severity: string;
  rule: string;
  message: string;
}

/** Biome/eslint JSON reporter → normalized issues. */
function parseJsonIssues(text: string, root: string): LintIssue[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const json = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    // Biome shape
    if (Array.isArray(json.diagnostics)) {
      const out: LintIssue[] = [];
      for (const d of json.diagnostics as Array<Record<string, unknown>>) {
        const loc = d.location as { path?: { file?: string }; span?: { start?: { line: number; column: number } } } | undefined;
        if (!loc?.path?.file || !loc.span?.start) continue;
        out.push({
          file: path.relative(root, loc.path.file).replace(/\\/g, '/'),
          line: loc.span.start.line,
          col: loc.span.start.column,
          severity: String(d.severity ?? 'error'),
          rule: String(d.category ?? ''),
          message: String(d.message ?? ''),
        });
      }
      return out;
    }
    // ESLint shape
    if (Array.isArray(json)) {
      const out: LintIssue[] = [];
      for (const fileEntry of json as Array<{ filePath: string; messages?: Array<{ line: number; column: number; severity: number; ruleId: string | null; message: string }> }>) {
        for (const m of fileEntry.messages ?? []) {
          out.push({
            file: path.relative(root, fileEntry.filePath).replace(/\\/g, '/'),
            line: m.line,
            col: m.column,
            severity: m.severity === 1 ? 'warning' : 'error',
            rule: m.ruleId ?? '',
            message: m.message,
          });
        }
      }
      return out;
    }
  } catch { /* not JSON */ }
  return [];
}

/** Ruff JSON lines. */
function parseRuffIssues(text: string): LintIssue[] {
  const out: LintIssue[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const j = JSON.parse(s) as { filename?: string; location?: { row?: number; column?: number }; code?: string; message?: string };
      if (!j.filename) continue;
      out.push({
        file: j.filename.replace(/\\/g, '/'),
        line: j.location?.row ?? 1,
        col: j.location?.column ?? 1,
        severity: 'error',
        rule: j.code ?? '',
        message: j.message ?? '',
      });
    } catch { /* skip */ }
  }
  return out;
}

async function lintTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return { ok: false, isError: true, text: 'Terminal execution is turned OFF in the harness settings. Ask the user to enable it (Tools → Terminal: Ask or Auto) to run the project linter.' };
  }
  const { root } = requireWorkspace(ctx);
  const cwdRaw = str(args, 'cwd').trim() || '.';
  const resolved = await resolveWithPermission('lint', cwdRaw, ctx);
  const fix = bool(args, 'fix');
  const { kind, configHint } = detectLinter(resolved.absolute);
  if (kind === 'none') {
    return {
      ok: true,
      isError: false,
      text: 'No linter configured (no biome.json / eslint.config.* / oxlint in devDeps / ruff.toml). Nothing installed — add a linter config to the project to enable agent__lint.',
    };
  }

  const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  const targets = rawPaths.length > 0 ? rawPaths : ['.'];

  let program: string;
  let programArgs: string[];
  if (kind === 'biome') {
    program = 'npx.cmd';
    programArgs = ['biome', 'check', ...(fix ? ['--write'] : []), '--reporter=json', ...targets];
  } else if (kind === 'eslint') {
    program = 'npx.cmd';
    programArgs = ['eslint', '--format', 'json', ...(fix ? ['--fix'] : []), ...targets];
  } else if (kind === 'oxlint') {
    program = 'npx.cmd';
    programArgs = ['oxlint', ...(fix ? ['--fix'] : []), ...targets];
  } else {
    program = 'python';
    programArgs = ['-m', 'ruff', 'check', '--output-format', 'json', ...(fix ? ['--fix'] : []), ...targets];
  }

  if (fix) {
    // Vault snapshot before the linter rewrites files.
    for (const rel of targets) {
      if (rel === '.') continue;
      try { snapshotFile(ctx.sessionId, path.join(resolved.absolute, rel), 'lint-fix'); } catch { /* best effort */ }
    }
  }

  const outcome = await runProcess(program, programArgs, {
    cwd: resolved.absolute,
    timeoutMs: 90_000,
    signal: ctx.signal,
    sandbox: { workspaceRoot: root, policy: 'workspace-write' as const },
  });

  auditToolCall({
    session: ctx.sessionId ?? 'default',
    tool: 'lint',
    ok: outcome.exitCode === 0,
    durationMs: outcome.durationMs,
    args: `${kind} ${targets.join(' ')}${fix ? ' --fix' : ''}`,
  });

  const fullText = `${outcome.stdout}\n${outcome.stderr}`;
  const issues = kind === 'ruff' ? parseRuffIssues(fullText) : parseJsonIssues(fullText, resolved.absolute);
  if (issues.length === 0) {
    if (outcome.exitCode === 0) {
      return { ok: true, isError: false, text: `> ${kind} ${targets.join(' ')}\nClean — 0 lint issues (${configHint}).` };
    }
    // Linter ran but produced unparsable output — show raw tail.
    return {
      ok: false,
      isError: true,
      text: truncateOutput(`> ${kind} ${targets.join(' ')}\nexit=${outcome.exitCode}\n\n${fullText.trimEnd().split('\n').slice(-25).join('\n')}`),
    };
  }

  const lines: string[] = [`> ${kind} ${targets.join(' ')}${fix ? ' --fix' : ''} — ${issues.length} issue(s):`];
  const byFile = new Map<string, LintIssue[]>();
  for (const issue of issues) {
    const list = byFile.get(issue.file) ?? [];
    list.push(issue);
    byFile.set(issue.file, list);
  }
  for (const [file, fileIssues] of byFile) {
    lines.push(`-- ${file} (${fileIssues.length}) --`);
    for (const issue of fileIssues.slice(0, 20)) {
      lines.push(`  ${issue.line}:${issue.col}  ${issue.severity} ${issue.rule ? `[${issue.rule}] ` : ''}${issue.message}`);
    }
    if (fileIssues.length > 20) lines.push(`  … and ${fileIssues.length - 20} more`);
  }
  lines.push('');
  lines.push('Next: fix the top issues; re-run agent__lint, or agent__verify quick at the end.');
  return { ok: false, isError: true, text: truncateOutput(lines.join('\n')) };
}

export const lintSpec = defineTool({
  def: {
    wireName: 'agent__lint',
    description: 'Run the project\'s own linter (biome/eslint/oxlint/ruff) when configured; fix:true rewrites (vault-snapshotted).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Targets (default ["."]).' },
        fix: { type: 'boolean', description: 'Apply safe fixes (mutation; default false).' },
        cwd: { type: 'string', description: 'Working dir (default workspace root).' },
      },
    },
  },
  handler: lintTool,
  readOnly: false,
  terminal: false,
  category: 'quality',
});
