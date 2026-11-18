
import { workspaceOf, appendEventFrom, DIR, PRD_FILE } from './store.js';

const FILE = `${DIR}/agents.json`;

const MEMORY_FILE = `${DIR}/agent-memory.json`;
const KINDS = new Set(['fact', 'decision', 'reason']);

const EFFORTS = new Set(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);


const caches = new Map();

const sessionIndex = new Map();

let lastPrime = 0;

function normMemory(m) {
  const list = Array.isArray(m) ? m : [];
  return list.slice(-100).map((e) => ({
    at: String(e?.at ?? new Date().toISOString()),
    kind: KINDS.has(e?.kind) ? e.kind : 'fact',
    text: String(e?.text ?? '').slice(0, 600),
  })).filter((e) => e.text);
}

function normAgent(a) {
  const eff = String(a?.thinkingLevel ?? '');
  return {
    id: String(a?.id ?? ''),
    name: String(a?.name ?? '').slice(0, 40),
    logo: typeof a?.logo === 'string' ? a.logo.slice(0, 200_000) : null,
    providerId: String(a?.providerId ?? ''),
    model: String(a?.model ?? ''),
    thinkingLevel: EFFORTS.has(eff) ? eff : '',
    memory: normMemory(a?.memory),
    activeSessionId: a?.activeSessionId ? String(a.activeSessionId) : null,
    createdAt: String(a?.createdAt ?? new Date().toISOString()),
  };
}


function rootsOf(api, sessionId) {
  const out = new Set();
  try { for (const w of api.workspace.listRegistered?.() ?? []) out.add(w.path); } catch {  }
  try { const pinned = api.store?.get?.('workspacePath'); if (pinned) out.add(String(pinned)); } catch {  }
  const own = safeRoot(api, sessionId);
  if (own) out.add(own);
  return [...out];
}


function safeRoot(api, sessionId) {
  try { return workspaceOf(api, sessionId).root(); } catch { return null; }
}


function readRoot(api, root) {
  if (!root) return [];
  if (caches.has(root)) return caches.get(root);
  let list = [];
  try {
    const ws = api.workspace.forPath(root);
    if (ws.exists(FILE)) list = (JSON.parse(ws.read(FILE)) || {}).agents ?? [];
  } catch { list = []; }
  const clean = (Array.isArray(list) ? list : []).map(normAgent).filter((a) => a.id && a.name);
  caches.set(root, clean);
  return clean;
}


function primeIndex(api, sessionId) {
  const now = Date.now();
  if (sessionIndex.size > 0 && now - lastPrime < 1500) return;
  lastPrime = now;
  sessionIndex.clear();
  for (const root of rootsOf(api, sessionId)) {
    for (const a of readRoot(api, root)) {
      if (a.activeSessionId) sessionIndex.set(a.activeSessionId, a);
    }
  }
}


export function loadAgents(api, sessionId) {
  primeIndex(api, sessionId);
  return readRoot(api, safeRoot(api, sessionId));
}


function findAgent(api, id, sessionId) {
  for (const root of rootsOf(api, sessionId)) {
    const list = readRoot(api, root);
    const agent = list.find((a) => a.id === id);
    if (agent) return { root, list: [...list], agent };
  }
  return null;
}


async function saveAgentsTo(api, root, list, actor, event) {
  if (!root) throw new Error('No workspace for the agent registry yet.');
  const clean = list.map(normAgent).filter((a) => a.id && a.name);
  caches.set(root, clean);
  for (const a of clean) {
    if (a.activeSessionId) sessionIndex.set(a.activeSessionId, a);
  }
  const ws = api.workspace.forPath(root);
  await ws.write(FILE, JSON.stringify({ rev: Date.now(), agents: clean }, null, 2));
  if (event) await appendEventFrom(ws, { at: new Date().toISOString(), by: actor, ...event });
  try { await api.bus.publish('rsat.changed', { event: { type: 'agents_changed', target: 'registry', by: actor }, at: Date.now() }); } catch {  }
  return clean;
}


function boardRoot(api, sessionId) {
  const own = safeRoot(api, sessionId);
  if (own && hasBoardState(api, own)) return own;
  for (const root of rootsOf(api, sessionId)) {
    if (hasBoardState(api, root)) return root;
  }
  return own ?? rootsOf(api, sessionId)[0] ?? null;
}

function hasBoardState(api, root) {
  try {
    const ws = api.workspace.forPath(root);
    return ws.exists(FILE) || ws.exists(PRD_FILE);
  } catch { return false; }
}


function nextId(agents) {
  const max = agents.reduce((m, a) => {
    const n = Number(/^AG-(\d+)$/.exec(a.id)?.[1] ?? 0);
    return Math.max(m, n);
  }, 0);
  return `AG-${String(max + 1).padStart(3, '0')}`;
}


export async function createAgent(api, sessionId, actor, fields) {
  const root = boardRoot(api, sessionId);
  if (!root) throw new Error('No workspace for the agent registry yet.');
  const agents = [...readRoot(api, root)];
  if (!String(fields?.name ?? '').trim()) throw new Error('Agent name is required.');
  if (!String(fields?.providerId ?? '').trim()) throw new Error('Provider is required.');
  const rec = normAgent({
    id: nextId(agents),
    name: String(fields.name).trim(),
    logo: fields.logo ?? null,
    providerId: String(fields.providerId),
    model: String(fields.model ?? ''),
    thinkingLevel: fields.thinkingLevel ?? '',
    memory: String(fields.note ?? '').trim()
      ? [{ at: new Date().toISOString(), kind: 'fact', text: String(fields.note).trim().slice(0, 600) }]
      : [],
    createdAt: new Date().toISOString(),
  });
  agents.push(rec);
  await saveAgentsTo(api, root, agents, actor, { type: 'agent_created', target: rec.id, data: { name: rec.name } });
  return rec;
}


export async function updateAgent(api, sessionId, actor, id, fields) {
  const found = findAgent(api, id, sessionId);
  if (!found) throw new Error(`Agent "${id}" not found.`);
  const { root, list, agent: rec } = found;
  if (fields?.name !== undefined) rec.name = String(fields.name).trim().slice(0, 40);
  if (fields?.logo !== undefined) rec.logo = fields.logo ? String(fields.logo).slice(0, 200_000) : null;
  if (fields?.providerId !== undefined) rec.providerId = String(fields.providerId);
  if (fields?.model !== undefined) rec.model = String(fields.model);
  if (fields?.thinkingLevel !== undefined) {
    const eff = String(fields.thinkingLevel);
    rec.thinkingLevel = EFFORTS.has(eff) ? eff : '';
  }
  await saveAgentsTo(api, root, list, actor, { type: 'agent_updated', target: id, data: { keys: Object.keys(fields ?? {}) } });
  return rec;
}


export async function deleteAgent(api, sessionId, actor, id) {
  const found = findAgent(api, id, sessionId);
  if (!found) throw new Error(`Agent "${id}" not found.`);
  const list = found.list.filter((a) => a.id !== id);
  for (const [sid, rec] of sessionIndex) if (rec.id === id) sessionIndex.delete(sid);
  await saveAgentsTo(api, found.root, list, actor, { type: 'agent_deleted', target: id });
  return { deleted: true };
}


export async function bindSession(api, sessionId, actor, agentId, conversationId) {
  const found = findAgent(api, agentId, sessionId);
  if (!found) throw new Error(`Agent "${agentId}" not found.`);
  const { root, list, agent: rec } = found;
  for (const a of list) {
    if (a.activeSessionId === conversationId && a.id !== agentId) a.activeSessionId = null;
  }
  rec.activeSessionId = String(conversationId) || null;
  if (rec.activeSessionId) sessionIndex.set(rec.activeSessionId, rec);
  await saveAgentsTo(api, root, list, actor, { type: 'session_bound', target: agentId, data: { sessionId: rec.activeSessionId } });
  return { bound: rec.activeSessionId };
}


export function agentBySession(api, sessionId) {
  if (!sessionId) return null;
  const sid = String(sessionId);
  const hit = sessionIndex.get(sid);
  if (hit) return hit;
  if (api) primeIndex(api, sid);
  return sessionIndex.get(sid) ?? null;
}


const memoryCaches = new Map();


function readMemoryMap(api, root) {
  if (!root) return {};
  if (memoryCaches.has(root)) return memoryCaches.get(root);
  let map = {};
  try {
    const ws = api.workspace.forPath(root);
    if (ws.exists(MEMORY_FILE)) {
      const doc = JSON.parse(ws.read(MEMORY_FILE));
      map = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc.memory ?? {}) : {};
    }
  } catch { map = {}; }
  memoryCaches.set(root, map);
  return map;
}


async function writeMemoryMap(api, root, map) {
  const ws = api.workspace.forPath(root);
  await ws.write(MEMORY_FILE, JSON.stringify({ rev: Date.now(), memory: map }, null, 2));
  memoryCaches.set(root, map);
}


export function memoryOfSession(api, sessionId) {
  const rec = agentBySession(api, sessionId);
  if (!rec) return [];
  try {
    const root = boardRoot(api, sessionId);
    const map = readMemoryMap(api, root);
    const entries = Array.isArray(map[rec.id]) ? normMemory(map[rec.id]) : [];
    if (entries.length > 0) return entries;
  } catch {  }
  return rec.memory ?? [];
}


export async function addMemory(api, sessionId, actor, agentId, kind, text) {
  const rec = agentBySession(api, sessionId);
  const id = agentId || rec?.id;
  if (!id) throw new Error('No agent identity for this session.');
  const found = findAgent(api, id, sessionId);
  if (!found) throw new Error(`Agent "${id}" not found.`);
  const root = boardRoot(api, sessionId);
  if (!root) throw new Error('No workspace bound for this board yet.');
  const map = readMemoryMap(api, root);
  const entries = normMemory(map[id]);
  entries.push({
    at: new Date().toISOString(),
    kind: KINDS.has(kind) ? kind : 'fact',
    text: String(text ?? '').slice(0, 600),
  });
  const clean = normMemory(entries);
  map[id] = clean;
  await writeMemoryMap(api, root, map);
  const ws = api.workspace.forPath(root);
  await appendEventFrom(ws, { at: new Date().toISOString(), by: actor, type: 'memory_added', target: id, data: { kind, workspace: root } });
  try { await api.bus.publish('rsat.changed', { event: { type: 'memory_added', target: id, by: actor }, at: Date.now() }); } catch {  }
  return { id, memory: clean };
}


export async function reapStaleClaims(api) {
  const registered = api.workspace.listRegistered?.() ?? [];
  const { loadDocFrom, saveDocFrom } = await import('./store.js');
  for (const entry of registered) {
    let ws;
    try { ws = api.workspace.forPath(entry.path); } catch { continue; }
    if (!ws?.root()) continue;
    let doc;
    try { doc = loadDocFrom(ws); } catch { continue; }
    if (!doc || doc.prd.status !== 'running') continue;
    const ttlSec = Number(api.settings?.get?.('claimTtlSec')) || 3600;
    const now = Date.now();
    for (const a of doc.achievements) {
      if (!a.claim || !['claimed', 'in_progress'].includes(a.state)) continue;
      const beat = Date.parse(a.claim.heartbeat ?? a.claim.at ?? '') || 0;
      if (now - beat > ttlSec * 1000) {
        const who = a.claim.label ?? 'agent';
        a.state = 'available';
        a.claim = null;
        a.updatedAt = new Date().toISOString();
        await saveDocFrom(api, ws, doc, {
          by: { kind: 'system', name: 'ttl-reaper' },
          type: 'released', target: a.id,
          data: { reason: `heartbeat expired (>${Math.round(ttlSec / 60)} min) — freed by ${who}` },
        });
      }
    }
  }
}
