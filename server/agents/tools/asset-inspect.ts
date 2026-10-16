/**
 * F5.4 — agent__asset_inspect: parse GLB/glTF, PNG/JPEG/WebP/KTX2, WAV with
 * zero dependencies; warn on budget violations; folders get a table.
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, truncateOutput, resolveWithPermission } from './shared.js';
import { inspectAsset, inspectFolder } from '../asset-inspect.js';
import { defineTool } from './registry.js';

async function assetInspectTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const input = str(args, 'path').trim();
  if (!input) return { ok: false, isError: true, text: 'asset_inspect needs a "path" (file or folder).' };
  const resolved = await resolveWithPermission('asset_inspect', input, ctx);

  const budgetBytes = num(args, 'maxBytes') ?? 10_485_760;
  const budgetTexture = num(args, 'maxTexture') ?? 2048;
  const budgetTriangles = num(args, 'maxTriangles') ?? 100_000;

  let stats: import('node:fs').Stats;
  try { stats = statSync(resolved.absolute); } catch {
    return { ok: false, isError: true, text: `Cannot stat: ${resolved.relative}.` };
  }

  const reports = stats.isDirectory()
    ? inspectFolder(resolved.absolute, resolved.relative)
    : [inspectAsset(resolved.absolute, resolved.relative)].filter((r): r is NonNullable<typeof r> => r !== null);

  if (reports.length === 0) {
    return { ok: true, isError: false, text: `No parseable assets found at ${resolved.relative} (supported: glb, gltf, png, jpg, webp, ktx2, wav, ogg, mp3).` };
  }

  for (const r of reports) {
    if (r.bytes > budgetBytes) r.warnings.push(`file ${r.bytes} bytes exceeds byte budget ${budgetBytes}`);
    const dim = r.summary.match(/(\d+)×(\d+)/);
    if (dim) {
      const w = Number(dim[1]);
      const h = Number(dim[2]);
      if (Math.max(w, h) > budgetTexture) r.warnings.push(`texture ${w}×${h} exceeds texture budget ${budgetTexture}`);
    }
    const tris = r.summary.match(/(\d+) tris/);
    if (tris && Number(tris[1]) > budgetTriangles) r.warnings.push(`${tris[1]} triangles exceeds budget ${budgetTriangles}`);
  }

  const totalBytes = reports.reduce((s, r) => s + r.bytes, 0);
  const lines: string[] = [`# asset_inspect — ${resolved.relative} · ${reports.length} asset(s) · ${(totalBytes / 1048576).toFixed(1)} MB total`];
  lines.push('');
  for (const r of reports.slice(0, 60)) {
    lines.push(`${path.extname(r.file) || r.kind}  ${r.file}  (${(r.bytes / 1024).toFixed(1)} KB)  ${r.summary}`);
    for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  }
  if (reports.length > 60) lines.push(`… and ${reports.length - 60} more`);
  const warningCount = reports.reduce((s, r) => s + r.warnings.length, 0);
  lines.push('');
  lines.push(warningCount === 0 ? '✓ within budgets.' : `${warningCount} budget/compat warning(s).`);
  return { ok: warningCount === 0, isError: warningCount > 0, text: truncateOutput(lines.join('\n')) };
}

export const assetInspectSpec = defineTool({
  def: {
    wireName: 'agent__asset_inspect',
    description: 'Parse glTF/GLB/PNG/JPEG/WebP/KTX2/WAV assets: dimensions, triangles, VRAM estimate, budget warnings; folders get a table.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Asset file or folder.' },
        maxBytes: { type: 'number', description: 'Per-file byte budget (default 10 MB).' },
        maxTexture: { type: 'number', description: 'Max texture dimension (default 2048).' },
        maxTriangles: { type: 'number', description: 'Per-model triangle budget (default 100000).' },
      },
      required: ['path'],
    },
  },
  handler: assetInspectTool,
  readOnly: true,
  category: 'game',
});
