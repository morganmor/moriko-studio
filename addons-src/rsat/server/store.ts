

import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { migrate, validateDoc, newPrdDoc, MAX_HISTORY } from './model.js';

const DIR = '.moriko/rsat';
export { DIR };
export const PRD_FILE = `${DIR}/prd.rsprd.json`;
const EVENTS_FILE = `${DIR}/events.jsonl`;
const GITIGNORE_FILE = `${DIR}/.gitignore`;


const queues = new Map();

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


export function workspaceOf(api, sessionId) {
  try {
    const binding = api.store?.get?.('workspacePath');
    if (binding && existsSync(binding)) return fsWorkspaceHandle(binding);
  } catch {  }
  try {
    const sessionWs = api.workspace?.forSession?.(sessionId);
    if (sessionWs?.root()) return sessionWs;
  } catch {  }
  try {
    if (api.workspace?.root?.()) return api.workspace;
  } catch {  }
  try {
    for (const s of api.sessions?.list?.() ?? []) {
      if (s.workspacePath && existsSync(s.workspacePath)) return fsWorkspaceHandle(s.workspacePath);
    }
  } catch {  }
  try {
    const cwd = process.cwd();
    if (cwd && existsSync(cwd)) return fsWorkspaceHandle(cwd);
  } catch {  }
  return { root: () => null, read: () => '', write: async () => {}, list: () => [], exists: () => false };
}

export function rootOf(api, sessionId) {
  return workspaceOf(api, sessionId).root();
}


function ensureInit(ws) {
  if (!ws.exists('.moriko')) ws.write('.moriko/rsat/.gitignore', '*\n');
  else if (!ws.exists(DIR)) {
    ws.write(GITIGNORE_FILE, '*\n');
  }
}


export function loadDoc(api, sessionId) {
  return loadDocFrom(workspaceOf(api, sessionId));
}


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
    } catch {  }
  }
  cache.set(root, doc);
  return doc;
}


export function freshDoc(user) {
  return newPrdDoc(user);
}


export async function saveDoc(api, sessionId, doc, event) {
  const ws = workspaceOf(api, sessionId);
  if (!ws.root()) throw new Error('No workspace for RSA/T yet — pick one in the board header.');
  return saveDocFrom(api, ws, doc, event);
}


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
  if (event) {
    try {
      await api.bus.publish('rsat.changed', { event: { ...event, rev: doc.rev }, at: Date.now() });
    } catch {  }
  }
  return saved;
}


export function invalidate(api, sessionId) {
  const root = rootOf(api, sessionId);
  if (root) cache.delete(root);
}


export async function appendEvent(api, sessionId, event) {
  return appendEventFrom(workspaceOf(api, sessionId), event);
}


export async function appendEventFrom(ws, event) {
  if (!ws.root()) return;
  const line = JSON.stringify({ at: nowIso(), ...event }) + '\n';
  try {
    const existing = ws.exists(EVENTS_FILE) ? ws.read(EVENTS_FILE) : '';
    await ws.write(EVENTS_FILE, existing + line);
  } catch {  }
}


export function readEvents(api, sessionId, limit = 200) {
  const ws = workspaceOf(api, sessionId);
  if (!ws.root() || !ws.exists(EVENTS_FILE)) return [];
  const lines = ws.read(EVENTS_FILE).split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}


function ledgerFile(achievementId) {
  return `${DIR}/ledger/${achievementId}.jsonl`;
}


export async function appendLedger(api, sessionId, achievementId, record) {
  const ws = workspaceOf(api, sessionId);
  if (!ws.root()) return;
  const file = ledgerFile(achievementId);
  const existing = ws.exists(file) ? ws.read(file) : '';
  await ws.write(file, existing + JSON.stringify({ at: nowIso(), ...record }) + '\n');
}


export function readLedger(api, sessionId, achievementId) {
  const ws = workspaceOf(api, sessionId);
  const file = ledgerFile(achievementId);
  if (!ws.root() || !ws.exists(file)) return [];
  return ws.read(file).split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}


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


export async function writeExport(api, sessionId, doc) {
  const ws = workspaceOf(api, sessionId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${DIR}/exports/${stamp}-${doc.prd.id}.rsprd.json`;
  await ws.write(file, JSON.stringify(doc, null, 2));
  return file;
}

export function writeImport(api, sessionId, content) {
  const parsed = JSON.parse(content);
  const problems = validateDoc(parsed);
  if (problems.length > 0) throw new Error(`Import failed validation: ${problems.slice(0, 3).join('; ')}`);
  return migrate(parsed);
}


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
