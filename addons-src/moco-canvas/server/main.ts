
import { DNA_IDS } from '../client/scene.ts';
import { TEMPLATES } from '../client/templates.ts';
import { toolDef } from './tool.ts';
import { rpcHandlers } from './rpc.ts';
import { listDocs, resolveWorkspace } from './store.ts';


function canvasFragment(api: any) {
  return (ctx: { sessionId?: string }): string[] => {
    let docs: string[] = [];
    try {
      const ws = resolveWorkspace(api, ctx.sessionId);
      docs = listDocs(ws).map((d) => `${d.id} (rev ${d.rev}, ${d.dna})`);
    } catch {
      return [];
    }
    if (docs.length === 0) return [];
    const lines = [
      `Moco Canvas documents in this workspace: ${docs.join(', ')}.`,
      'Design through ops, not pixels: moco_canvas { doc, ops: [...] }. Addresses are grid cells (B2:H5), sizes are spacing tokens ($s1..$s12), colours are scene tokens.',
      'Read the char-map + facts before moving anything; after a batch, read the delta and fix any critical lint (overlap, out-of-bounds).',
      'P4: {op:"responsive", id, bp:"sm"|"md", at/hide/maxWidth/layout} sets per-breakpoint overrides (mobile-first; lg is the base). export {target:"tailwind"} for Tailwind projects. {op:"import", html} perceives foreign HTML read-only.',
      'Constraint (§7.3): {op:"constrain", rule:"same-left"|"same-height"|"same-gap", ids:[...]} keeps a relation across ops — it must ALREADY hold (no solver); ops breaking a stored relation are rejected with the fix. Drop with clear:true.',
    ];
    return lines;
  };
}

export async function activate(ctx: any) {
  const api = ctx.api;
  const on = ctx.on;

  api.tool.register({
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: toolDef.inputSchema,
    readOnly: toolDef.readOnly,
    execute: async (args: Record<string, unknown>, toolCtx: any) =>
      toolDef.execute(args, { ...toolCtx, api }),
  });

  for (const [name, handler] of Object.entries(rpcHandlers)) {
    api.rpc.handle(name, (body: Record<string, unknown>, rpcCtx: any) =>
      handler(api, rpcCtx?.sessionId ?? (body?.sessionId as string | undefined), body));
  }

  api.prompt.fragment({
    id: 'moco-canvas-docs',
    order: 60,
    budgetChars: 900,
    build: canvasFragment(api),
  });

  api.command.register({ name: 'canvas', description: 'Open the Moco Canvas studio', immediate: true });
  on('command.run', { command: 'canvas' }, async () => ({
    text: 'Opening the Moco Canvas studio.',
    openView: 'addon:moco-canvas/canvas',
  }));

  api.bus.subscribe('moco-canvas.commit', async (message: Record<string, unknown>) => {
    api.ui.invalidate('canvas');
    void message;
  });

  api.ui.log(
    `Moco Canvas active — op engine, ${TEMPLATES.length} templates, DNA ${DNA_IDS.join('/')}, persistence in .moriko/moco-canvas/.`,
  );
}

export function deactivate() {}
