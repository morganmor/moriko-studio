/**
 * RSA/T addon entry (v2 module — activate(ctx), R0).
 *
 * Wires: 11 agent tools (R2), the scope guard (R3), the fs ledger (R5), the
 * prompt fragment + presence + injection (R4), RPC for the board UI (R6),
 * commands, settings defaults and a README pointer. Everything registers
 * through the platform's disposable surface — reloads never leak.
 */

import { toolDefs } from './tools.js';
import { createGuard, createGuardResult } from './guard.js';
import { createLedger } from './ledger.js';
import { createPromptFragment, broadcast } from './sync.js';
import { rpcHandlers } from './rpc.js';
import { bundle, t } from './i18n.js';
import { loadDoc } from './store.js';
import { readActivity } from './platform.js';
import { loadAgents, reapStaleClaims } from './agents.js';

export async function activate(ctx) {
  const api = ctx.api;
  const on = ctx.on;

  for (const def of toolDefs) {
    api.tool.register({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      readOnly: def.readOnly === true,
      execute: async (args, toolCtx) => def.execute(args, { ...toolCtx, api }),
    });
  }

  on('tool.call', createGuard(api));
  on('tool.result', createGuardResult(api));

  on('fs.change', createLedger(api));

  api.prompt.fragment(createPromptFragment(api));

  for (const [name, handler] of Object.entries(rpcHandlers)) {
    api.rpc.handle(name, (body, rpcCtx) => handler(api, rpcCtx?.sessionId ?? body?.sessionId, body));
  }

  api.command.register({ name: 'rsat', description: 'Open the RSA/T board', immediate: true });
  on('command.run', { command: 'rsat' }, async () => ({ text: 'Opening the RSA/T board.', openView: 'addon:rsat/board' }));
  api.command.register({
    name: 'rsat-status',
    description: 'Print the RSA/T board summary',
    run: async () => {
      const doc = loadDoc(api);
      if (!doc) return { text: 'No PRD yet — create one with the rsat_prd tool.' };
      const { summarize } = await import('./engine.js');
      const s = summarize(doc);
      return { text: `PRD "${s.prd.title}" — ${s.prd.status} · ${s.counts.total} achievements · score ${s.score}/${s.maxScore}` };
    },
  });

  api.rpc.handle('activityFeed', () => ({ result: { entries: readActivity(150) } }));

  api.clock.every(300_000, () => {
    void reapStaleClaims(api).catch(() => {  });
  });

  try {
    api.api.expose('rsat', {
      listAgents(sessionId) {
        try { return loadAgents(api, sessionId); } catch { return []; }
      },
    });
  } catch {  }

  api.ui.log('RSA/T addon active — tools registered, guard armed, ledger watching.');
}

export function deactivate() {
}
