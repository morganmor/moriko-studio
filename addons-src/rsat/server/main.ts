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

  // R2 — agent tools (readOnly flags feed the loop's parallel planner).
  for (const def of toolDefs) {
    api.tool.register({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      readOnly: def.readOnly === true,
      execute: async (args, toolCtx) => def.execute(args, { ...toolCtx, api }),
    });
  }

  // R3 — scope guard: strict denies on tool.call; advisory notes ride
  // tool.result (the A-19 mutation channel — result text is appendable there).
  on('tool.call', createGuard(api));
  on('tool.result', createGuardResult(api));

  // R5 — fs ledger observer.
  on('fs.change', createLedger(api));

  // R4 — per-session prompt fragment (budgeted, session-scoped).
  api.prompt.fragment(createPromptFragment(api));

  // R6 — RPC surface for the board (actor = user, enforced by the route).
  for (const [name, handler] of Object.entries(rpcHandlers)) {
    api.rpc.handle(name, (body, rpcCtx) => handler(api, rpcCtx?.sessionId ?? body?.sessionId, body));
  }

  // Commands: /rsat opens the board; /rsat-status prints a summary.
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

  // Board activity feed for the Live activity view (RPC "activityFeed").
  api.rpc.handle('activityFeed', () => ({ result: { entries: readActivity(150) } }));

  // TTL reaper: every 5 minutes, claims whose heartbeat window expired (agent
  // truly dead, not just busy) return to Available.
  api.clock.every(300_000, () => {
    void reapStaleClaims(api).catch(() => { /* best-effort */ });
  });

  // Language gate default: unset → the board shows the LangGate (P0a).
  // Council Agent bridge: expose the roster so the Council panel can list the
  // agents a user can dispatch into a council. Lazy + best-effort — Council
  // calls api.use('rsat') at RPC time, so order between the two addons is free.
  try {
    api.api.expose('rsat', {
      listAgents(sessionId) {
        try { return loadAgents(api, sessionId); } catch { return []; }
      },
    });
  } catch { /* mod-api unavailable in older platform — Council degrades to no roster */ }

  api.ui.log('RSA/T addon active — tools registered, guard armed, ledger watching.');
}

export function deactivate() {
  // The platform disposes every registered surface; nothing manual here.
}
