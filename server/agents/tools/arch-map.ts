/**
 * F4.1 — agent__arch_map: module-level architecture map (fan-in/out,
 * instability, cycles, mermaid) from the deps graph.
 */
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { buildArchMap, renderMermaid, renderText } from '../arch.js';
import { defineTool } from './registry.js';

async function archMapTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const subpathRaw = str(args, 'subpath').trim() || '.';
  const resolved = await resolveWithPermission('arch_map', subpathRaw, ctx);
  const depth = Math.min(Math.max(num(args, 'depth') ?? 2, 1), 6);
  const format = str(args, 'format').trim().toLowerCase() || 'text';
  const focus = str(args, 'focus').trim() || undefined;

  const report = buildArchMap(root, resolved.absolute, depth, focus);
  if (report.modules.length === 0) {
    return { ok: true, isError: false, text: `No modules found under "${subpathRaw}" (no TS/JS import edges).` };
  }

  const header = `# arch_map — ${subpathRaw} (depth ${depth}) · ${report.filesScanned} file(s) · ${report.modules.length} module(s)`;
  let body: string;
  if (format === 'mermaid') {
    body = `${renderText(report).split('\n').slice(0, 6).join('\n')}\n\n${renderMermaid(report, focus)}`;
  } else {
    body = renderText(report);
  }
  return {
    ok: true,
    isError: false,
    text: truncateOutput(`${header}\n\n${body}\n\nNext: define layer rules via agent__arch_rules init, or check existing ones with agent__arch_rules check.`),
  };
}

export const archMapSpec = defineTool({
  def: {
    wireName: 'agent__arch_map',
    description: 'Module-level architecture map: fan-in/out, instability, cycle detection; format text|mermaid.',
    inputSchema: {
      type: 'object',
      properties: {
        subpath: { type: 'string', description: 'Scope directory (default ".").' },
        depth: { type: 'number', description: 'Folder depth per module (default 2, max 6).' },
        format: { type: 'string', enum: ['text', 'mermaid'], description: 'Output format (default "text").' },
        focus: { type: 'string', description: 'Strip this prefix from module ids.' },
      },
    },
  },
  handler: archMapTool,
  readOnly: true,
  category: 'arch',
});
