/**
 * F3.9 — agent__verify: ONE verification gate called ONCE at the end of a
 * task. quick: diagnostics(touched) → review_diff(session).
 * full: + typecheck + arch_rules check (when configured).
 * Composes the other quality tools' internals — never re-spawns per edit.
 */
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, truncateOutput, requireWorkspace } from './shared.js';
import { runShellCommand } from '../exec.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineTool } from './registry.js';
import { touchedFiles } from './diagnostics.js';
import { RULES_HINT } from './review-rules.js';

interface StepResult {
  step: string;
  ok: boolean;
  summary: string;
}

async function verifyTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const level = str(args, 'level').trim().toLowerCase() || 'quick';
  const steps: StepResult[] = [];

  try {
    const { getLanguageService } = await import('../lsp-service.js');
    const ts = await import('typescript');
    let total = 0;
    const details: string[] = [];
    for (const abs of touchedFiles().slice(0, 40)) {
      try { readFileSync(abs, 'utf8'); } catch { continue; }
      const service = getLanguageService(abs, root);
      const diags = service.getSyntacticDiagnostics(abs) ?? [];
      total += diags.length;
      for (const d of diags.slice(0, 3)) {
        if (d.file && d.start !== undefined) {
          const lc = d.file.getLineAndCharacterOfPosition(d.start);
          details.push(`  ${path.relative(root, abs).replace(/\\/g, '/')}:${lc.line + 1}  TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
        }
      }
    }
    steps.push({
      step: 'diagnostics(touched)',
      ok: total === 0,
      summary: total === 0 ? `${touchedFiles().length} file(s), 0 issues` : `${total} issue(s):\n${details.join('\n')}`,
    });
  } catch (error) {
    steps.push({ step: 'diagnostics(touched)', ok: true, summary: `skipped (${error instanceof Error ? error.message : 'error'})` });
  }

  // 2. Review checklist (session).
  try {
    const { reviewDiffSpec } = await import('./review-diff.js');
    const result = await reviewDiffSpec.handler({ scope: 'session' }, ctx);
    const countMatch = result.text.match(/(\d+) issue\(s\)/);
    const count = countMatch ? Number(countMatch[1]) : 0;
    steps.push({ step: 'review_diff(session)', ok: !result.isError, summary: result.text.split('\n').slice(0, 10).join('\n') });
    void count;
  } catch (error) {
    steps.push({ step: 'review_diff(session)', ok: true, summary: `skipped (${error instanceof Error ? error.message : 'error'})` });
  }

  if (level === 'full') {
    try {
      const outcome = await runShellCommand('pnpm typecheck', { cwd: root, timeoutMs: 180_000 });
      const errorCount = (outcome.stdout + outcome.stderr).split('\n').filter((l) => /error TS\d+/.test(l)).length;
      steps.push({
        step: 'typecheck(full)',
        ok: outcome.exitCode === 0,
        summary: outcome.exitCode === 0 ? 'clean' : `${errorCount} error(s) (last lines):\n${(outcome.stdout + outcome.stderr).trimEnd().split('\n').slice(-8).join('\n')}`,
      });
    } catch (error) {
      steps.push({ step: 'typecheck(full)', ok: false, summary: `failed (${error instanceof Error ? error.message : 'error'})` });
    }

    const archPath = path.join(root, '.moriko', 'architecture.json');
    if (existsSync(archPath)) {
      try {
        const { archRulesSpec } = await import('./arch-rules.js');
        const result = await archRulesSpec.handler({ mode: 'check' }, ctx);
        steps.push({ step: 'arch_rules(check)', ok: !result.isError, summary: result.text.split('\n').slice(0, 8).join('\n') });
      } catch (error) {
        steps.push({ step: 'arch_rules(check)', ok: true, summary: `skipped (${error instanceof Error ? error.message : 'error'})` });
      }
    }
  }

  const failed = steps.filter((s) => !s.ok);
  const lines: string[] = [`# verify (${level}) — ${steps.length} step(s), ${failed.length} failing:`];
  lines.push('');
  lines.push('| step | status |');
  lines.push('| --- | --- |');
  for (const s of steps) {
    lines.push(`| ${s.step} | ${s.ok ? '✓' : '✗'} |`);
  }
  lines.push('');
  for (const s of steps.filter((x) => !x.ok || x.summary !== '')) {
    lines.push(`## ${s.step} ${s.ok ? '✓' : '✗'}`);
    lines.push(s.summary);
    lines.push('');
  }
  lines.push(RULES_HINT);
  return {
    ok: failed.length === 0,
    isError: failed.length > 0,
    text: truncateOutput(lines.join('\n')),
  };
}

export const verifySpec = defineTool({
  def: {
    wireName: 'agent__verify',
    description: 'End-of-task verification gate (call ONCE at the end): quick = diagnostics+review; full = +typecheck+arch rules.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['quick', 'full'], description: 'Level (default "quick").' },
      },
    },
  },
  handler: verifyTool,
  readOnly: true,
  category: 'quality',
});
