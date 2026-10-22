/**
 * Mococraft — server main (v2 activate).
 *
 * Wires:
 *  1. SLOPGATE: on('tool.call') middleware over write tools — scans UI file
 *     content for named AI tells; advisory notes or strict deny.
 *  2. CONTEXT: api.prompt.fragment injects the active Design DNA into every
 *     agent-mode session so agents cannot drift back to defaults.
 *  3. TOOLS: mococraft_scan, mococraft_dna, mococraft_macro dynamic tools.
 *  4. RPC: state / setDna / scanPath / punchlist for the sidebar panel.
 *  5. BUS: mococraft.changed broadcast when DNA or verdicts change.
 */
import { rulesFor, COPY_CLICHES } from './rules.js';
import { DNA_LIB, dnaById } from './dna.js';
import { MACROSTRUCTURES } from './macros.js';
import { scanContent, isUiFile, type ScanReport } from './scan.js';

const WRITE_TOOLS = new Set([
  'agent__edit_file', 'agent__write', 'agent__multi_edit', 'agent__edit_lines',
  'agent__edit_between', 'agent__insert_at_line', 'agent__apply_patch',
]);

/** Which arg of each write tool carries file content. */
function contentOf(tool: string, args: Record<string, unknown>): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const p = typeof args.path === 'string' ? args.path : '';
  if (tool === 'agent__write') {
    if (p && typeof args.content === 'string') out.push({ path: p, content: args.content });
  } else if (tool === 'agent__edit_file' || tool === 'agent__multi_edit') {
    const chunks: string[] = [];
    if (typeof args.new_string === 'string') chunks.push(args.new_string);
    if (Array.isArray(args.edits)) {
      for (const e of args.edits as Array<Record<string, unknown>>) {
        if (typeof e.new_string === 'string') chunks.push(e.new_string);
      }
    }
    if (p && chunks.length > 0) out.push({ path: p, content: chunks.join('\n') });
  } else if (tool === 'agent__edit_lines' || tool === 'agent__edit_between' || tool === 'agent__insert_at_line') {
    if (p && typeof args.new_string === 'string') out.push({ path: p, content: args.new_string });
  } else if (tool === 'agent__apply_patch') {
    if (typeof args.patch === 'string') out.push({ path: '(patch)', content: args.patch });
  }
  return out;
}

/** Last-scan memory per file, for the radar panel. */
const lastScans = new Map<string, ScanReport>();

/**
 * Builds the Design DNA prompt fragment for ONE session at a time (per-turn).
 * api.prompt.fragment expects { id, build }: build() runs on every turn and
 * returns string[] lines (single string lines break the fragment contract).
 */
function dnaFragmentLines(api: Record<string, any>) {
  return (ctx: { workspacePath?: string; sessionId?: string }): string[] => {
    const dnaId = api.store.get('activeDna');
    if (!dnaId) {
      return [
        'Mococraft: no Design DNA locked. If the task involves UI, call mococraft_dna to pick a genre before writing styles.',
        'Never emit Inter-everywhere, purple→blue gradients, gradient headlines, or card-in-card.',
      ];
    }
    const dna = dnaById(dnaId);
    if (!dna) return [];
    return [
      `Mococraft Design DNA locked: ${dna.name} — ${dna.tagline}`,
      `Display font: ${dna.displayFont}. Body font: ${dna.bodyFont}.`,
      `Palette tokens: ${Object.entries(dna.palette).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
      `Macrostructures allowed: ${dna.macrostructures.join(', ')}.`,
      `Hard bans: ${dna.antiTells.join('; ')}.`,
      'Violating these in UI code will be flagged by the Mococraft slop gate.',
    ];
  };
}

export async function activate(ctx: any) {
  const api = ctx.api;
  const on = ctx.on;

  // ── 1. Slop gate ─────────────────────────────────────────────
  on('tool.call', async ($: any, event: any, next: (e: any) => any) => {
    const tool = event?.tool ?? '';
    if (!WRITE_TOOLS.has(tool)) return next(event);
    const chunks = contentOf(tool, event.args ?? {});
    const notes: string[] = [];
    let critical = 0;
    const sensitivity = Number(api.settings.get('radarSensitivity') ?? 2);

    for (const { path, content } of chunks) {
      if (!isUiFile(path) && path !== '(patch)') continue;
      const report = scanContent(path, content, sensitivity);
      lastScans.set(path, report);
      for (const h of report.hits) {
        notes.push(`[${h.rule}] L${h.line}: ${h.label} — ${h.fix}`);
        if (h.severity === 'critical') critical++;
      }
      for (const c of report.copyHits) {
        notes.push(`[copy-cliché] L${c.line}: "${c.phrase}" — replace with concrete, honest microcopy.`);
      }
    }

    if (notes.length > 0) {
      api.bus.publish('mococraft.changed', { kind: 'scan', notes: notes.length });
      const mode = api.settings.get('gateMode') ?? 'advisory';
      if (mode === 'strict' && critical >= sensitivity) {
        return {
          deny: `Mococraft slop gate (strict): ${critical} critical tell(s) in the write. ${notes.slice(0, 6).join(' | ')} Fix the tells and retry — pick from the locked Design DNA, not the default attractor.`,
        };
      }
      // Advisory: let the write through, attach notes via tool.result echo.
      (event as any).__mocoNotes = notes;
    }
    return next(event);
  });

  on('tool.result', async ($: any, event: any) => {
    const notes = (event as any)?.__mocoNotes;
    if (Array.isArray(notes) && notes.length > 0) {
      return { note: `Mococraft advisory: ${notes.slice(0, 8).join(' | ')}` };
    }
    return {};
  });

  // ── 2. Prompt fragment (Design DNA lock) ─────────────────────
  api.prompt.fragment({
    id: 'design-dna',
    order: 40,
    budgetChars: 1200,
    build: dnaFragmentLines(api),
  });

  // ── 3. Dynamic agent tools ───────────────────────────────────
  api.tool.register({
    name: 'mococraft_dna',
    description: 'List the Mococraft Design DNA library and lock one genre for this workspace (OKLCH palette, font pairing, macrostructures, hard bans).',
    inputSchema: { type: 'object', properties: { lock: { type: 'string', enum: DNA_LIB.map((d) => d.id) } } },
    execute: async (args: any) => {
      if (args?.lock) {
        const dna = dnaById(args.lock);
        if (!dna) return { ok: false, error: `Unknown DNA id: ${args.lock}` };
        api.store.set('activeDna', dna.id);
        api.bus.publish('mococraft.changed', { kind: 'dna', dna: dna.id });
        return { ok: true, locked: dna.id, promptNote: `Design DNA locked to ${dna.name}. ${dna.tagline} Palette: ${JSON.stringify(dna.palette)}` };
      }
      return { ok: true, library: DNA_LIB.map((d) => ({ id: d.id, name: d.name, tagline: d.tagline, macrostructures: d.macrostructures })) };
    },
  });

  api.tool.register({
    name: 'mococraft_macro',
    description: 'List asymmetric macrostructures (Split Diptych, Sticky Rail, Spec Sheet…) with ready CSS sketches. Use instead of 3-column grids / symmetric bento.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    execute: async (args: any) => {
      if (args?.id) {
        const m = MACROSTRUCTURES.find((x) => x.id === args.id);
        if (!m) return { ok: false, error: `Unknown macro id: ${args.id}` };
        return { ok: true, ...m };
      }
      return { ok: true, macros: MACROSTRUCTURES.map(({ id, name, sketch }) => ({ id, name, sketch })) };
    },
  });

  api.tool.register({
    name: 'mococraft_scan',
    description: 'Scan one UI file for AI-slop tells and get a punch list (rule, line, why, fix) plus a Slop Index 0-100.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (args: any) => {
      const p = String(args?.path ?? '');
      if (!isUiFile(p)) return { ok: false, error: `Not a UI file: ${p}` };
      let content: string;
      try { content = api.workspace.read(p); } catch { return { ok: false, error: `Cannot read: ${p}` }; }
      const sensitivity = Number(api.settings.get('radarSensitivity') ?? 2);
      const report = scanContent(p, content, sensitivity);
      lastScans.set(p, report);
      api.bus.publish('mococraft.changed', { kind: 'scan', file: p, verdict: report.verdict });
      return { ok: true, ...report };
    },
  });

  // ── 4. RPC for the sidebar panel ─────────────────────────────
  api.rpc.handle('state', () => ({
    activeDna: api.store.get('activeDna') ?? '',
    library: DNA_LIB,
    macros: MACROSTRUCTURES.map(({ id, name, sketch }) => ({ id, name, sketch })),
    scans: [...lastScans.entries()].map(([file, r]) => ({ file, verdict: r.verdict, slopIndex: r.slopIndex, hits: r.hits.length, radar: r.radar })),
    gateMode: api.settings.get('gateMode') ?? 'advisory',
  }));
  api.rpc.handle('setDna', (_sid: string, body: any) => {
    const dna = dnaById(String(body?.id ?? ''));
    if (!dna) return { ok: false, error: 'unknown id' };
    api.store.set('activeDna', dna.id);
    api.bus.publish('mococraft.changed', { kind: 'dna', dna: dna.id });
    return { ok: true };
  });

  api.command.register({ name: 'mococraft', description: 'Open the Mococraft panel', immediate: true });
  on('command.run', { command: 'mococraft' }, async () => ({
    text: 'Opening the Mococraft panel.',
    openView: 'addon:mococraft/panel',
  }));

  // ── 5. Mod API (P3): Moco Canvas consumes the locked DNA + the slop scan ──
  api.api.expose('mococraft', {
    /** Active DNA id ('' when none is locked). */
    activeDna(): string {
      return String(api.store.get('activeDna') ?? '');
    },
    /** Full DNA record (palette is CSS-var keyed: --moco-*, --moco-canvas…). */
    dnaById(id: string) {
      return dnaById(id) ?? null;
    },
    /** Slop scan over compiled code (same engine the write-tool gate uses). */
    scanContent(path: string, content: string, sensitivity?: number) {
      return scanContent(path, content, sensitivity ?? 2);
    },
    isUiFile(path: string): boolean {
      return isUiFile(path);
    },
  });

  api.ui.log('Mococraft active — slop gate (advisory), 4 Design DNA genres, radar ready.');
}

export function deactivate() {
  lastScans.clear();
}
