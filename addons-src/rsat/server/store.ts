/**
 * RSA/T store (R1) — persistence under `<workspace>/.moriko/rsat/`.
 *
 *   prd.rsprd.json   the document (atomic tmp+rename via the host's jailed
 *                    workspace write: vault snapshot + audit ride along)
 *   events.jsonl     append-only audit log (replay/debug)
 *   ledger/<id>.jsonl per-achievement file records
 *   exports/         user exports (R7)
 *   .gitignore       `*` — the user decided (Q7) git ignores .moriko/rsat
 *                    entirely; a local ignore needs no project file edits.
 *
 * Concurrency: one in-process write QUEUE per workspace — two agents writing
 * at the same moment serialize; a stale rev is REJECTED with a readable error
 * instead of silently clobbering (the losing caller re-reads and retries).
 */

import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { migrate, validateDoc, newPrdDoc, MAX_HISTORY } from './model.js';

const DIR = '.moriko/rsat';
export { DIR };
export const PRD_FILE = `${DIR}/prd.rsprd.json`;
const EVENTS_FILE = `${DIR}/events.jsonl`;
const GITIGNORE_FILE = `${DIR}/.gitignore`;

/** workspace root → tail of the in-flight write chain. */
const queues = new Map();
/** workspace root → cached doc. */
const cache = new Map();

function enqueue(root, job) {
  const prev = queues.get(root) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(root, next);
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

export class StoreLockedError extends Error {}

/** Minimal fs-backed workspace handle — used when the harness has no active
 *  workspace bound (RPC from the board UI with no session, or a bare path). */
function fsWorkspaceHandle(rootPath) {
  const root = rootPath ? path.resolve(rootPath) : null;
  return {
    root: () => root,
    read: (rel) => {
      if (!root) return '';
      try { return readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
    },
    write: async (rel, content) => {
      if (!root) return;
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    },
    list: (dir) => {
      if (!root) return [];
      try { return readdirSync(path.join(root, dir)); } catch { return []; }
    },
    exists: (rel) => Boolean(root && existsSync(path.join(root, rel))),
  };
}

/** Resolve the workspace handle with a graceful chain:
 *  board picker binding → session workspace → global active → any live
 *  session's path → process.cwd(). Never returns a handle whose root() throws. */
export function workspaceOf(api, sessionId) {
  // 1. Explicit board binding (its own picker) — persisted in the addon store.
  try {
    const binding = api.store?.get?.('workspacePath');
    if (binding && existsSync(binding)) return fsWorkspaceHandle(binding);
  } catch { /* fall through */ }
  // 2. Session-bound workspace (the active chat's folder).
  try {
    const sessionWs = api.workspace?.forSession?.(sessionId);
    if (sessionWs?.root()) return sessionWs;
  } catch { /* fall through */ }
  // 3. Global active workspace.
  try {
    if (api.workspace?.root?.()) return api.workspace;
  } catch { /* fall through */ }
  // 4. Any running session that carries a workspace path.
  try {
    for (const s of api.sessions?.list?.() ?? []) {
      if (s.workspacePath && existsSync(s.workspacePath)) return fsWorkspaceHandle(s.workspacePath);
    }
  } catch { /* fall through */ }
  // 5. The harness process cwd (dev server runs inside the workspace).
  try {
    const cwd = process.cwd();
    if (cwd && existsSync(cwd)) return fsWorkspaceHandle(cwd);
  } catch { /* fall through */ }
  return { root: () => null, read: () => '', write: async () => {}, list: () => [], exists: () => false };
}

export function rootOf(api, sessionId) {
  return workspaceOf(api, sessionId).root();
}

/** One-time folder init for a workspace (cheap, idempotent). */
function ensureInit(ws) {
  if (!ws.exists('.moriko')) ws.write('.moriko/rsat/.gitignore', '*\n');
  else if (!ws.exists(DIR)) {
    ws.write(GITIGNORE_FILE, '*\n');
  }
}

/** Load the doc for a workspace (cached). Returns null when none exists. */
export function loadDoc(api, sessionId) {
  return loadDocFrom(workspaceOf(api, sessionId));
}

/** loadDoc for an EXPLICIT workspace handle (reaper / registry paths). */
export function loadDocFrom(ws) {
  const root = ws.root();
  if (!root) return null;
  if (cache.has(root)) return cache.get(root);
  if (!ws.exists(PRD_FILE)) return null;
  let doc;
  try {
    doc = JSON.parse(ws.read(PRD_FILE));
  } catch (error) {
    throw new Error(`PRD file is corrupt (${error.message}). Restore it from git or delete ${PRD_FILE} to start fresh.`);
  }
  doc = migrate(doc);
  const problems = validateDoc(doc);
  if (problems.length > 0) {
    throw new Error(`PRD failed validation: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}`);
  }
  // SELF-HEALING stale-lock sweep on every cold load: docs written before the
  // refreshDependents fix carry 'locked' states whose deps are long done. A
  // sweep here heals any legacy doc once, on first touch, without waiting for
  // a new completion to trigger the transition hook.
  let healed = false;
  for (const a of doc.achievements) {
    if (a.state !== 'locked' && a.state !== 'available') continue;
    const eff = (a.dependsOn || []).every((d) => {
      const target = doc.achievements.find((x) => x.id === d);
      return !target || target.state === 'done' || target.state === 'dropped';
    }) ? 'available' : 'locked';
    if (eff !== a.state) { a.state = eff; healed = true; }
  }
  if (healed) {
    doc.history = [...(doc.history || []), {
      at: nowIso(), by: { kind: 'system' }, type: 'stale_lock_heal', target: 'board',
      data: { count: doc.achievements.length },
    }].slice(-MAX_HISTORY);
    try {
      ws.write(PRD_FILE, JSON.stringify(doc, null, 2));
    } catch { /* heal is best-effort — effOf still renders correctly */ }
  }
  cache.set(root, doc);
  return doc;
}

/** Create a fresh doc (does not persist yet). */
export function freshDoc(user) {
  return newPrdDoc(user);
}

/** Persist with rev check + event append. Serialized per workspace. */
export async function saveDoc(api, sessionId, doc, event) {
  const ws = workspaceOf(api, sessionId);
  if (!ws.root()) throw new Error('No workspace for RSA/T yet — pick one in the board header.');
  return saveDocFrom(api, ws, doc, event);
}

/**
 * Persist for an EXPLICIT workspace handle. After the write lands, the event
 * is PUBLISHED to the bus — the single choke-point that makes the board live:
 * UI rpc actions AND agent tool calls (rsat_claim/rsat_complete/…) all pass
 * here, so every mutation fires an 'rsat.changed' SSE frame and the board
 * re-renders without being closed and reopened.
 */
export async function saveDocFrom(api, ws, doc, event) {
  const root = ws.root();
  if (!root) throw new Error('No workspace for RSA/T yet — pick one in the board header.');
  const saved = await enqueue(root, async () => {
    const previous = cache.get(root);
    if (previous && typeof previous.rev === 'number' && doc.rev < previous.rev) {
      throw new StoreLockedError(`Stale rev (${doc.rev} < ${previous.rev}) — another agent wrote first. Re-read and retry.`);
    }
    doc.rev = (doc.rev ?? 0) + 1;
    doc.updatedAt = nowIso();
    if (Array.isArray(doc.history)) {
      if (event) doc.history.push({ at: nowIso(), ...event });
      if (doc.history.length > MAX_HISTORY) doc.history = doc.history.slice(-MAX_HISTORY);
    }
    ensureInit(ws);
    await ws.write(PRD_FILE, JSON.stringify(doc, null, 2));
    cache.set(root, doc);
    if (event) await appendEventFrom(ws, { ...event, rev: doc.rev });
    return doc;
  });
  // Live board refresh (R4): one frame per persisted event, best-effort.
  if (event) {
    try {
      await api.bus.publish('rsat.changed', { event: { ...event, rev: doc.rev }, at: Date.now() });
    } catch { /* bus is best-effort */ }
  }
  return saved;
}

/** Drop the cache (reload from disk next read). */
export function invalidate(api, sessionId) {
  const root = rootOf(api, sessionId);
  if (root) cache.delete(root);
}

/** Append one line to events.jsonl (best-effort, never blocks the caller). */
export async function appendEvent(api, sessionId, event) {
  return appendEventFrom(workspaceOf(api, sessionId), event);
}

/** appendEvent for an EXPLICIT workspace handle (agents registry, reaper). */
export async function appendEventFrom(ws, event) {
  if (!ws.root()) return;
  const line = JSON.stringify({ at: nowIso(), ...event }) + '\n';
  try {
    const existing = ws.exists(EVENTS_FILE) ? ws.read(EVENTS_FILE) : '';
    await ws.write(EVENTS_FILE, existing + line);
  } catch { /* audit log is best-effort */ }
}

/** Read the last N events (oldest first). */
export function readEvents(api, sessionId, limit = 200) {
  const ws = workspaceOf(api, sessionId);
  if (!ws.root() || !ws.exists(EVENTS_FILE)) return [];
  const lines = ws.read(EVENTS_FILE).split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Per-achievement file ledger (R5 storage side)
// ---------------------------------------------------------------------------

function ledgerFile(achievementId) {
  return `${DIR}/ledger/${achievementId}.jsonl`;
}

/** Append one file record to the achievement ledger. */
export async function appendLedger(api, sessionId, achievementId, record) {
  const ws = workspaceOf(api, sessionId);
  if (!ws.root()) return;
  const file = ledgerFile(achievementId);
  const existing = ws.exists(file) ? ws.read(file) : '';
  await ws.write(file, existing + JSON.stringify({ at: nowIso(), ...record }) + '\n');
}

/** Read the ledger for one achievement. */
export function readLedger(api, sessionId, achievementId) {
  const ws = workspaceOf(api, sessionId);
  const file = ledgerFile(achievementId);
  if (!ws.root() || !ws.exists(file)) return [];
  return ws.read(file).split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/** All ledger entries, newest first, capped. */
export function readAllLedgers(api, sessionId, limit = 500) {
  const ws = workspaceOf(api, sessionId);
  if (!ws.root()) return [];
  let dirListing = [];
  try { dirListing = ws.list(`${DIR}/ledger`); } catch { return []; }
  const out = [];
  for (const name of dirListing) {
    const id = name.replace(/\.jsonl$/, '');
    for (const entry of readLedger(api, sessionId, id)) out.push({ achievementId: id, ...entry });
  }
  return out.slice(-limit).reverse();
}

// ---------------------------------------------------------------------------
// Export/Import (R7)
// ---------------------------------------------------------------------------

export async function writeExport(api, sessionId, doc) {
  const ws = workspaceOf(api, sessionId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${DIR}/exports/${stamp}-${doc.prd.id}.rsprd.json`;
  await ws.write(file, JSON.stringify(doc, null, 2));
  return file;
}

export function writeImport(api, sessionId, content) {
  const parsed = JSON.parse(content); // caller handles the parse error
  const problems = validateDoc(parsed);
  if (problems.length > 0) throw new Error(`Import failed validation: ${problems.slice(0, 3).join('; ')}`);
  return migrate(parsed);
}

/** USER-only PRD teardown: archive a copy, then remove the live doc + ledgers.
 *  Direct fs — the workspace handle has no unlink, but every path stays inside
 *  the workspace root (resolved + checked) and the archive keeps a full copy. */
export async function archiveAndDelete(api, sessionId, doc, actor) {
  const ws = workspaceOf(api, sessionId);
  const root = ws.root();
  if (!root) throw new StoreLockedError('No active workspace.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = `${DIR}/archive/${stamp}-${doc.prd.id}.rsprd.json`;
  await ws.write(archiveFile, JSON.stringify({ ...doc, archivedAt: new Date().toISOString(), archivedBy: actor }, null, 2));
  const safeUnlink = (rel) => {
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return;
    rmSync(abs, { recursive: true, force: true });
  };
  safeUnlink(PRD_FILE);
  safeUnlink(`${DIR}/ledger`);
  cache.delete(root);
  return { archive: archiveFile };
}
