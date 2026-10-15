/**
 * Council agent tools — what an agent inside a council can call.
 *
 * The server cannot see the host's conversation list, so membership is read
 * from the projection the panel syncs through `syncSessions`. When the
 * projection is cold (panel never opened), the tools degrade gracefully:
 * council_status reports "membership unknown", and council_broadcast targets
 * only the calling session's own council (resolved from the projection).
 */
import { clearDirective, getBrief, getOrchestrator } from './store.js';
import { membershipOf, broadcastToCouncil, wakeSessions, isSessionActive } from './sync.js';

/**
 * ORCHESTRATOR GATE — dispatch/stop are main-session-only powers. The caller
 * must be the council's Main Session AND be bound to the agent the user
 * designated as orchestrator (panel → moriko:set-orchestrator → council doc).
 */
function orchestratorGate(api, sessionId) {
  const mem = membershipOf(api, sessionId);
  if (!mem) return { error: 'You are not currently part of a council (or the panel has not been opened to sync membership).' };
  const main = mem.members.find((m) => m.role === 'main');
  if (!main || main.sessionId !== String(sessionId ?? '')) {
    return { error: 'Only the Main Session (the orchestrator) can use this tool — sub members cannot dispatch or stop others.' };
  }
  const orchestratorAgentId = getOrchestrator(api, sessionId, mem.councilId);
  if (!orchestratorAgentId) {
    return { error: 'No orchestrator has been designated for this council yet — ask the operator to designate one in the Council panel.' };
  }
  if (main.agentId !== orchestratorAgentId) {
    return { error: 'You are the Main Session but not the designated orchestrator agent (the operator must re-designate you in the panel).' };
  }
  return { mem, main };
}

/** RSAT roster via mod-to-mod API (empty when RSAT is absent). */
function rsatRoster(api, sessionId) {
  try {
    const rsat = api.api?.use?.('rsat');
    if (rsat && typeof rsat.listAgents === 'function') return rsat.listAgents(sessionId) ?? [];
  } catch { /* RSAT not installed */ }
  return [];
}

const toolDefs = [
  {
    name: 'council_status',
    description:
      'List the members of your council: the Main Session (the hub you share) and every Sub Session (one per fellow agent). Read-only — use it before picking up work to avoid collisions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(_args, ctx) {
      const api = ctx.api;
      const me = ctx.sessionId;
      const mem = membershipOf(api, me);
      if (!mem) {
        return { type: 'text', text: 'You are not currently part of a council (or the panel has not been opened to sync membership).' };
      }
      const lines = [
        `COUNCIL "${mem.councilTitle || 'untitled'}" (${mem.councilId}) — ${mem.members.length} member(s):`,
        ...mem.members.map((m) => {
          const tag = m.role === 'main' ? 'Main Session (hub)' : `Sub Session ${m.label}`;
          const self = m.sessionId === me ? ' ← you' : '';
          return `  · ${tag}${m.agentName ? ` — ${m.agentName}` : ''}${self}`;
        }),
      ];
      const brief = getBrief(api, me, mem.councilId);
      if (brief) lines.push('', 'Shared brief:', brief);
      return { type: 'text', text: lines.join('\n') };
    },
  },
  {
    name: 'council_broadcast',
    description:
      'Post a short notice to the OTHER members of your council. Delivered at their next round boundary as a system-injection block. Keep it to one or two sentences (coordination, handoff, blocker). Does not message yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The one- or two-sentence notice to broadcast.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const api = ctx.api;
      const me = ctx.sessionId;
      const text = String(args?.text ?? '').trim().slice(0, 600);
      if (!text) return { type: 'text', text: 'council_broadcast requires non-empty `text`.' };
      const mem = membershipOf(api, me);
      if (!mem) return { type: 'text', text: 'You are not part of a council; nothing to broadcast to.' };
      const report = await broadcastToCouncil(api, me, mem, text);
      return {
        type: 'text',
        text: `Council broadcast queued for ${report.delivered + report.queued} member(s) (delivered ${report.delivered}, queued ${report.queued}).`,
      };
    },
  },
  {
    name: 'council_brief',
    description: 'Read the shared council brief — the context every member shares. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(_args, ctx) {
      const api = ctx.api;
      const mem = membershipOf(api, ctx.sessionId);
      if (!mem) return { type: 'text', text: 'You are not part of a council.' };
      const brief = getBrief(api, ctx.sessionId, mem.councilId);
      return { type: 'text', text: brief || '(No shared brief has been written for this council yet.)' };
    },
  },
  {
    name: 'council_ack',
    description:
      'Acknowledge your dispatch directive: clears it from your context once absorbed. Call this once, right after your first read of the council context, before starting work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, ctx) {
      const api = ctx.api;
      await clearDirective(api, ctx.sessionId);
      return { type: 'text', text: 'Directive acknowledged and cleared. Coordinate with council_broadcast as you work.' };
    },
  },
  {
    name: 'council_roster',
    description:
      'List the RSAT agents available in this council — id, name, provider/model, and the sub session each already owns (if any). Read-only; dispatching NEW agents is user-only via the RSAT board.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(_args, ctx) {
      const api = ctx.api;
      const gate = orchestratorGate(api, ctx.sessionId);
      if (gate.error) return { type: 'text', text: gate.error };
      const roster = rsatRoster(api, ctx.sessionId);
      if (!roster.length) {
        return { type: 'text', text: 'No RSAT agents are available (the RSAT addon is not installed or has no registered agents).' };
      }
      const lines = ['Dispatchable RSAT agents:'];
      for (const agent of roster) {
        const owned = gate.mem.members.find((m) => m.role === 'sub' && m.agentId === agent.id);
        const has = owned ? ` — already in this council (sub session ${owned.label})` : '';
        lines.push(`  · ${agent.name} [${agent.id}] on ${agent.providerId}/${agent.model}${has}`);
      }
      return { type: 'text', text: lines.join('\n') };
    },
  },
  {
    name: 'council_send',
    description:
      'Send a message/instruction to a sub-session in this council. A RUNNING target receives it at its next round boundary; an IDLE target is woken and starts working immediately. Use council_status to find member agent ids.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Agent id (from council_status) of the sub-session to message.' },
        message: { type: 'string', description: 'The instruction/message to deliver (max 4000 chars).' },
      },
      required: ['target', 'message'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const api = ctx.api;
      const gate = orchestratorGate(api, ctx.sessionId);
      if (gate.error) return { type: 'text', text: gate.error };
      const agentId = String(args?.target ?? '');
      const message = String(args?.message ?? '').trim().slice(0, 4000);
      if (!agentId || !message) return { type: 'text', text: 'council_send requires non-empty `target` and `message`.' };
      const member = gate.mem.members.find((m) => m.role === 'sub' && m.agentId === agentId);
      if (!member) {
        const subs = gate.mem.members.filter((m) => m.role === 'sub');
        return { type: 'text', text: `No sub-session for agent "${agentId}" in this council. Active subs: ${subs.map((s) => `${s.agentName} [${s.agentId}]`).join(', ') || 'none'}. Dispatch agents via the RSAT board first.` };
      }
      const text = `Orchestrator instruction: ${message}`;
      // RUNNING target: inject — the adapter drains it at the next round boundary.
      if (isSessionActive(api, member.sessionId)) {
        try {
          await api.sessions.inject([member.sessionId], {
            text,
            level: 'info',
            key: `council-send:${gate.mem.councilId}:${Date.now()}`,
            ttlMs: 10 * 60 * 1000,
          });
          return { type: 'text', text: `Message queued for ${member.agentName} (running) — it appears at their next round boundary.` };
        } catch (error) {
          return { type: 'text', text: `Failed to inject message: ${String(error)}` };
        }
      }
      // IDLE target: a queued injection is never drained, so wake the sub-session
      // instead — a SERVER-SIDE run starts with this instruction as its turn.
      const report = await wakeSessions(api, [{ sessionId: member.sessionId, text }]);
      return { type: 'text', text: report
        ? `${member.agentName} was idle — woken server-side with your instruction. It is working now; follow along with council_status.`
        : `${member.agentName} was idle but the wake failed — check the server console.` };
    },
  },
  {
    name: 'council_stop',
    description:
      'As the orchestrator, halt a sub-agent\'s running response in this council. Pass the agent id (from council_roster/council_status) or "all" to stop every sub member. Streams abort server-side and the host marks the run stopped.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'RSAT agent id to stop, or "all" for every sub member.' },
      },
      required: ['agentId'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const api = ctx.api;
      const gate = orchestratorGate(api, ctx.sessionId);
      if (gate.error) return { type: 'text', text: gate.error };
      const wanted = String(args?.agentId ?? '');
      const subs = gate.mem.members.filter((m) => m.role === 'sub' && m.sessionId);
      const victims = wanted === 'all' ? subs : subs.filter((m) => m.agentId === wanted);
      if (!victims.length) {
        return { type: 'text', text: wanted === 'all' && subs.length === 0
          ? 'This council has no sub sessions to stop.'
          : `No sub session for agent "${wanted}" in this council — check council_status for the member list.` };
      }
      const stopped = [];
      const missed = [];
      for (const victim of victims) {
        let live = false;
        try { live = api.sessions.abort(victim.sessionId); } catch { live = false; }
        if (live) stopped.push(victim.agentName || victim.sessionId);
        else missed.push(victim.agentName || victim.sessionId);
        try {
          api.bus.publish('council:stopped', { councilId: gate.mem.councilId, conversationId: victim.sessionId, agentId: victim.agentId, at: Date.now() });
        } catch { /* best-effort */ }
      }
      const parts = [];
      if (stopped.length) parts.push(`stopped: ${stopped.join(', ')}`);
      if (missed.length) parts.push(`had no live stream: ${missed.join(', ')}`);
      return { type: 'text', text: `Council stop — ${parts.join('; ')}.` };
    },
  },
];

export { toolDefs };
