/**
 * Council Agent — server main (v2 activate).
 *
 * Wires: agent tools (council_status / council_broadcast / council_brief),
 * the per-session prompt fragment (council identity + members + shared brief),
 * RPC for the panel UI, the /council command, the council.changed bus topic,
 * and the mod-to-mod surface exposed to RSA/T (roster request + dispatch hop).
 */
import { toolDefs } from './tools.js';
import { createPromptFragment, broadcast } from './sync.js';
import { rpcHandlers } from './rpc.js';
import { getBrief, setBrief } from './store.js';

export async function activate(ctx) {
  const api = ctx.api;
  const on = ctx.on;

  // Agent tools (readOnly flags feed the loop's parallel planner).
  for (const def of toolDefs) {
    api.tool.register({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      readOnly: def.readOnly === true,
      execute: async (args, toolCtx) => def.execute(args, { ...toolCtx, api }),
    });
  }

  // Per-session prompt fragment: council identity + members + brief.
  api.prompt.fragment(createPromptFragment(api));

  // RPC surface for the panel (actor = user, enforced by the route).
  for (const [name, handler] of Object.entries(rpcHandlers)) {
    api.rpc.handle(name, (body, rpcCtx) =>
      handler(api, rpcCtx?.sessionId ?? body?.sessionId, body));
  }

  // /council opens the panel.
  api.command.register({ name: 'council', description: 'Open the Council Agent panel', immediate: true });
  on('command.run', { command: 'council' }, async () => ({
    text: 'Opening the Council panel.',
    openView: 'addon:council/panel',
  }));

  api.ui.log('Council Agent addon active — sub-session grouping, agent tools, prompt fragment wired.');
}

export function deactivate() {
  // The platform disposes every registered surface; nothing manual here.
}
