
import path from 'node:path';

const DIR = '.moriko/council';
const FILE = `${DIR}/councils.json`;

interface CouncilMeta {
  brief?: string;
  updatedAt?: number;
  
  orchestratorAgentId?: string;
  
  projection?: unknown;
}
interface CouncilDoc {
  rev?: number;
  councils?: Record<string, CouncilMeta>;
  
  directives?: Record<string, { councilId: string; text: string; at: number }>;
}


const cache = new Map<string, CouncilDoc>();

const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(root: string, job: () => T | Promise<T>): Promise<T> {
  const prev = queues.get(root) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(root, next);
  return next as Promise<T>;
}

function read(api, sessionId): CouncilDoc {
  const root = rootOf(api, sessionId);
  if (!root) return {};
  if (cache.has(root)) return cache.get(root) as CouncilDoc;
  const ws = api.workspace.forSession(sessionId);
  let doc: CouncilDoc = {};
  try {
    if (ws?.exists(FILE)) doc = JSON.parse(ws.read(FILE)) as CouncilDoc;
  } catch { doc = {}; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  cache.set(root, doc);
  return doc;
}

async function write(api, sessionId, doc: CouncilDoc): Promise<void> {
  const root = rootOf(api, sessionId);
  if (!root) throw new Error('No workspace for Council yet — bind a folder first.');
  const ws = api.workspace.forSession(sessionId);
  await enqueue(root, () => {
    doc.rev = (doc.rev ?? 0) + 1;
    if (!ws.exists('.moriko')) ws.write(`${DIR}/.gitignore`, '*\n');
    ws.write(FILE, JSON.stringify(doc));
    cache.set(root, doc);
  });
}

function rootOf(api, sessionId): string | null {
  try {
    const ws = api.workspace.forSession(sessionId);
    return ws?.root() ?? null;
  } catch { return null; }
}


export function getBrief(api, sessionId, councilId: string): string {
  if (!councilId) return '';
  try {
    const doc = read(api, sessionId);
    return String(doc.councils?.[councilId]?.brief ?? '');
  } catch { return ''; }
}


export async function setBrief(api, sessionId, councilId: string, brief: string): Promise<void> {
  if (!councilId) throw new Error('No active council.');
  const doc = read(api, sessionId);
  doc.councils = doc.councils ?? {};
  const clean = String(brief);
  if (clean) doc.councils[councilId] = { brief: clean, updatedAt: Date.now() };
  else delete doc.councils[councilId];
  await write(api, sessionId, doc);
}


export function getOrchestrator(api, sessionId, councilId: string): string {
  if (!councilId) return '';
  try {
    const doc = read(api, sessionId);
    return String(doc.councils?.[councilId]?.orchestratorAgentId ?? '');
  } catch { return ''; }
}


export async function setOrchestrator(api, sessionId, councilId: string, agentId: string): Promise<void> {
  if (!councilId) throw new Error('No active council.');
  const doc = read(api, sessionId);
  doc.councils = doc.councils ?? {};
  const meta = doc.councils[councilId] ?? (doc.councils[councilId] = {});
  if (agentId) meta.orchestratorAgentId = agentId;
  else delete meta.orchestratorAgentId;
  meta.updatedAt = Date.now();
  await write(api, sessionId, doc);
}


export async function saveProjection(api, sessionId, councilId: string, projection: unknown): Promise<void> {
  if (!councilId) return;
  const doc = read(api, sessionId);
  doc.councils = doc.councils ?? {};
  const meta = doc.councils[councilId] ?? (doc.councils[councilId] = {});
  meta.projection = projection;
  await write(api, sessionId, doc);
}


export function loadProjections(api, sessionId): Array<{ councilId: string; projection: unknown }> {
  try {
    const doc = read(api, sessionId);
    const out: Array<{ councilId: string; projection: unknown }> = [];
    for (const [councilId, meta] of Object.entries(doc.councils ?? {})) {
      if (meta?.projection) out.push({ councilId, projection: meta.projection });
    }
    return out;
  } catch { return []; }
}


export function getDirective(api, sessionId): { councilId: string; text: string; at: number } | null {
  if (!sessionId) return null;
  try {
    const doc = read(api, sessionId);
    const entry = doc.directives?.[sessionId];
    return entry && typeof entry.text === 'string' ? entry : null;
  } catch { return null; }
}


export async function setDirective(api, sessionId, councilId: string, text: string): Promise<void> {
  if (!sessionId || !councilId || !text) throw new Error('setDirective requires sessionId, councilId, text.');
  const doc = read(api, sessionId);
  doc.directives = doc.directives ?? {};
  doc.directives[sessionId] = { councilId, text: String(text), at: Date.now() };
  await write(api, sessionId, doc);
}


export async function clearDirective(api, sessionId): Promise<void> {
  if (!sessionId) return;
  const doc = read(api, sessionId);
  if (!doc.directives || !doc.directives[sessionId]) return;
  delete doc.directives[sessionId];
  await write(api, sessionId, doc);
}
