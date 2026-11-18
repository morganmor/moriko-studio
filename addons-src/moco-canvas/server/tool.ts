

import { OP_NAMES, type CanvasOp } from '../client/ops.ts';
import { buildDelta, buildReadout, inspectNode, outline } from '../client/readout.ts';
import { DNA_IDS, type Scene, type Viewport } from '../client/scene.ts';
import { TEMPLATES, templateById } from '../client/templates.ts';
import { importHtml } from './importer.ts';
import {
  DocError,
  commitBatch,
  commitHistory,
  commitNew,
  listDocs,
  readLog,
  readScene,
  replay,
  resolveWorkspace,
  sanitizeDocId,
  type LogEntry,
  type WorkspaceHandle,
} from './store.ts';
import { measureScene, measuredLintBlock } from './measure.ts';
import { regionBegin, regionEnd } from './exporter.ts';

export interface ToolContext {
  workspacePath?: string;
  sessionId?: string;
  api?: any;
}

export interface ToolResult {
  ok: boolean;
  text: string;
  isError: boolean;
}

const OP_ENUM = [...OP_NAMES, 'new', 'inspect', 'outline', 'docs', 'undo', 'redo', 'export', 'import'];

const SCHEMA = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: 'Document id (letters/digits/dash), e.g. "landing".' },
    op: {
      type: 'string',
      enum: OP_ENUM,
      description: 'Single op. Ignored when ops[] is present.',
    },
    ops: {
      type: 'array',
      description: 'Batch of ops — ONE transaction: all apply or none.',
      items: { type: 'object' },
    },
    dryRun: { type: 'boolean', description: 'Predict the result without saving.' },
    viewport: { type: 'string', enum: ['sm', 'md', 'lg'], description: 'Readout breakpoint (default lg).' },
    focus: { type: 'string', description: 'inspect: node id. inspect without id returns the outline.' },
    template: { type: 'string', enum: TEMPLATES.map((t) => t.id), description: 'new: starting template.' },
    dna: { type: 'string', enum: DNA_IDS, description: 'new: token set.' },
    reset: { type: 'boolean', description: 'new: overwrite an existing document.' },
    target: { type: 'string', enum: ['html', 'css', 'react', 'tailwind'], description: 'export: what to return. tailwind = JSX with utility classes (P4, for Tailwind projects).' },
    measure: {
      type: 'boolean',
      description: 'P2: measure the compiled scene in the headless browser (3 viewports) and return the MEASURED lint (tier:runtime). Default true when a browser is available; degrades to tier:intent honestly.',
    },
    id: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } },
    in: { type: 'string' },
    at: { type: 'string' },
    kind: { type: 'string' },
    role: { type: 'string' },
    text: { type: 'string' },
    edge: { type: 'string' },
    to: { type: 'string' },
    axis: { type: 'string' },
    between: { type: 'array', items: { type: 'string' } },
    gap: { type: 'string' },
    cols: { type: 'number' },
    rows: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    force: { type: 'boolean' },
    bp: { type: 'string', enum: ['sm', 'md', 'lg'], description: 'responsive: target breakpoint (lg clears the md key — lg IS the base).' },
    hide: { type: 'boolean', description: 'responsive: drop the node at bp.' },
    clear: { type: 'boolean', description: 'responsive/constrain: remove ALL node overrides / drop the constraint.' },
    rule: { type: 'string', enum: ['same-left', 'same-height', 'same-gap'], description: 'constrain: relation to keep across ops (plan §7.3) — must already hold; there is no solver.' },
    html: { type: 'string', description: 'import: standalone HTML to perceive as a read-only scene (plan §8.4).' },
  },
  required: ['doc'],
};

const CONVENIENCE_KEYS = [
  'id', 'ids', 'in', 'at', 'kind', 'role', 'text', 'edge', 'to', 'axis', 'between',
  'gap', 'cols', 'rows', 'w', 'h', 'force', 'before', 'after', 'index', 'parent',
  'dir', 'pad', 'align', 'justify', 'wrap', 'color', 'bg', 'radius', 'border',
  'weight', 'maxWidth', 'ratio', 'fit', 'layout', 'style', 'a', 'b', 'c1', 'r1', 'c2', 'r2',
  'bp', 'hide', 'clear', 'rule',
];

function toOp(args: Record<string, unknown>): CanvasOp {
  const op: Record<string, unknown> = { op: args.op };
  for (const key of CONVENIENCE_KEYS) {
    if (args[key] !== undefined) op[key] = args[key];
  }
  return op as unknown as CanvasOp;
}

function describeDocs(ws: WorkspaceHandle): string {
  const docs = listDocs(ws);
  if (docs.length === 0) return 'no documents yet — create one with {op:"new", doc:"landing"}.';
  return docs.map((d) => `  ${d.id} · rev ${d.rev} · dna ${d.dna} · template ${d.template} · ${d.ops} log`).join('\n');
}

function loadDoc(ws: WorkspaceHandle, doc: string): { scene: Scene; entries: LogEntry[] } | null {
  const entries = readLog(ws, doc);
  const scene = readScene(ws, doc) ?? (entries.length ? replay(entries, doc).scene : null);
  return scene ? { scene, entries } : null;
}

function requireDoc(ws: WorkspaceHandle, doc: string): { scene: Scene; entries: LogEntry[] } {
  const loaded = loadDoc(ws, doc);
  if (loaded) return loaded;
  const docs = listDocs(ws).map((d) => d.id);
  throw new DocError(
    `document "${doc}" does not exist yet.${docs.length ? ` Available: ${docs.join(', ')}.` : ''} Create it first: {op:"new", doc:"${doc}"}.`,
  );
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 60)}\n… (clipped at ${limit} characters — use inspect for details)`;
}

export async function runMocoCanvas(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const api = ctx.api;
  try {
    const ws = resolveWorkspace(api, ctx.sessionId);
    const docId = args.doc ? sanitizeDocId(String(args.doc)) : '';
    if (!docId) throw new DocError('the "doc" parameter is required (e.g. "landing").');
    const actor = 'agent' as const;
    const viewport = (typeof args.viewport === 'string' ? args.viewport : 'lg') as Viewport;
    const dryRun = args.dryRun === true;
    const wantMeasure = args.measure !== false;

    if (args.op === 'new') {
      const template = typeof args.template === 'string' ? args.template : 'split-diptych';
      if (!templateById(template)) {
        throw new DocError(`template "${template}" does not exist. Options: ${TEMPLATES.map((t) => t.id).join(', ')}.`);
      }
      const dna = typeof args.dna === 'string'
        ? args.dna
        : (await import('./craft.ts')).craftDna(api)?.id ?? 'editorial';
      const existing = loadDoc(ws, docId);
      if (existing && args.reset !== true) {
        const readout = buildReadout(existing.scene, viewport);
        return {
          ok: true,
          isError: false,
          text: `document "${docId}" already exists (rev ${existing.scene.rev}) — not overwritten.\n\n${clip(readout.text, 1800)}`,
        };
      }
      const created = await commitNew(ws, docId, template, dna, actor);
      const readout = buildReadout(created.scene, viewport);
      const measured = wantMeasure ? await measureScene(created.scene, api, { sessionId: ctx.sessionId }) : null;
      return {
        ok: true,
        isError: false,
        text: [
          `created ${docId} from "${template}" · dna ${dna} · rev ${created.scene.rev}`,
          `saved to ${'.moriko/moco-canvas'}/${docId}.scene.json`,
          '',
          measured ? measuredLintBlock(measured) : '',
          clip(readout.text, 1800),
        ].filter(Boolean).join('\n'),
      };
    }

    if (args.op === 'docs') {
      return { ok: true, isError: false, text: `DOCUMENTS\n${describeDocs(ws)}` };
    }

    if (args.op === 'inspect' || args.op === 'outline') {
      const { scene } = requireDoc(ws, docId);
      if (args.op === 'outline' || typeof args.focus !== 'string') {
        const tree = outline(scene);
        const readout = buildReadout(scene, viewport);
        return { ok: true, isError: false, text: `${clip(tree, 1400)}\n\n${clip(readout.text, 1600)}` };
      }
      const detail = inspectNode(scene, args.focus);
      const readout = buildReadout(scene, viewport, args.focus);
      return { ok: true, isError: false, text: `${detail}\n\n${clip(readout.text, 1200)}` };
    }

    if (args.op === 'export') {
      const { scene } = requireDoc(ws, docId);
      const { compileScene } = await import('../client/compile.ts');
      const compiled = compileScene(scene);
      const target = args.target === 'css' ? 'css' : args.target === 'react' ? 'react' : args.target === 'tailwind' ? 'tailwind' : 'html';

      if (target === 'tailwind') {
        const { compileTailwind } = await import('./exporter.ts');
        const out = compileTailwind(scene);
        const text = out.regions
          .map((r) => `${regionBegin(docId, r.region, scene.rev)}\n${r.code}\n${regionEnd(docId, r.region)}`)
          .join('\n\n');
        return {
          ok: true,
          isError: false,
          text: `EXPORT ${docId} rev ${scene.rev} · tailwind · ${out.regions.length} region(s)\n\nSETUP\n${out.notes.map((n) => `- ${n}`).join('\n')}\n\n${clip(text, 6000)}`,
        };
      }

      if (target === 'react') {
        const { compileReact } = await import('./exporter.ts');
        const out = compileReact(scene, compiled.css);
        const text = out.regions
          .map((r) => `${regionBegin(docId, r.region, scene.rev)}\n${r.code}\n${regionEnd(docId, r.region)}`)
          .join('\n\n');
        return {
          ok: true,
          isError: false,
          text: `EXPORT ${docId} rev ${scene.rev} · react · ${out.regions.length} region(s)\n\n${clip(text, 6000)}\n\nCSS (${compiled.css.length} ch) is separate — export { target: "css" } for it.`,
        };
      }

      const body = target === 'css' ? compiled.css : compiled.html;

      const { scanForExport } = await import('./craft.ts');
      const scan = scanForExport(api, `${docId}.${target === 'css' ? 'css' : 'tsx'}`, body);
      const scanLines = scan.ran
        ? [`slop scan: index ${scan.slopIndex} (${scan.verdict}), ${scan.notes.length} note(s)`, ...scan.notes.slice(0, 5)]
        : scan.notes;

      return {
        ok: true,
        isError: false,
        text: [
          `EXPORT ${docId} rev ${scene.rev} · ${target} · ${body.length} characters`,
          ...scanLines,
          '',
          clip(body, 6000),
        ].join('\n'),
      };
    }

    if (args.op === 'import') {
      const html = typeof args.html === 'string' ? args.html : '';
      if (!html.trim()) throw new DocError('import requires "html" — the standalone HTML to perceive (read-only; use measure/runtime tools to edit foreign code).');
      const { scene } = requireDoc(ws, docId);
      const perception = importHtml(scene, html);
      return { ok: true, isError: false, text: perception };
    }

    if (args.op === 'undo' || args.op === 'redo') {
      const before = requireDoc(ws, docId);
      if (dryRun) {
        const predicted = replay([...before.entries, { rev: before.scene.rev, at: new Date().toISOString(), actor, kind: args.op }], docId);
        return { ok: true, isError: false, text: `dryRun ${args.op} → rev ${predicted.scene.rev}` };
      }
      const result = await commitHistory(ws, docId, args.op, actor);
      const readout = buildReadout(result.scene, viewport);
      return {
        ok: result.ok,
        isError: !result.ok,
        text: `${result.note}\n\n${clip(readout.text, 1400)}`,
      };
    }

    const ops: CanvasOp[] = Array.isArray(args.ops)
      ? (args.ops as CanvasOp[])
      : args.op
        ? [toOp(args)]
        : [];
    if (ops.length === 0) {
      throw new DocError(`no ops. Send "op" (${OP_NAMES.join(', ')}) or "ops": [...].`);
    }

    const loaded = requireDoc(ws, docId);
    if (dryRun) {
      const outcome = (await import('../client/ops.ts')).applyBatch(loaded.scene, ops);
      if (!outcome.ok) return { ok: false, isError: true, text: `dryRun rejected: ${outcome.rejected?.note ?? 'batch failed'}` };
      const delta = buildDelta({ notes: outcome.notes, changed: outcome.changed, before: loaded.scene, after: outcome.scene }, viewport);
      return { ok: true, isError: false, text: `DRY RUN (not saved)\n${delta}` };
    }

    const committed = await commitBatch(ws, docId, ops, actor);
    if (!committed.outcome.ok) {
      return { ok: false, isError: true, text: `rejected: ${committed.outcome.rejected?.note ?? 'batch failed'}` };
    }
    void api?.bus?.publish?.('moco-canvas.commit', { doc: docId, rev: committed.scene.rev, actor, ops: ops.length });
    const delta = buildDelta(
      { notes: committed.outcome.notes, changed: committed.outcome.changed, before: loaded.scene, after: committed.scene },
      viewport,
    );
    const critical = committed.scene ? buildReadout(committed.scene, viewport).lint.filter((l) => l.severity === 'critical') : [];
    const footer = critical.length
      ? `\n\n⛔ ${critical.length} lint critical: ${critical.slice(0, 3).map((l) => `${l.rule} (${l.node ?? '—'})`).join(', ')}`
      : '\n\n✓ 0 lint critical';
    const measured = wantMeasure ? await measureScene(committed.scene, api, { viewport, sessionId: ctx.sessionId }) : null;
    const measuredText = measured ? `\n\nMEASURED\n${measuredLintBlock(measured)}` : '';
    return { ok: true, isError: false, text: `${delta}${footer}${measuredText}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, isError: true, text: `moco_canvas: ${message}` };
  }
}

export const toolDef = {
  name: 'moco_canvas',
  description:
    'Design in 2D through a scene graph instead of guessing pixels. Ops in grid addresses (B2:H5), spacing tokens, and roles; returns a char-map + relational facts + lint delta. Ops: new, inspect, outline, docs, place, move, resize, align, distribute, space, stack, grid, group, ungroup, style, text, swap, delete, reorder, responsive, constrain, undo, redo, export, import.',
  inputSchema: SCHEMA,
  readOnly: false,
  execute: runMocoCanvas,
};
