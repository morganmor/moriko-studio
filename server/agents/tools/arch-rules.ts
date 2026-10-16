/**
 * F4.2 — agent__arch_rules: init (propose .moriko/architecture.json from the
 * arch map) and check (report layer/cycle/size violations).
 */
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, bool, truncateOutput, requireWorkspace } from './shared.js';
import { buildArchMap, checkRules, loadArchitectureRules, type ArchitectureRules } from '../arch.js';
import { defineTool } from './registry.js';

async function archRulesTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const mode = str(args, 'mode').trim().toLowerCase() || 'check';
  const dryRun = args.dryRun === undefined ? true : bool(args, 'dryRun');

  if (mode === 'init') {
    const report = buildArchMap(root, root, 1);
    const topDirs = new Set<string>(report.modules.map((m) => m.id.split('/')[0]).filter(Boolean));
    topDirs.delete('.moriko');
    const proposed: ArchitectureRules = {
      layers: [...topDirs].slice(0, 12).map((dir) => ({ name: dir, paths: [`${dir}/**`] })),
      allow: {},
      forbid: [],
      maxFileLines: 1200,
      noCycles: true,
    };
    const rel = path.join('.moriko', 'architecture.json');
    const abs = path.join(root, rel);
    const json = `${JSON.stringify(proposed, null, 2)}\n`;
    if (dryRun) {
      return {
        ok: true,
        isError: false,
        text: truncateOutput(`Proposed ${rel} (dry run — pass dryRun:false to write):\n\n\`\`\`json\n${json}\`\`\`\n\nEdit the "allow" map to encode your layer direction before applying.`),
      };
    }
    if (existsSync(abs)) {
      return { ok: false, isError: true, text: `${rel} already exists — edit it instead of re-initializing.` };
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, json);
    return { ok: true, isError: false, text: `Written ${rel} with ${proposed.layers.length} layer(s). Edit the allow/forbid rules, then run agent__arch_rules check.` };
  }

  if (mode === 'check') {
    const rules = loadArchitectureRules(root);
    if (!rules) {
      return { ok: true, isError: false, text: 'No .moriko/architecture.json — run agent__arch_rules init first (or skip rule checking).' };
    }
    const violations = checkRules(root, rules);
    if (violations.length === 0) {
      return { ok: true, isError: false, text: '✓ 0 architecture violations (layer edges, cycles, file sizes all pass).' };
    }
    const lines: string[] = [`✗ ${violations.length} violation(s):`];
    for (const v of violations.slice(0, 40)) {
      lines.push(`  [${v.kind}] ${v.detail}`);
    }
    if (violations.length > 40) lines.push(`  … and ${violations.length - 40} more`);
    return { ok: false, isError: true, text: truncateOutput(lines.join('\n')) };
  }

  return { ok: false, isError: true, text: 'Unknown mode. Available: init (dryRun default true), check.' };
}

export const archRulesSpec = defineTool({
  def: {
    wireName: 'agent__arch_rules',
    description: 'Layer rules: init proposes .moriko/architecture.json from the arch map (dryRun default); check reports violations.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['init', 'check'], description: 'Mode (default "check").' },
        dryRun: { type: 'boolean', description: 'init: preview only (default true).' },
      },
    },
  },
  handler: archRulesTool,
  readOnly: false,
  category: 'arch',
});
