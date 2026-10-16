/**
 * RSA/T agent tools (R2) — eleven focused tools. All receive the full tool
 * ctx (A-01 fix): sessionId + actor ride into the engine, so claims and
 * heartbeats are attributed correctly.
 *
 * Guardrails enforced HERE and in engine.ts (not just documented):
 *  - no delete tool for agents (P3), no Start (P6.4)
 *  - every mutating response suggests the next step
 */

import { loadDoc } from './store.js';
import { agentActor, userActor } from './platform.js';
import * as engine from './engine.js';
import { broadcast } from './sync.js';

const ok = (text) => ({ ok: true, isError: false, text });
const fail = (text) => ({ ok: false, isError: true, text });

/** Wrap an engine call: map errors to readable tool results + auto-heartbeat. */
async function run(fn, ctx) {
  try {
    const result = await fn();
    if (ctx?.api && ctx?.sessionId) {
      void engine.autoHeartbeat(ctx.api, ctx.sessionId, { kind: 'agent', sessionId: ctx.sessionId }).catch(() => {});
    }
    return result;
  } catch (error) {
    if (error?.name === 'StoreLockedError' || error?.constructor?.name === 'StoreLockedError') {
      return fail(`${error.message}`);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function requireCtx(ctx) {
  if (!ctx?.sessionId) return fail('No session — this tool needs an agent session with a bound workspace.');
  return null;
}

export const toolDefs = [
  {
    name: 'rsat_status',
    description: 'RSA/T: PRD summary + achievement list (id, title, state, holder, acceptance progress). Read this before picking work.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const api = ctx.api;
      const doc = loadDoc(api, ctx.sessionId);
      if (!doc) return fail('No PRD yet. Create one with rsat_prd (action "create") after asking the user for goals.');
      const s = engine.summarize(doc);
      const lines = [
        `PRD "${s.prd.title}" [${s.prd.id}] — status: ${s.prd.status} · language: ${s.prd.language} · score ${s.score}/${s.maxScore}`,
        '',
        ...s.achievements.map((a) => {
          const raw = doc.achievements.find((x) => x.id === a.id);
          const eff = engine.effOf(doc, raw);
          const stale = eff !== a.state && (a.state === 'locked' || a.state === 'available');
          return `- ${a.id} "${a.title}" [${eff}]${stale ? ` (stored state "${a.state}" is stale — deps already done)` : ''} tier=${a.tier} pts=${a.points}${a.holder ? ` held by ${a.holder}` : ''} acceptance=${a.acceptance}`;
        }),
        '',
        doc.prd.status === 'running'
          ? 'Next: rsat_claim an AVAILABLE achievement whose dependencies are done, then work strictly inside its scope.'
          : 'The PRD is not running — the user must press Start on the board (agents cannot).',
      ];
      return ok(lines.join('\n'));
    }, ctx),
  },
  {
    name: 'rsat_get',
    description: 'RSA/T: one achievement in full — description, technical, acceptance, scope, comments, ledger files.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Achievement id, e.g. "A-003".' } },
      required: ['id'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const api = ctx.api;
      const doc = loadDoc(api, ctx.sessionId);
      if (!doc) return fail('No PRD yet.');
      const a = doc.achievements.find((x) => x.id === args.id);
      if (!a) return fail(`Achievement "${args.id}" not found.`);
      const { readLedger } = await import('./store.js');
      const ledger = readLedger(api, ctx.sessionId, a.id).slice(-20);
      const lines = [
        `${a.id} "${a.title}" — ${engine.effOf(doc, a)} · ${a.kind} · ${a.tier} (+${a.points ?? '?'} pts)`,
        a.description || '(no description)',
        a.technical ? `Technical: ${a.technical}` : '',
        '',
        'Acceptance:',
        ...(a.acceptance || []).map((b) => `  [${b.done ? 'x' : ' '}] ${b.id}: ${b.text}`),
        '',
        `Scope: include ${(a.scope?.include || []).join(', ') || '-'} · exclude ${(a.scope?.exclude || []).join(', ') || '-'} · maxFiles ${a.scope?.maxFiles ?? '?'}`,
        a.claim ? `Held by ${a.claim.label} since ${a.claim.at}` : 'Unclaimed.',
        a.dependsOn?.length ? `Depends on: ${a.dependsOn.join(', ')}` : '',
        a.comments?.length ? `Comments:\n${a.comments.map((c) => `  ${c.by?.name ?? c.by?.kind}: ${c.text}`).join('\n')}` : '',
        ledger.length ? `Ledger (last ${ledger.length}):\n${ledger.map((l) => `  ${l.summary}`).join('\n')}` : '',
      ].filter(Boolean);
      return ok(lines.join('\n'));
    }, ctx),
  },
  {
    name: 'rsat_prd',
    description: 'RSA/T: create/update/comment the PRD. Agents cannot start or finish it (user-only) and cannot delete it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'comment'], description: 'PRD operation.' },
        title: { type: 'string' }, summary: { type: 'string' },
        goals: { type: 'array', items: { type: 'string' } },
        nonGoals: { type: 'array', items: { type: 'string' } },
        globalScope: { type: 'object', description: '{ include: string[], exclude: string[] } globs.' },
        architecture: { type: 'string', description: 'High-level system architecture description.' },
        modules: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] }, description: 'Architecture modules: string or {name, desc, scope}. Each achievement can set moduleId to join one.' },
        milestones: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] }, description: 'Delivery checkpoints: string or {title, goal}. Achievements can dependsOn a milestone id (M-01…).' },
        nonFunctional: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] }, description: 'Non-functional requirements: string or {text, metric}.' },
        risks: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] }, description: 'Risks: string or {text, mitigation, severity}.' },
        technicalDecisions: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] }, description: 'Key technical decisions: string or {text, reason}.' },
        text: { type: 'string', description: 'comment action: the comment text.' },
        kind: { type: 'string', enum: ['note', 'question', 'decision', 'scope_change'] },
      },
      required: ['action'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const api = ctx.api;
      const actor = agentActor(ctx);
      if (args.action === 'create') {
        await engine.createPrd(api, ctx.sessionId, actor, args);
        return ok('PRD created (status: draft). The user reviews it on the board and presses Start — then claim work with rsat_claim.');
      }
      if (args.action === 'update') {
        await engine.updatePrd(api, ctx.sessionId, actor, args);
        return ok('PRD updated.');
      }
      if (args.action === 'comment') {
        if (!args.text) return fail('comment needs text.');
        await engine.commentPrd(api, ctx.sessionId, actor, args.text, args.kind);
        return ok('Comment added to the PRD.');
      }
      return fail(`Unknown action "${args.action}".`);
    }, ctx),
  },
  {
    name: 'rsat_achievement',
    description: 'RSA/T: create/update an achievement, mark an acceptance box, comment, or drop it. No hard delete — that is user-only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'mark_acceptance', 'comment', 'drop'], description: 'Achievement operation.' },
        id: { type: 'string', description: 'Achievement id (not needed for create).' },
        title: { type: 'string' }, description: { type: 'string' }, technical: { type: 'string' },
        tier: { type: 'string', enum: ['bronze', 'silver', 'gold', 'diamond'] },
        kind: { type: 'string', enum: ['feature', 'bugfix', 'refactor', 'chore', 'research', 'test'] },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'create: acceptance criteria texts.' },
        scope: { type: 'object', description: '{ include: string[], exclude: string[], maxFiles?: number, allowCreate?: boolean, allowDelete?: boolean }.' },
        dependsOn: { type: 'array', items: { type: 'string' } },
        moduleId: { type: 'string', description: 'Architecture module id this achievement belongs to (from the PRD modules).' },
        milestoneId: { type: 'string', description: 'Milestone id this achievement delivers.' },
        contracts: { type: 'object', description: '{ provides: string[], consumes: string[] } symbol contracts for Interlinked.' },
        tags: { type: 'array', items: { type: 'string' } },
        acceptanceId: { type: 'string', description: 'mark_acceptance: which box (ac1, ac2…).' },
        done: { type: 'boolean', description: 'mark_acceptance: check/uncheck.' },
        text: { type: 'string', description: 'comment: text · drop: reason.' },
        reason: { type: 'string', description: 'drop: required reason.' },
      },
      required: ['action'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const api = ctx.api;
      const actor = agentActor(ctx);
      switch (args.action) {
        case 'create': {
          const doc = await engine.createAchievement(api, ctx.sessionId, actor, args);
          const created = doc.achievements[doc.achievements.length - 1];
          return ok(`Created ${created.id} "${created.title}" (${created.tier}, +${created.points} pts, state ${created.state}). Next: rsat_get ${created.id} before working on it.`);
        }
        case 'update': {
          if (!args.id) return fail('update needs id.');
          await engine.updateAchievement(api, ctx.sessionId, actor, args.id, args);
          return ok(`Updated ${args.id}.`);
        }
        case 'mark_acceptance': {
          if (!args.id || !args.acceptanceId) return fail('mark_acceptance needs id + acceptanceId.');
          await engine.markAcceptance(api, ctx.sessionId, actor, args.id, args.acceptanceId, args.done !== false);
          return ok(`Acceptance ${args.acceptanceId} on ${args.id} marked ${args.done !== false ? 'done' : 'not done'}.`);
        }
        case 'comment': {
          if (!args.id || !args.text) return fail('comment needs id + text.');
          await engine.commentAchievement(api, ctx.sessionId, actor, args.id, args.text, args.kind);
          return ok(`Comment added to ${args.id}.`);
        }
        case 'drop': {
          if (!args.id || !args.reason) return fail('drop needs id + reason.');
          await engine.dropAchievement(api, ctx.sessionId, actor, args.id, args.reason);
          return ok(`${args.id} dropped (recoverable by the user).`);
        }
        default:
          return fail(`Unknown action "${args.action}".`);
      }
    }, ctx),
  },
  {
    name: 'rsat_claim',
    description: 'RSA/T: claim an available achievement (checks dependencies, conflicts, PRD running). Exclusive: one holder at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Achievement id.' },
        label: { type: 'string', description: 'Short display name for this agent on the board (default: model name).' },
      },
      required: ['id'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const api = ctx.api;
      const actor = agentActor(ctx);
      const doc = await engine.claim(api, ctx.sessionId, actor, args.id, args.label);
      const a = doc.achievements.find((x) => x.id === args.id);
      await broadcast(api, ctx.sessionId, { type: 'claimed', target: args.id, by: actor, data: { label: actor.name } });
      return ok([
        `Claimed ${args.id} "${a.title}".`,
        `Your scope: include ${(a.scope?.include || []).join(', ')} — stay inside it; widen only via rsat_scope with a reason.`,
        'Next: rsat_progress for heartbeats; rsat_complete when every acceptance box is checked.',
      ].join('\n'));
    }, ctx),
  },
  {
    name: 'rsat_release',
    description: 'RSA/T: release your claim (reason required) so another agent can take it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, reason: { type: 'string', description: 'Why the claim is released.' } },
      required: ['id', 'reason'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const actor2 = agentActor(ctx);
      const docR = await engine.release(ctx.api, ctx.sessionId, actor2, args.id, args.reason);
      await broadcast(ctx.api, ctx.sessionId, { type: 'released', target: args.id, by: actor2 });
      return ok(`Released ${args.id}. Other agents can claim it now.`);
    }, ctx),
  },
  {
    name: 'rsat_progress',
    description: 'RSA/T: heartbeat + progress note for your claimed achievement (keeps the claim TTL fresh).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: 'One-line progress note shown on the board.' },
      },
      required: ['id'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      await engine.progress(ctx.api, ctx.sessionId, agentActor(ctx), args.id, args.note);
      return ok(`Progress recorded on ${args.id}.`);
    }, ctx),
  },
  {
    name: 'rsat_note_file',
    description: 'RSA/T: add/replace the one-line ledger summary for a file you touched (complements the automatic fs ledger).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Achievement id.' },
        path: { type: 'string', description: 'Workspace-relative file path.' },
        summary: { type: 'string', description: 'One line: what changed and why.' },
        op: { type: 'string', enum: ['add', 'modify', 'delete', 'rename', 'refactor'] },
      },
      required: ['id', 'path', 'summary'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const { appendLedger } = await import('./store.js');
      await appendLedger(ctx.api, ctx.sessionId, args.id, {
        path: args.path, op: args.op ?? 'modify', tool: 'rsat_note_file',
        by: agentActor(ctx), summary: `${args.op ?? 'modify'} ${args.path} — ${args.summary}`,
      });
      try {
        await engine.setFileSummary(ctx.api, ctx.sessionId, agentActor(ctx), args.id, args.path, args.summary);
      } catch {  }
      return ok(`Ledger updated: ${args.path} → ${args.id}.`);
    }, ctx),
  },
  {
    name: 'rsat_scope',
    description: 'RSA/T: propose a scope widen/narrow for an achievement (reason required). Strict mode needs user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        op: { type: 'string', enum: ['widen', 'narrow'] },
        paths: { type: 'array', items: { type: 'string' }, description: 'Glob paths to add to include (widen) or exclude (narrow).' },
        reason: { type: 'string' },
      },
      required: ['id', 'op', 'paths', 'reason'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const doc = await engine.changeScope(ctx.api, ctx.sessionId, agentActor(ctx), args.id, args.op, args.paths, args.reason);
      const a = doc.achievements.find((x) => x.id === args.id);
      const change = a.scopeChanges[a.scopeChanges.length - 1];
      return ok(change.approved
        ? `Scope ${args.op} applied to ${args.id}: include now ${(a.scope.include || []).join(', ')}.`
        : `Scope ${args.op} PROPOSED for ${args.id} — awaiting user approval (strict mode). Check the board.`);
    }, ctx),
  },
  {
    name: 'rsat_complete',
    description: 'RSA/T: submit completion. If every acceptance box is checked it is marked done; otherwise it goes to review with your reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reason: { type: 'string', description: 'Completion summary / why unchecked boxes are acceptable.' },
      },
      required: ['id'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const actorC = agentActor(ctx);
      const doc = await engine.complete(ctx.api, ctx.sessionId, actorC, args.id, args.reason);
      const a = doc.achievements.find((x) => x.id === args.id);
      await broadcast(ctx.api, ctx.sessionId, {
        type: 'completed', target: args.id, title: a.title, tier: a.tier, points: a.points, by: actorC,
      });
      return ok(a.state === 'done'
        ? `Completed ${args.id} (+${a.points} pts).`
        : `${args.id} submitted for review (${a.reviewReason}). The user accepts it on the board.`);
    }, ctx),
  },
  {
    name: 'rsat_remember',
    description: 'RSA/T: save one structured note to YOUR agent memory (persists across sessions and provider/model swaps). Use for durable facts, decisions and their reasons — NOT progress chatter.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['fact', 'decision', 'reason'], description: 'fact = observed truth, decision = what was chosen, reason = why it was chosen.' },
        text: { type: 'string', description: 'The note itself (one line, self-contained).' },
      },
      required: ['kind', 'text'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const { addMemory } = await import('./agents.js');
      const rec = await addMemory(ctx.api, ctx.sessionId, agentActor(ctx), null, args.kind, args.text);
      return ok(`Noted (${args.kind}) — your memory now has ${rec.memory.length} entries. It survives session ends and model swaps.`);
    }, ctx),
  },
  {
    name: 'rsat_comment',
    description: 'RSA/T: free comment on the PRD or an achievement (coordination, questions, decisions).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Achievement id, or "prd" for the PRD itself.' },
        text: { type: 'string' },
        kind: { type: 'string', enum: ['note', 'question', 'decision', 'scope_change'] },
      },
      required: ['id', 'text'],
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const actor = agentActor(ctx);
      if (args.id === 'prd') {
        await engine.commentPrd(ctx.api, ctx.sessionId, actor, args.text, args.kind);
        return ok('PRD comment added.');
      }
      await engine.commentAchievement(ctx.api, ctx.sessionId, actor, args.id, args.text, args.kind);
      return ok(`Comment added to ${args.id}.`);
    }, ctx),
  },
  {
    name: 'rsat_context',
    description: 'RSA/T: read a structured summary of what OTHER agents have done — their decisions, recent file changes, and memory. Use this to understand the codebase state before writing code that touches shared areas.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        achievementId: { type: 'string', description: 'Optional: focus on one achievement\'s ledger.' },
      },
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const api = ctx.api;
      const doc = loadDoc(api, ctx.sessionId);
      if (!doc) return fail('No PRD yet.');
      const { memoryOfSession } = await import('./agents.js');
      const { readAllLedgers } = await import('./store.js');
      const lines = ['CROSS-AGENT CONTEXT (what others have done):'];
      const ledgers = readAllLedgers(api, ctx.sessionId, 30);
      if (ledgers.length > 0) {
        lines.push('', 'Recent file changes (all agents):');
        for (const l of ledgers.slice(-15)) {
          lines.push(`  ${l.by?.label ?? 'agent'}: ${l.op} ${l.path}${l.summary ? ` — ${l.summary}` : ''}`);
        }
      }
      const decisions = [];
      for (const a of doc.achievements) {
        for (const c of a.comments || []) {
          if (c.kind === 'decision' && c.by?.sessionId !== ctx.sessionId) {
            decisions.push(`  [${a.id}] ${c.by?.name ?? 'agent'}: ${c.text}`);
          }
        }
      }
      if (decisions.length > 0) {
        lines.push('', 'Decisions by other agents:');
        lines.push(...decisions.slice(-10));
      }
      if (doc.prd.architecture) {
        lines.push('', `Architecture: ${doc.prd.architecture}`);
      }
      if (doc.prd.modules?.length > 0) {
        lines.push('', 'Modules:');
        for (const m of doc.prd.modules.slice(0, 20)) {
          lines.push(`  ${m.id} ${m.name}${m.desc ? ` — ${m.desc}` : ''}${m.scope?.include?.length ? ` [${m.scope.include.join(', ')}]` : ''}`);
        }
      }
      if (doc.prd.milestones?.length > 0) {
        lines.push('', 'Milestones (derived — done when all their achievements are done):');
        for (const m of doc.prd.milestones.slice(0, 15)) {
          const tagged = doc.achievements.filter((a) => a.milestoneId === m.id);
          const done = tagged.filter((a) => a.state === 'done').length;
          const status = tagged.length > 0 && done === tagged.length ? '✓' : `${done}/${tagged.length}`;
          lines.push(`  ${m.id} ${m.title} [${status}]${m.goal ? ` — ${m.goal}` : ''}`);
        }
      }
      if (doc.prd.nonFunctional?.length > 0) {
        lines.push('', 'Non-functional requirements:');
        for (const n of doc.prd.nonFunctional.slice(0, 10)) {
          lines.push(`  - ${n.text}${n.metric ? ` [${n.metric}]` : ''}`);
        }
      }
      if (doc.prd.risks?.length > 0) {
        lines.push('', 'Risks:');
        for (const r of doc.prd.risks.slice(0, 8)) {
          lines.push(`  - [${r.severity}] ${r.text}${r.mitigation ? ` → ${r.mitigation}` : ''}`);
        }
      }
      if (doc.prd.technicalDecisions?.length > 0) {
        lines.push('', 'Technical decisions:');
        for (const td of doc.prd.technicalDecisions.slice(-5)) {
          lines.push(`  - ${td.text}${td.reason ? ` (${td.reason})` : ''}`);
        }
      }
      return ok(lines.join('\n'));
    }, ctx),
  },
  {
    name: 'rsat_interlink',
    description: 'RSA/T: read the live Interlinked architecture & symbol dependency graph in the token-dense @RSLK v1 format (module layer matrix, ComfyUI-style node sockets PROVIDES/CONSUMES, runtime/type/active/cross-agent wires, and blast-radius alerts). Call this before modifying shared files or contracts.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        focusPath: { type: 'string', description: 'Optional file path or substring to focus upstream/downstream wires on (e.g. "store.tsx").' },
        moduleId: { type: 'string', description: 'Optional module id filter (e.g. "M-01").' },
      },
    },
    execute: async (args, ctx) => run(async () => {
      if (requireCtx(ctx)) return requireCtx(ctx);
      const { buildWorkspaceInterlink } = await import('./interlink.js');
      const res = buildWorkspaceInterlink(ctx.api, ctx.sessionId, {
        focusPath: args?.focusPath ? String(args.focusPath) : undefined,
        moduleId: args?.moduleId ? String(args.moduleId) : undefined,
      });
      return ok(res.dsl || '@RSLK v1 | empty');
    }, ctx),
  },
];
