/**
 * Council store — persistence under `<workspace>/.moriko/council/`.
 *
 *   councils.json  brief text per council id (what every member shares)
 *
 * The council GROUPING itself lives on the host's conversation records
 * (councilId / councilRole / councilAgentId) — this file only holds what a
 * conversation cannot carry: the shared brief the user writes in the panel.
 *
 * The session→council PROJECTION (needed by the agent tools and the prompt
 * fragment, which run server-side and cannot see conversations) is synced
 * client-side by the panel through the `syncSessions` RPC.
 */
import path from 'node:path';

const DIR = '.moriko/council';
const FILE = `${DIR}/councils.json`;

interface CouncilMeta {
  brief?: string;
  updatedAt?: number;
  /** RSAT agent id designated as the orchestrator (main session agent). */
  orchestratorAgentId?: string;
  /** PERSISTED membership projection (panel sync) — survives server restarts. */
  projection?: unknown;
}
interface CouncilDoc {
  rev?: number;
  councils?: Record<string, CouncilMeta>;
  /** sessionId → queued dispatch directive (cleared by council_ack). */
  directives?: Record<string, { councilId: string; text: string; at: number }>;
}

/** workspace root → cached doc. */
const cache = new Map<string, CouncilDoc>();
/** workspace root → tail of the in-flight write chain. */
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

/** The shared brief for one council ('' when the user never wrote one). */
export function getBrief(api, sessionId, councilId: string): string {
  if (!councilId) return '';
  try {
    const doc = read(api, sessionId);
    return String(doc.councils?.[councilId]?.brief ?? '');
  } catch { return ''; }
}

/** Persist the brief (user edit from the panel). */
export async function setBrief(api, sessionId, councilId: string, brief: string): Promise<void> {
  if (!councilId) throw new Error('No active council.');
  const doc = read(api, sessionId);
  doc.councils = doc.councils ?? {};
  const clean = String(brief).slice(0, 4000);
  if (clean) doc.councils[councilId] = { brief: clean, updatedAt: Date.now() };
  else delete doc.councils[councilId];
  await write(api, sessionId, doc);
}

/** The orchestrator agent id for one council ('' when none designated). */
export function getOrchestrator(api, sessionId, councilId: string): string {
  if (!councilId) return '';
  try {
    const doc = read(api, sessionId);
    return String(doc.councils?.[councilId]?.orchestratorAgentId ?? '');
  } catch { return ''; }
}

/** Persist the orchestrator designation (user → panel → RPC → here). */
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

/** Persist the panel-synced membership projection for one council — the
 *  in-memory maps die with the server process, and a graceful reload mid-run
 *  must not strip every member of its council identity. */
export async function saveProjection(api, sessionId, councilId: string, projection: unknown): Promise<void> {
  if (!councilId) return;
  const doc = read(api, sessionId);
  doc.councils = doc.councils ?? {};
  const meta = doc.councils[councilId] ?? (doc.councils[councilId] = {});
  meta.projection = projection;
  await write(api, sessionId, doc);
}

/** Every persisted projection in this workspace (rehydration after restart). */
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

/** The queued dispatch directive for one sub session (null when none). */
export function getDirective(api, sessionId): { councilId: string; text: string; at: number } | null {
  if (!sessionId) return null;
  try {
    const doc = read(api, sessionId);
    const entry = doc.directives?.[sessionId];
    return entry && typeof entry.text === 'string' ? entry : null;
  } catch { return null; }
}

/**
 * Queue the dispatch directive. It rides the council PROMPT FRAGMENT (context
 * channel) — delivered at the sub session's first fetch, no user message, no
 * auto-started round. File-backed, so it survives restarts (unlike the
 * injection queue, whose idle delivery is not wired).
 */
export async function setDirective(api, sessionId, councilId: string, text: string): Promise<void> {
  if (!sessionId || !councilId || !text) throw new Error('setDirective requires sessionId, councilId, text.');
  const doc = read(api, sessionId);
  doc.directives = doc.directives ?? {};
  doc.directives[sessionId] = { councilId, text: String(text).slice(0, 800), at: Date.now() };
  await write(api, sessionId, doc);
}

/** council_ack: the agent absorbed the directive — drop it from context. */
export async function clearDirective(api, sessionId): Promise<void> {
  if (!sessionId) return;
  const doc = read(api, sessionId);
  if (!doc.directives || !doc.directives[sessionId]) return;
  delete doc.directives[sessionId];
  await write(api, sessionId, doc);
}
