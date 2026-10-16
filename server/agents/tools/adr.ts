/**
 * F4.3 — agent__adr: lightweight Architecture Decision Records in
 * docs/adr/NNNN-slug.md (Context / Decision / Consequences / Alternatives /
 * Status). Modes: new, list, read, supersede.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, truncateOutput, requireWorkspace } from './shared.js';
import { defineTool } from './registry.js';

const padNum = (n: number): string => String(n).padStart(4, '0');

async function adrTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const mode = str(args, 'mode').trim().toLowerCase() || 'list';
  const dir = path.join(root, 'docs', 'adr');

  if (mode === 'list') {
    if (!existsSync(dir)) return { ok: true, isError: false, text: 'No ADR directory (docs/adr) yet. Create the first with agent__adr new.' };
    const files = readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
    if (files.length === 0) return { ok: true, isError: false, text: 'docs/adr is empty.' };
    const lines: string[] = [`ADR records (${files.length}):`];
    for (const f of files) {
      try {
        const first = readFileSync(path.join(dir, f), 'utf8').split('\n')[0] ?? '';
        const status = readFileSync(path.join(dir, f), 'utf8').match(/\*\*Status\*\*:\s*(.+)/)?.[1]?.trim() ?? '?';
        lines.push(`  ${f}  ${first.replace(/^#\s*/, '')}  [${status}]`);
      } catch {
        lines.push(`  ${f}`);
      }
    }
    return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
  }

  if (mode === 'read') {
    const id = str(args, 'id').trim();
    if (!id) return { ok: false, isError: true, text: 'read needs "id" (e.g. "0003" or the file name).' };
    const file = readdirSync(existsSync(dir) ? dir : root).find((f) => f.startsWith(id) && f.endsWith('.md'));
    if (!file) return { ok: false, isError: true, text: `No ADR starting with "${id}".` };
    return { ok: true, isError: false, text: truncateOutput(readFileSync(path.join(dir, file), 'utf8')) };
  }

  if (mode === 'new') {
    const title = str(args, 'title').trim();
    if (!title) return { ok: false, isError: true, text: 'new needs "title" (plus optional context/decision/consequences/alternatives).' };
    mkdirSync(dir, { recursive: true });
    const existing = readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f));
    const nextN = existing.length > 0 ? Math.max(...existing.map((f) => Number(f.slice(0, 4)))) + 1 : 1;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const fileName = `${padNum(nextN)}-${slug}.md`;
    const body: Record<string, string> = {};
    for (const key of ['context', 'decision', 'consequences', 'alternatives', 'status']) {
      const v = str(args, key).trim();
      if (v) body[key] = v;
    }
    const content = `# ${padNum(nextN)}. ${title}

- **Status**: ${body.status ?? 'Accepted'}
- **Date**: ${new Date().toISOString().slice(0, 10)}

## Context
${body.context ?? '(n/a)'}

## Decision
${body.decision ?? '(n/a)'}

## Consequences
${body.consequences ?? '(n/a)'}

## Alternatives
${body.alternatives ?? '(n/a)'}
`;
    writeFileSync(path.join(dir, fileName), content);
    return { ok: true, isError: false, text: `ADR written: docs/adr/${fileName}` };
  }

  if (mode === 'supersede') {
    const id = str(args, 'id').trim();
    const by = str(args, 'by').trim();
    if (!id || !by) return { ok: false, isError: true, text: 'supersede needs "id" and "by" (the new ADR number).' };
    if (!existsSync(dir)) return { ok: false, isError: true, text: 'No docs/adr directory.' };
    const file = readdirSync(dir).find((f) => f.startsWith(id) && f.endsWith('.md'));
    if (!file) return { ok: false, isError: true, text: `No ADR starting with "${id}".` };
    const abs = path.join(dir, file);
    const content = readFileSync(abs, 'utf8').replace(/(\*\*Status\*\*:.*)/, `$1 — superseded by ${by}`);
    writeFileSync(abs, content);
    return { ok: true, isError: false, text: `docs/adr/${file} marked superseded by ${by}.` };
  }

  return { ok: false, isError: true, text: 'Unknown mode. Available: new, list, read, supersede.' };
}

export const adrSpec = defineTool({
  def: {
    wireName: 'agent__adr',
    description: 'Architecture Decision Records (docs/adr): new, list, read, supersede.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['new', 'list', 'read', 'supersede'], description: 'Mode (default "list").' },
        id: { type: 'string', description: 'ADR number (read / supersede).' },
        title: { type: 'string', description: 'Title (new).' },
        context: { type: 'string', description: 'Context section (new).' },
        decision: { type: 'string', description: 'Decision section (new).' },
        consequences: { type: 'string', description: 'Consequences (new).' },
        alternatives: { type: 'string', description: 'Alternatives (new).' },
        by: { type: 'string', description: 'Superseding ADR id (supersede).' },
      },
    },
  },
  handler: adrTool,
  readOnly: false,
  category: 'arch',
});
