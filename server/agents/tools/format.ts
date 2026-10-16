/**
 * F3.4 — agent__format: run the PROJECT's own formatter (prettier / biome /
 * ruff format) when configured. MUTATION: vault snapshot per file before write.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { runProcess } from '../exec.js';
import { auditToolCall } from '../audit.js';
import { snapshotFile } from '../vault.js';
import { defineTool } from './registry.js';

type FormatterKind = 'prettier' | 'biome' | 'ruff' | 'none';

function detectFormatter(cwd: string): FormatterKind {
  if (existsSync(path.join(cwd, 'biome.json')) || existsSync(path.join(cwd, 'biome.jsonc'))) return 'biome';
  const prettierCfg = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', 'prettier.config.mjs', '.prettierrc.yml'].find((f) => existsSync(path.join(cwd, f)));
  if (prettierCfg) return 'prettier';
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    if (pkg.devDependencies?.['prettier'] || Object.values(pkg.scripts ?? {}).some((s) => s.includes('prettier'))) return 'prettier';
    if (pkg.devDependencies?.['@biomejs/biome']) return 'biome';
  } catch {  }
  if (existsSync(path.join(cwd, 'ruff.toml')) || existsSync(path.join(cwd, '.ruff.toml'))) return 'ruff';
  try {
    const pyproject = readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');
    if (pyproject.includes('[tool.ruff]')) return 'ruff';
  } catch {  }
  return 'none';
}

async function formatTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return { ok: false, isError: true, text: 'Terminal execution is turned OFF in the harness settings. Ask the user to enable it (Tools → Terminal: Ask or Auto) to run the project formatter.' };
  }
  const { root } = requireWorkspace(ctx);
  const cwdRaw = str(args, 'cwd').trim() || '.';
  const resolved = await resolveWithPermission('format', cwdRaw, ctx);
  const kind = detectFormatter(resolved.absolute);
  if (kind === 'none') {
    return {
      ok: true,
      isError: false,
      text: 'No formatter configured (no prettier/biome config, no ruff.toml). Nothing installed — add a formatter config to enable agent__format.',
    };
  }

  const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  const targets = rawPaths.length > 0 ? rawPaths : ['.'];

  for (const rel of targets) {
    if (rel === '.') continue;
    try {
      const abs = path.join(resolved.absolute, rel);
      if (statSync(abs).isFile()) snapshotFile(ctx.sessionId, abs, 'format');
    } catch {  }
  }

  const before = new Map<string, number>();
  for (const rel of targets) {
    if (rel === '.') continue;
    try {
      const abs = path.join(resolved.absolute, rel);
      if (statSync(abs).isFile()) before.set(rel, statSync(abs).size);
    } catch {  }
  }

  let program: string;
  let programArgs: string[];
  if (kind === 'prettier') {
    program = 'npx.cmd';
    programArgs = ['prettier', '--write', ...targets];
  } else if (kind === 'biome') {
    program = 'npx.cmd';
    programArgs = ['biome', 'format', '--write', ...targets];
  } else {
    program = 'python';
    programArgs = ['-m', 'ruff', 'format', ...targets];
  }

  const outcome = await runProcess(program, programArgs, {
    cwd: resolved.absolute,
    timeoutMs: 90_000,
    signal: ctx.signal,
    sandbox: { workspaceRoot: root, policy: 'workspace-write' as const },
  });

  auditToolCall({
    session: ctx.sessionId ?? 'default',
    tool: 'format',
    ok: outcome.exitCode === 0,
    durationMs: outcome.durationMs,
    args: `${kind} ${targets.join(' ')}`,
  });

  if (outcome.exitCode !== 0) {
    return { ok: false, isError: true, text: truncateOutput(`> ${kind} format ${targets.join(' ')}\nexit=${outcome.exitCode}\n\n${(`${outcome.stdout}\n${outcome.stderr}`).trimEnd().split('\n').slice(-25).join('\n')}`) };
  }

  const changed: string[] = [];
  for (const [rel, size] of before) {
    try {
      const now = statSync(path.join(resolved.absolute, rel)).size;
      if (now !== size) changed.push(rel);
    } catch {  }
  }
  return {
    ok: true,
    isError: false,
    text: truncateOutput(`> ${kind} format ${targets.join(' ')} — done.\nChanged size: ${changed.length > 0 ? changed.join(', ') : '(no tracked size change; formatter may have rewritten files in place)'}\nVault snapshots taken before writes; agent__undo can restore.`),
  };
}

export const formatSpec = defineTool({
  def: {
    wireName: 'agent__format',
    description: 'Run the project\'s formatter (prettier/biome/ruff) when configured; vault-snapshots files before rewriting.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Targets (default ["."]).' },
        cwd: { type: 'string', description: 'Working dir (default workspace root).' },
      },
    },
  },
  handler: formatTool,
  readOnly: false,
  terminal: false,
  category: 'quality',
});
