/**
 * RSA/T agent store (client) — roster registry + dispatch + AgentFace.
 * Sumber: rpc('agents') → server agents.ts (persisten .moriko/rsat/agents.json).
 * Live: frame bus 'rsat.changed' (event agents_changed/agent_*) → refresh.
 */
import { useEffect, useState } from 'react';
import { rpc } from './shared.tsx';
import { Spr, sa } from './sprites.tsx';
import { toast } from './toast.tsx';
import { dispatchAgent, openConversation, useAddonBus } from '@moriko/host';
import type { Ach } from './store.tsx';

export type AgentMemory = { at: string; kind: string; text: string };
export type AgentRec = {
  id: string; name: string; logo: string | null;
  providerId: string; model: string;
  /** Reasoning effort pilihan user ('' = ikut setelan percakapan). */
  thinkingLevel: string;
  memory: AgentMemory[];
  activeSessionId: string | null; createdAt: string;
};

/** Ladder effort yang bisa dipilih user ('' = inherit percakapan). */
export const EFFORTS: Array<[string, string]> = [
  ['', 'Inherit chat'],
  ['off', 'Off'],
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'X-High'],
  ['max', 'Max'],
];

let list: AgentRec[] = [];
let primed = false;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

/** Muat roster dari server. */
export async function refreshAgents(): Promise<void> {
  try {
    const r = (await rpc('agents', {})) as { agents?: AgentRec[] } | null;
    list = Array.isArray(r?.agents) ? r.agents : [];
    emit();
  } catch {
    /* offline: keep last */
  }
}

export function useAgents(): AgentRec[] {
  const [n, setN] = useState(0);
  const frame = useAddonBus('rsat.changed');
  useEffect(() => {
    const cb = () => setN((v) => v + 1);
    subs.add(cb);
    if (!primed) {
      primed = true;
      void refreshAgents();
    }
    return () => { subs.delete(cb); };
  }, []);
  // Registry berubah (agent dibuat/di-edit/di-bind) → muat ulang roster.
  useEffect(() => {
    if (frame) void refreshAgents();
  }, [frame]);
  return list;
}

/** USER: buat agent (identitas + logo + provider/model + effort + catatan). */
export async function createAgent(fields: {
  name: string; logo: string | null; providerId: string; model: string;
  thinkingLevel: string; note: string;
}): Promise<boolean> {
  try {
    await rpc('createAgent', fields);
    await refreshAgents();
    toast('ok', 'Agent created', `${fields.name} is ready for dispatch.`);
    return true;
  } catch (err) {
    toast('error', 'Create failed', err instanceof Error ? err.message : 'RPC error.');
    return false;
  }
}

/** USER: edit agent — identitas/memory tetap; provider/model/effort bisa diganti. */
export async function updateAgent(id: string, fields: Partial<Pick<AgentRec, 'name' | 'logo' | 'providerId' | 'model' | 'thinkingLevel'>>): Promise<boolean> {
  try {
    await rpc('updateAgent', { id, fields });
    await refreshAgents();
    toast('ok', 'Agent updated', id);
    return true;
  } catch (err) {
    toast('error', 'Update failed', err instanceof Error ? err.message : 'RPC error.');
    return false;
  }
}

/** USER: hapus agent. */
export async function deleteAgent(id: string): Promise<void> {
  try {
    await rpc('deleteAgent', { id });
    await refreshAgents();
    toast('warn', 'Agent deleted', id);
  } catch (err) {
    toast('error', 'Delete failed', err instanceof Error ? err.message : 'RPC error.');
  }
}

/** Prompt tugas yang dikirim ke sesi baru agent (identitas tidak perlu ada di sini —
 *  prompt fragment server menyuntikkannya; ini instruksi tugasnya). */
function buildPrompt(a: Ach): string {
  const ac = a.ac.map((c, i) => `  ${i + 1}. ${c.t}`).join('\n');
  return [
    `Task ${a.id} — "${a.title}" has been dispatched to you on the RSA/T board.`,
    a.desc || '',
    a.tech ? `Technical: ${a.tech}` : '',
    ac ? `Acceptance criteria (REPORT each one with rsat_progress as you meet it — the user ticks the boxes; they are user-only):${ac}` : '',
    `Scope: include ${a.scope.inc.join(', ') || '—'}${a.scope.exc.length ? ` · exclude ${a.scope.exc.join(', ')}` : ''}. Stay inside it.`,
    'Start with rsat_claim on this id, then rsat_progress for heartbeats, and rsat_remember for durable facts/decisions.',
  ].filter(Boolean).join('\n');
}

/** Dispatch: kirim quest ke agent → host membuat sesi chat baru + bind + send.
 *  thinkingLevel agent ikut dikirim: sesi baru langsung memakai effort pilihan user. */
export function dispatchQuest(agent: AgentRec, a: Ach): void {
  dispatchAgent({
    providerId: agent.providerId,
    model: agent.model,
    agentId: agent.id,
    agentName: agent.name,
    questId: a.id,
    questTitle: a.title,
    thinkingLevel: agent.thinkingLevel || undefined,
    prompt: buildPrompt(a),
  });
  toast('ok', `${a.id} dispatched`, `New session for ${agent.name} is opening.`);
}

/** Wajah agent: logo custom (data URL) bila ada; cocok via agentId ATAU nama. */
export function AgentFace({ by, ag, sz }: { by?: string; ag?: string | null; sz?: number }) {
  const agents = useAgents();
  const rec = (ag ? agents.find((x) => x.id === ag) : undefined)
    ?? (by && by !== 'U' ? agents.find((x) => x.name === by) : undefined);
  const style = sz ? { width: sz, height: sz } : undefined;
  if (!rec && by === 'U') return <span className="face" style={style}><Spr name="steve" /></span>;
  if (rec?.logo) return <img className="face alogo" src={rec.logo} alt="" style={style} />;
  return (
    <span className="face" style={style}>
      <Spr name="creeper" style={sa('rgb(var(--c-rsat-claimed))')} />
    </span>
  );
}
