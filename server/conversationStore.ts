import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './atomicWrite.js';
import { appDataDir, conversationDir, conversationIndexFile, conversationManifestFile } from './paths.js';
import { migrateAttachmentDataUrls, stripAttachmentDataUrls, stripTurnPayloads, INLINE_DATA_URL_LIMIT, putBytes } from './attachmentStore.js';



const INDEX_FILE = conversationIndexFile;
const MANIFEST_FILE = conversationManifestFile;
const LEGACY_ARCHIVE = path.join(appDataDir, 'conversations.json');


export type StoredConversation = { id: string } & Record<string, unknown>;


const MAX_RECORD_JSON = 24_000_000;


interface ManifestFile {
  version: 1;
  
  nextSeq: number;
  
  order: string[];
  
  folders: Record<string, string>;
}

const CHAT_DIR_RE = /^chat-(\d{3,})-(\d{8})$/;

function isStoredConversation(entry: unknown): entry is StoredConversation {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { id?: unknown }).id === 'string' &&
    (entry as { id: string }).id.length > 0 &&
    (entry as { id: string }).id.length <= 96 &&
    Array.isArray((entry as { turns?: unknown }).turns)
  );
}


function chatFolderName(seq: number, createdAtMs: number): string {
  const date = new Date(Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : Date.now());
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `chat-${String(Math.max(1, Math.trunc(seq))).padStart(3, '0')}-${stamp}`;
}

function emptyManifest(): ManifestFile {
  return { version: 1, nextSeq: 1, order: [], folders: {} };
}

function readManifest(): ManifestFile {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Partial<ManifestFile>;
    if (parsed && typeof parsed === 'object') {
      return {
        version: 1,
        nextSeq: typeof parsed.nextSeq === 'number' && parsed.nextSeq >= 1 ? parsed.nextSeq : 1,
        order: Array.isArray(parsed.order)
          ? parsed.order.filter((id): id is string => typeof id === 'string')
          : [],
        folders:
          parsed.folders && typeof parsed.folders === 'object'
            ? (parsed.folders as Record<string, string>)
            : {},
      };
    }
  } catch {
  }
  return emptyManifest();
}


function adoptOrphanFolders(active: ManifestFile, records: Map<string, StoredConversation>): void {
  const claimed = new Set(Object.values(active.folders));
  let entries: string[] = [];
  try {
    entries = readdirSync(conversationDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && CHAT_DIR_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const folder of entries) {
    if (claimed.has(folder)) continue;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(conversationDir, folder, 'chat-data.json'), 'utf8'),
      );
      if (!isStoredConversation(parsed)) continue;
      const seq = Number(CHAT_DIR_RE.exec(folder)?.[1] ?? 0);
      active.nextSeq = Math.max(active.nextSeq, seq + 1);
      active.folders[parsed.id] = folder;
      active.order.push(parsed.id);
      records.set(parsed.id, parsed);
    } catch {
    }
  }
  active.order.sort((a, b) => {
    const seqA = Number(CHAT_DIR_RE.exec(active.folders[a] ?? '')?.[1] ?? 0);
    const seqB = Number(CHAT_DIR_RE.exec(active.folders[b] ?? '')?.[1] ?? 0);
    return seqA - seqB;
  });
}


function migrateLegacyArchive(): void {
  if (!existsSync(LEGACY_ARCHIVE) || existsSync(MANIFEST_FILE)) return;
  let entries: StoredConversation[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(LEGACY_ARCHIVE, 'utf8'));
    if (Array.isArray(parsed)) entries = parsed.filter(isStoredConversation);
  } catch {
    return;
  }
  const active = emptyManifest();
  mkdirSync(conversationDir, { recursive: true });
  const ordered = [...entries].sort(
    (a, b) =>
      (typeof a.createdAt === 'number' ? a.createdAt : 0) -
      (typeof b.createdAt === 'number' ? b.createdAt : 0),
  );
  for (const record of ordered) {
    const seq = active.nextSeq;
    active.nextSeq += 1;
    active.folders[record.id] = chatFolderName(
      seq,
      typeof record.createdAt === 'number' ? record.createdAt : 0,
    );
    active.order.push(record.id);
    atomicWriteJson(path.join(conversationDir, active.folders[record.id], 'chat-data.json'), record);
  }
  atomicWriteJson(MANIFEST_FILE, {
    version: 1,
    nextSeq: active.nextSeq,
    order: active.order,
    folders: active.folders,
  });
  atomicWriteJson(INDEX_FILE, ordered.map(summarizeConversation));
  try {
    renameSync(LEGACY_ARCHIVE, `${LEGACY_ARCHIVE}.migrated`);
  } catch {
  }
}

let cache: Map<string, StoredConversation> | null = null;
let manifest: ManifestFile | null = null;

let writeChain: Promise<void> = Promise.resolve();


function ensureLoaded(): Map<string, StoredConversation> {
  if (cache) return cache;
  migrateLegacyArchive();
  const map = new Map<string, StoredConversation>();
  const active = readManifest();
  adoptOrphanFolders(active, map);
  for (const id of active.order) {
    const folder = active.folders[id];
    if (!folder) continue;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(conversationDir, folder, 'chat-data.json'), 'utf8'),
      );
      migrateAttachmentDataUrls(id, parsed);
      if (isStoredConversation(parsed)) map.set(id, parsed);
    } catch {
      delete active.folders[id];
      active.order = active.order.filter((entry) => entry !== id);
    }
  }
  manifest = active;
  cache = map;
  if (!existsSync(INDEX_FILE)) atomicWriteJson(INDEX_FILE, buildIndex());
  sweepTrash();
  return map;
}

function buildIndex(): Array<ConversationSummary> {
  return [...(cache?.values() ?? [])].map(summarizeConversation);
}


export function updateStoredVisual(
  sessionId: string,
  visualId: string,
  patch: { html: string; title?: string; height?: number; variants?: unknown },
): boolean {
  const map = ensureLoaded();
  const record = map.get(sessionId);
  if (!record || !Array.isArray(record.turns)) return false;
  const turns = record.turns as Array<Record<string, unknown>>;
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const turn = turns[t];
    if (!turn || typeof turn !== 'object') continue;
    const segments = turn.segments;
    if (!Array.isArray(segments)) continue;
    for (let s = segments.length - 1; s >= 0; s -= 1) {
      const segment = segments[s];
      if (!segment || typeof segment !== 'object') continue;
      const visual = (segment as Record<string, unknown>).visual;
      if (!visual || typeof visual !== 'object') continue;
      const candidate = visual as Record<string, unknown>;
      if (candidate.id !== visualId) continue;
      const { html } = patch;
      if (typeof html === 'string' && html.length >= INLINE_DATA_URL_LIMIT) {
        candidate.htmlRef = {
          hash: putBytes(Buffer.from(html, 'utf8'), 'text/html'),
          byteSize: Buffer.byteLength(html, 'utf8'),
        };
        delete candidate.html;
      } else {
        candidate.html = html;
        delete candidate.htmlRef;
      }
      if (patch.title !== undefined) candidate.title = patch.title;
      if (patch.height !== undefined) candidate.height = patch.height;
      if (patch.variants !== undefined) candidate.variants = patch.variants;
      candidate.replaces = true;
      record.updatedAt = Date.now();
      scheduleFlush(new Set([sessionId]), []);
      return true;
    }
  }
  return false;
}


export function listStoredVisuals(sessionId: string): Array<{ id: string; title: string }> {
  const map = ensureLoaded();
  const record = map.get(sessionId);
  if (!record || !Array.isArray(record.turns)) return [];
  const found: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();
  const turns = record.turns as Array<Record<string, unknown>>;
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const turn = turns[t];
    if (!turn || typeof turn !== 'object') continue;
    const segments = turn.segments;
    if (!Array.isArray(segments)) continue;
    for (let s = segments.length - 1; s >= 0; s -= 1) {
      const segment = segments[s];
      if (!segment || typeof segment !== 'object') continue;
      const visual = (segment as Record<string, unknown>).visual;
      if (!visual || typeof visual !== 'object') continue;
      const candidate = visual as Record<string, unknown>;
      if (typeof candidate.id !== 'string' || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      found.push({
        id: candidate.id,
        title: typeof candidate.title === 'string' ? candidate.title : 'Visual',
      });
    }
  }
  return found;
}


export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId?: string;
  model?: string;
  
  workspaceId?: string;
  
  councilId?: string;
  councilRole?: 'main' | 'sub';
  councilAgentId?: string;
  
  rev?: number;
  turnCount: number;
  
  preview: string;
  settings?: Record<string, unknown>;
  compaction?: unknown;
  liveContext?: unknown;
}

function latestPreview(turns: unknown[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const content = (turns[i] as { content?: unknown } | null)?.content;
    if (typeof content === 'string' && content.trim()) {
      const collapsed = content.trim().replace(/\s+/g, ' ');
      return collapsed.length > 120 ? collapsed.slice(0, 120) + '…' : collapsed;
    }
  }
  return '';
}

export function summarizeConversation(entry: StoredConversation): ConversationSummary {
  const turns = Array.isArray(entry.turns) ? entry.turns : [];
  return {
    id: entry.id,
    title: typeof entry.title === 'string' ? entry.title : 'Untitled',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    providerId: typeof entry.providerId === 'string' ? entry.providerId : undefined,
    model: typeof entry.model === 'string' ? entry.model : undefined,
    workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : undefined,
    councilId: typeof entry.councilId === 'string' ? entry.councilId : undefined,
    councilRole: entry.councilRole === 'sub' ? 'sub' : entry.councilRole === 'main' ? 'main' : undefined,
    councilAgentId: typeof entry.councilAgentId === 'string' ? entry.councilAgentId : undefined,
    rev: typeof entry.rev === 'number' && Number.isFinite(entry.rev) ? entry.rev : undefined,
    turnCount: turns.length,
    preview: latestPreview(turns),
    ...(entry.settings && typeof entry.settings === 'object'
      ? { settings: entry.settings as Record<string, unknown> }
      : {}),
    ...(entry.compaction !== undefined ? { compaction: entry.compaction } : {}),
    ...(entry.liveContext !== undefined ? { liveContext: entry.liveContext } : {}),
  };
}

export interface ConversationConfigPatch {
  settings?: Record<string, unknown>;
  compaction?: unknown;
  hasCompaction?: boolean;
  providerId?: string;
  model?: string;
  liveContext?: unknown;
  initialConversation?: StoredConversation;
}

export function patchConversationConfig(
  id: string,
  patch: ConversationConfigPatch,
): StoredConversation | null {
  if (!id || id.length > 96) return null;
  const map = ensureLoaded();
  const existing = map.get(id);

  if (!existing) {
    if (!patch.initialConversation || !Array.isArray(patch.initialConversation.turns)) {
      return null;
    }
    const base = { ...patch.initialConversation, id } as Record<string, unknown> & { id: string };
    stripAttachmentDataUrls(base as StoredConversation);
    const baseSettings =
      typeof base.settings === 'object' && base.settings !== null
        ? (base.settings as Record<string, unknown>)
        : {};
    const created: StoredConversation = {
      ...(base as StoredConversation),
      ...(patch.settings
        ? {
            settings: {
              ...baseSettings,
              ...patch.settings,
            },
          }
        : {}),
      ...(patch.hasCompaction
        ? { compaction: patch.compaction === null ? undefined : patch.compaction }
        : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.liveContext !== undefined
        ? { liveContext: patch.liveContext === null ? undefined : patch.liveContext }
        : {}),
      rev: Math.max(1, typeof base.rev === 'number' && Number.isFinite(base.rev) ? base.rev : 1),
    };
    if (patch.hasCompaction && patch.compaction === null) delete created.compaction;
    if (patch.liveContext === null) delete created.liveContext;
    if (JSON.stringify(created).length > MAX_RECORD_JSON) return null;
    map.set(id, created);
    scheduleFlush(new Set([id]), []);
    return created;
  }

  const next: StoredConversation = { ...existing };
  if (patch.settings) {
    const prevSettings =
      typeof existing.settings === 'object' && existing.settings !== null
        ? (existing.settings as Record<string, unknown>)
        : {};
    next.settings = { ...prevSettings, ...patch.settings };
  }
  if (patch.hasCompaction) {
    if (patch.compaction === null || patch.compaction === undefined) {
      delete next.compaction;
    } else {
      next.compaction = patch.compaction;
    }
  }
  if (patch.providerId !== undefined) next.providerId = patch.providerId;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.liveContext !== undefined) {
    if (patch.liveContext === null) delete next.liveContext;
    else next.liveContext = patch.liveContext;
  }
  const prevRev = typeof existing.rev === 'number' && Number.isFinite(existing.rev) ? existing.rev : 0;
  next.rev = prevRev + 1;
  if (JSON.stringify(next).length > MAX_RECORD_JSON) return null;
  map.set(id, next);
  scheduleFlush(new Set([id]), []);
  return next;
}

function liveContextMeta(value: unknown): { at: number; hasBuckets: boolean; tokens: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { at?: unknown; buckets?: unknown; liveContextTokens?: unknown };
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
  const tokens =
    typeof record.liveContextTokens === 'number' && Number.isFinite(record.liveContextTokens)
      ? record.liveContextTokens
      : 0;
  const hasBuckets = typeof record.buckets === 'object' && record.buckets !== null;
  return { at, hasBuckets, tokens };
}

function chooseNewerLiveContext(incoming: unknown, existing: unknown): unknown {
  if (existing === undefined) return incoming;
  if (incoming === undefined) return existing;
  const inMeta = liveContextMeta(incoming);
  const exMeta = liveContextMeta(existing);
  if (!exMeta) return incoming;
  if (!inMeta) return existing;
  if (inMeta.at !== exMeta.at) return inMeta.at > exMeta.at ? incoming : existing;
  if (inMeta.hasBuckets !== exMeta.hasBuckets) return inMeta.hasBuckets ? incoming : existing;
  return inMeta.tokens >= exMeta.tokens ? incoming : existing;
}

function lastTurnIdOf(turns: unknown): string | null {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const tail = turns[turns.length - 1];
  return typeof tail === 'object' && tail !== null && typeof (tail as { id?: unknown }).id === 'string'
    ? (tail as { id: string }).id
    : null;
}

function shouldAcceptSyncedEntry(entry: StoredConversation, existing: StoredConversation): boolean {
  const incomingAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : null;
  const existingAt = typeof existing.updatedAt === 'number' ? existing.updatedAt : null;
  if (incomingAt !== null && existingAt !== null && incomingAt !== existingAt) {
    return incomingAt > existingAt;
  }
  const incomingRev = typeof entry.rev === 'number' && Number.isFinite(entry.rev) ? entry.rev : null;
  const existingRev = typeof existing.rev === 'number' && Number.isFinite(existing.rev) ? existing.rev : null;
  if (incomingRev !== null && existingRev !== null && incomingRev !== existingRev) {
    return incomingRev > existingRev;
  }
  if (incomingRev !== null && existingRev === null) return true;
  if (incomingRev === null && existingRev !== null) return false;
  const incomingTurns = Array.isArray(entry.turns) ? entry.turns.length : -1;
  const existingTurns = Array.isArray(existing.turns) ? existing.turns.length : -1;
  return incomingTurns >= existingTurns;
}

function mergeSyncedConversation(
  entry: StoredConversation,
  existing: StoredConversation,
): StoredConversation {
  if (entry.liveContext !== undefined) {
    return { ...entry, liveContext: chooseNewerLiveContext(entry.liveContext, existing.liveContext) };
  }
  if (existing.liveContext === undefined) return entry;
  // Preserve server-recorded liveContext unless the client clearly truncated/rewrote turns.
  const entryTurns = Array.isArray(entry.turns) ? entry.turns.length : 0;
  const existingTurns = Array.isArray(existing.turns) ? existing.turns.length : 0;
  const sameTail =
    entryTurns >= existingTurns &&
    (existingTurns === 0 || lastTurnIdOf(entry.turns) === lastTurnIdOf(existing.turns));
  if (!sameTail) return entry;
  return { ...entry, liveContext: existing.liveContext };
}

export function setStoredLiveContext(id: string, liveContext: unknown, flush = false): void {
  if (!id || liveContext === undefined) return;
  const map = ensureLoaded();
  const existing = map.get(id);
  if (!existing) return;
  existing.liveContext = chooseNewerLiveContext(liveContext, existing.liveContext);
  if (flush) scheduleFlush(new Set([id]), []);
}

export function listStoredConversations(): StoredConversation[] {
  return [...ensureLoaded().values()];
}


export function listStoredConversationSummaries(): ConversationSummary[] {
  return [...ensureLoaded().values()].map(summarizeConversation);
}


export function getStoredConversation(id: string): StoredConversation | null {
  const record = ensureLoaded().get(id) ?? null;
  if (!record) return null;
  // same run (duplicate ids — the reported ghost-turn bug) must not ship its
  const turns = record.turns;
  if (!Array.isArray(turns)) return record;
  const seen = new Set<string>();
  let dirty = false;
  for (const turn of turns) {
    const id2 = typeof turn === 'object' && turn !== null ? (turn as { id?: unknown }).id : null;
    if (typeof id2 === 'string') {
      if (seen.has(id2)) dirty = true;
      else seen.add(id2);
    }
  }
  if (!dirty) return record;
  return {
    ...record,
    turns: turns.filter((turn) => {
      const id2 = typeof turn === 'object' && turn !== null ? (turn as { id?: unknown }).id : null;
      if (typeof id2 !== 'string') return true;
      if (!seen.has(id2)) return false;
      seen.delete(id2);
      return true;
    }),
  };
}


export function chatDirFor(sessionId: string): string | null {
  ensureLoaded();
  const folder = manifest?.folders[sessionId];
  return folder ? path.join(conversationDir, folder) : null;
}


export function ensureChatDirFor(sessionId: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(sessionId)) return null;
  ensureLoaded();
  const active = manifest!;
  let folder = active.folders[sessionId];
  if (!folder) {
    const seq = active.nextSeq;
    active.nextSeq += 1;
    folder = chatFolderName(seq, Date.now());
    active.folders[sessionId] = folder;
    active.order.push(sessionId);
    try {
      atomicWriteJson(MANIFEST_FILE, {
        version: 1,
        nextSeq: active.nextSeq,
        order: [...active.order],
        folders: { ...active.folders },
      });
    } catch {
    }
  }
  const dir = path.join(conversationDir, folder);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
  }
  return dir;
}


export function syncStoredConversations(
  upsert: unknown[],
  removeIds: unknown[],
): StoredConversation[] {
  const map = ensureLoaded();
  const active = manifest!;
  const changed = new Set<string>();
  const removedFolders: string[] = [];

  for (const id of removeIds) {
    if (typeof id !== 'string') continue;
    if (map.delete(id)) changed.add(id);
    const folder = active.folders[id];
    if (folder) {
      delete active.folders[id];
      active.order = active.order.filter((entry) => entry !== id);
      removedFolders.push(folder);
    }
  }

  for (const entry of upsert) {
    if (!isStoredConversation(entry)) continue;
    stripAttachmentDataUrls(entry);
    if (JSON.stringify(entry).length > MAX_RECORD_JSON) continue;
    // (two paint passes of one run — the ghost-turn bug's root shape). The
    if (Array.isArray(entry.turns) && entry.turns.length > 1) {
      const seen = new Set<string>();
      let dirty = false;
      for (const turn of entry.turns) {
        const tid = typeof turn === 'object' && turn !== null ? (turn as { id?: unknown }).id : null;
        if (typeof tid === 'string') {
          if (seen.has(tid)) dirty = true;
          else seen.add(tid);
        }
      }
      if (dirty) {
        const kept: unknown[] = [];
        const pending = new Set(seen);
        for (const turn of entry.turns) {
          const tid = typeof turn === 'object' && turn !== null ? (turn as { id?: unknown }).id : null;
          if (typeof tid !== 'string') {
            kept.push(turn);
            continue;
          }
          if (!pending.has(tid)) continue;
          pending.delete(tid);
          kept.push(turn);
        }
        entry.turns = kept;
      }
    }
    const existing = map.get(entry.id);
    if (!existing) {
      map.set(entry.id, entry);
      changed.add(entry.id);
      continue;
    }
    if (!shouldAcceptSyncedEntry(entry, existing)) continue;
    map.set(entry.id, mergeSyncedConversation(entry, existing));
    changed.add(entry.id);
  }

  scheduleFlush(changed, removedFolders);
  return [...map.values()];
}


function turnOrderKey(turn: { createdAt?: unknown; role?: unknown }): [number, number] {
  const createdAt = typeof turn.createdAt === 'number' ? turn.createdAt : 0;
  const role = turn.role;
  const roleRank = role === 'user' ? 0 : role === 'assistant' ? 1 : 2;
  return [createdAt, roleRank];
}

function turnInsertIndex(turns: unknown[], incoming: { createdAt?: unknown; role?: unknown }): number {
  const key = turnOrderKey(incoming);
  let lo = 0;
  let hi = turns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midKey = turnOrderKey(turns[mid] as { createdAt?: unknown; role?: unknown });
    const cmp = midKey[0] !== key[0] ? midKey[0] - key[0] : midKey[1] - key[1];
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function applyTurnPatches(patches: unknown[]): void {
  const map = ensureLoaded();
  const changed = new Set<string>();

  for (const raw of patches) {
    if (typeof raw !== 'object' || raw === null) continue;
    const patch = raw as {
      conversationId?: unknown;
      turnId?: unknown;
      
      turn?: unknown;
    };
    if (typeof patch.conversationId !== 'string' || patch.conversationId.length === 0) continue;
    if (typeof patch.turnId !== 'string' || patch.turnId.length === 0) continue;
    const record = map.get(patch.conversationId);
    if (!record) continue;

    const turns = (Array.isArray(record.turns) ? record.turns : []) as unknown[];
    const index = turns.findIndex(
      (entry) => typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === patch.turnId,
    );

    if (patch.turn === null) {
      if (index === -1) continue;
      turns.splice(index, 1);
      record.turns = turns;
      changed.add(patch.conversationId);
      continue;
    }

    const turn = patch.turn;
    if (typeof turn !== 'object' || turn === null) continue;
    if (typeof (turn as { id?: unknown }).id !== 'string') continue;
    stripTurnPayloads(turn);
    if (JSON.stringify(turn).length > MAX_RECORD_JSON) continue;

    if (index === -1) turns.splice(turnInsertIndex(turns, turn as { createdAt?: unknown; role?: unknown }), 0, turn);
    else turns[index] = turn;
    record.turns = turns;
    changed.add(patch.conversationId);
  }

  scheduleFlush(changed, []);
}


const TRASH_DIR = 'trash';


const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function trashDir(): string {
  return path.join(conversationDir, TRASH_DIR);
}


function sweepTrash(): void {
  try {
    if (!existsSync(trashDir())) return;
    const cutoff = Date.now() - TRASH_MAX_AGE_MS;
    for (const entry of readdirSync(trashDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        if (statSync(path.join(trashDir(), entry.name)).mtimeMs < cutoff) {
          rmSync(path.join(trashDir(), entry.name), { recursive: true, force: true });
        }
      } catch {
      }
    }
  } catch {
  }
}


function moveToTrash(folder: string): void {
  const from = path.join(conversationDir, folder);
  if (!existsSync(from)) return;
  try {
    mkdirSync(trashDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(from, path.join(trashDir(), `${folder}-${stamp}`));
  } catch {
  }
}


function scheduleFlush(changed: Set<string>, removedFolders: string[]): void {
  const active = manifest!;
  mkdirSync(conversationDir, { recursive: true });
  for (const id of changed) {
    if (active.folders[id] || !cache?.has(id)) continue;
    const record = cache.get(id);
    const seq = active.nextSeq;
    active.nextSeq += 1;
    active.folders[id] = chatFolderName(
      seq,
      typeof record?.createdAt === 'number' ? record.createdAt : 0,
    );
    active.order.push(id);
  }

  const upserts = [...changed]
    .filter((id) => !removedFolders.includes(id) && active.folders[id])
    .map((id) => [id, active.folders[id]] as [id: string, folder: string]);
  const nextSeq = active.nextSeq;
  const order = [...active.order];
  const folders = Object.fromEntries(order.map((id) => [id, active.folders[id]]));

  writeChain = writeChain
    .then(() => {
      for (const [id, folder] of upserts) {
        const record = cache?.get(id);
        if (!record) continue;
        try {
          atomicWriteJson(path.join(conversationDir, folder, 'chat-data.json'), record);
        } catch {
        }
      }
      for (const folder of removedFolders) {
        moveToTrash(folder);
      }
      atomicWriteJson(MANIFEST_FILE, { version: 1, nextSeq, order, folders });
      atomicWriteJson(INDEX_FILE, buildIndex());
    })
    .catch(() => {
    });
}


export function flushConversationWrites(): Promise<void> {
  return writeChain;
}


export interface TrashEntry {
  
  id: string;
  
  folder: string;
  title: string;
  updatedAt: number;
  turnCount: number;
  
  deletedAt: number;
}


function splitTrashFolder(folder: string): { original: string; id: string | null } | null {
  const match = /^((chat-\d{3,})-\d{8})-/.exec(folder);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(trashDir(), folder, 'chat-data.json'), 'utf8'),
    );
    if (isStoredConversation(parsed)) return { original: match[1], id: parsed.id };
  } catch {
  }
  return { original: match[1], id: null };
}


export function listTrash(): TrashEntry[] {
  sweepTrash();
  const entries: TrashEntry[] = [];
  try {
    if (!existsSync(trashDir())) return entries;
    for (const entry of readdirSync(trashDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(path.join(trashDir(), entry.name, 'chat-data.json'), 'utf8'),
        );
        if (!isStoredConversation(parsed)) continue;
        entries.push({
          id: parsed.id,
          folder: entry.name,
          title: typeof parsed.title === 'string' ? parsed.title : 'Untitled',
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
          turnCount: Array.isArray(parsed.turns) ? parsed.turns.length : 0,
          deletedAt: statSync(path.join(trashDir(), entry.name)).mtimeMs,
        });
      } catch {
      }
    }
  } catch {
  }
  return entries.sort((a, b) => b.deletedAt - a.deletedAt);
}


export function restoreFromTrash(folder: string): string | null {
  if (!/^([\w.-]+)$/.test(folder)) return null;
  const from = path.join(trashDir(), folder);
  if (!existsSync(from)) return null;
  const split = splitTrashFolder(folder);
  if (!split) return null;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(from, 'chat-data.json'), 'utf8'),
    );
    if (!isStoredConversation(parsed)) return null;
    ensureLoaded();
    const active = manifest!;
    const map = cache!;
    let target = split.original;
    if (existsSync(path.join(conversationDir, target)) || Object.values(active.folders).includes(target)) {
      target = chatFolderName(active.nextSeq, typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now());
      active.nextSeq += 1;
      while (existsSync(path.join(conversationDir, target))) {
        target = chatFolderName(active.nextSeq, typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now());
        active.nextSeq += 1;
      }
    }
    renameSync(from, path.join(conversationDir, target));
    active.folders[parsed.id] = target;
    active.order.push(parsed.id);
    active.order.sort((a, b) => {
      const seqA = Number(CHAT_DIR_RE.exec(active.folders[a] ?? '')?.[1] ?? 0);
      const seqB = Number(CHAT_DIR_RE.exec(active.folders[b] ?? '')?.[1] ?? 0);
      return seqA - seqB;
    });
    map.set(parsed.id, parsed);
    scheduleFlush(new Set([parsed.id]), []);
    return parsed.id;
  } catch {
    return null;
  }
}


export function emptyTrash(): number {
  sweepTrash();
  let removed = 0;
  try {
    if (!existsSync(trashDir())) return 0;
    for (const entry of readdirSync(trashDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        rmSync(path.join(trashDir(), entry.name), { recursive: true, force: true });
        removed += 1;
      } catch {
      }
    }
  } catch {
  }
  return removed;
}
