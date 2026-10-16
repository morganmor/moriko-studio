import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './atomicWrite.js';
import { appDataDir, conversationDir, conversationIndexFile, conversationManifestFile } from './paths.js';
import { migrateAttachmentDataUrls, stripAttachmentDataUrls, stripTurnPayloads, INLINE_DATA_URL_LIMIT, putBytes } from './attachmentStore.js';

/**
 * CONVERSATION STORE — one shared chat history for every browser, archived
 * one chat per folder.
 *
 * Conversations used to live ONLY in the browser's localStorage, so Chrome
 * and Firefox (and every profile/incognito window) each showed a different —
 * private — history. The proxy is the single process every browser already
 * talks to and already persists to `.data/`, so the shared truth moved here.
 *
 * Layout (see paths.ts):
 *
 *   .data/conversation/
 *   ├── index.json          — summaries (id, title, updatedAt, rev, turnCount, preview)
 *   ├── manifest.json       — { version, nextSeq, order, folders: { id → dir } }
 *   ├── chat-001-20260919/
 *   │   ├── chat-data.json  — the full conversation record (turns…)
 *   │   └── goals-plan.json — this session's agent goals (see goals/store)
 *   └── chat-002-20260920/…
 *
 * Rewriting ONE multi-megabyte JSON file on every sync is gone: a sync now
 * writes only the chats it touched, plus the two small index files.
 *
 * The browser keeps its localStorage copy only as an instant-boot cache.
 * Sync is PER CONVERSATION (upsert by id + explicit deletions), so two
 * browsers editing different chats never overwrite each other's history.
 *
 * Records are opaque JSON — the client owns the `Conversation` shape; this
 * module only validates what the merge needs (string id, turns array) and
 * writes atomically (tmp + rename, one write at a time).
 */

const INDEX_FILE = conversationIndexFile;
const MANIFEST_FILE = conversationManifestFile;
const LEGACY_ARCHIVE = path.join(appDataDir, 'conversations.json');

/** Anything the client pushed that survived validation. */
export type StoredConversation = { id: string } & Record<string, unknown>;

/** Oversized single-chat guard (base64 attachments inflate turns). */
const MAX_RECORD_JSON = 24_000_000;

/** Structural truth for the chat archive: order, folder mapping, next seq. */
interface ManifestFile {
  version: 1;
  /** Next chat sequence number for NEW chat folder names. */
  nextSeq: number;
  /** Authoritative chat order (folder sequence order). */
  order: string[];
  /** conversation id → folder name under .data/conversation/. */
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

/** `chat-003-20260920` — padded sequence + the chat's creation date (local). */
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

/**
 * Adopts chat folders that exist on disk but not in the manifest (a crashed
 * write, or a folder left behind by an older run): their chat-data.json holds
 * the record, and the folder name carries the sequence number.
 */
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

/**
 * First-access migration: the pre-restructure single-file archive
 * (`.data/conversations.json`) is split into the per-chat layout and the
 * original is parked as `.migrated` (never deleted). Runs once.
 */
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
/** Serializes disk writes so two syncs can never interleave a partial file. */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Synchronous ON PURPOSE: the sync merge compares FULL records, and the
 * goals store needs the chat folder map without an await (its own writes are
 * sync persists). One boot-time read of small JSON files costs nothing.
 */
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

/**
 * VISUAL v2 — SERVER-SIDE EDIT-IN-PLACE. Replaces one stored visual payload
 * (matched by id) across every turn of a conversation record and flushes the
 * record to disk. This is what makes `render_visual` with `id` a true
 * update-in-place: the store never grows a second card, the new html rides
 * under the SAME id, and every client re-binds on its next hydration.
 *
 * Externalization follows the byte-store rule (>= INLINE_DATA_URL_LIMIT →
 * htmlRef), so an edit can move a payload inline ⇄ external without
 * corrupting the record. Returns false when the id is unknown to THIS
 * conversation — the tool then fails fast with the list of stored ids.
 */
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

/** The stored ids of every visual in one conversation (newest first). */
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

/** Summaries for every chat — the list view never needs the turn bodies. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId?: string;
  model?: string;
  /** 6A: the agent workspace this chat is bound to (sidebar grouping). */
  workspaceId?: string;
  /** COUNCIL (Council Agent addon): sub sessions carry their container's id. */
  councilId?: string;
  councilRole?: 'main' | 'sub';
  councilAgentId?: string;
  /** Monotonic client mutation counter — newer-wins tiebreak on merge. */
  rev?: number;
  turnCount: number;
  /** First ~120 chars of the newest turn — the sidebar's preview line. */
  preview: string;
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
  };
}

export function listStoredConversations(): StoredConversation[] {
  return [...ensureLoaded().values()];
}

/** Summaries for every chat — the list view never needs the turn bodies. */
export function listStoredConversationSummaries(): ConversationSummary[] {
  return [...ensureLoaded().values()].map(summarizeConversation);
}

/** One full record by id (null when absent) — the thread loads a chat on demand. */
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

/**
 * The chat's own folder under `.data/conversation/`, or null when this
 * session has no archived chat (synthetic ids, a chat not yet synced).
 * Shared with the goals store, which files this session's goals-plan.json
 * inside the folder.
 */
export function chatDirFor(sessionId: string): string | null {
  ensureLoaded();
  const folder = manifest?.folders[sessionId];
  return folder ? path.join(conversationDir, folder) : null;
}

/**
 * The chat's own folder, CREATED on demand: a brand-new chat has no folder
 * until its first sync flush, but attachments (and anything else filing
 * under the chat's session directory) must have a home IMMEDIATELY — the
 * upload arrives before the record is ever persisted. Allocating here keeps
 * the manifest authoritative and reuses the same folder once the record
 * flushes (scheduleFlush keeps an existing mapping).
 */
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

/**
 * Applies one client sync batch — upserts replace by id (an existing chat
 * keeps its position), removeIds move the chat to the trash (never a delete;
 * see moveToTrash) — and returns the authoritative list AFTER the merge, so
 * the sender converges with edits made elsewhere.
 *
 * `removeIds` is authoritative ONLY because the client now sends it solely for
 * the user's own deletions: it used to be computed as "the server holds this
 * and I do not", which let a boot whose body fetches failed order a wipe of
 * everything it had not managed to load.
 */
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
    const incomingAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : null;
    const existingAt = typeof existing.updatedAt === 'number' ? existing.updatedAt : null;
    if (incomingAt !== null && existingAt !== null && incomingAt > existingAt) {
      map.set(entry.id, entry);
      changed.add(entry.id);
      continue;
    }
    if (incomingAt !== null && existingAt !== null && incomingAt < existingAt) continue;
    // delete → …) — the reported "pesan terhapus lalu muncul lagi" bug.
    const incomingRev = typeof entry.rev === 'number' && Number.isFinite(entry.rev) ? entry.rev : null;
    const existingRev = typeof existing.rev === 'number' && Number.isFinite(existing.rev) ? existing.rev : null;
    if (incomingRev !== null && existingRev !== null && incomingRev !== existingRev) {
      if (incomingRev < existingRev) continue;
      map.set(entry.id, entry);
      changed.add(entry.id);
      continue;
    }
    if (incomingRev !== null && existingRev === null) {
      map.set(entry.id, entry);
      changed.add(entry.id);
      continue;
    }
    if (incomingRev === null && existingRev !== null) continue;
    const incomingTurns = Array.isArray(entry.turns) ? entry.turns.length : -1;
    const existingTurns = Array.isArray(existing.turns) ? existing.turns.length : -1;
    if (incomingTurns < existingTurns) continue;
    map.set(entry.id, entry);
    changed.add(entry.id);
  }

  scheduleFlush(changed, removedFolders);
  return [...map.values()];
}

/**
 * Applies INCREMENTAL turn patches for LIVE chats: each patch replaces or
 * inserts ONE turn by id inside a record the store already holds, so a run's
 * in-flight text reaches the shared store WITHOUT re-uploading the whole
 * multi-megabyte conversation on every client sync debounce.
 *
 * The store stays AUTHORITATIVE for in-flight turns this way: a browser that
 * never saw the stream (or a reload once the SSE replay buffer is gone)
 * reads the live partial straight from the record instead of the pre-run
 * thread. This replaces the client-side stream suppression, which skipped
 * generating chats entirely and left the server arbitrarily behind.
 *
 * A patch for an UNKNOWN conversation is dropped: the record must exist first
 * (the run-start full upsert creates it). Patches are idempotent — replacing
 * a turn by id with an older copy is harmless because the sender is the sole
 * writer of that turn for the run's duration.
 *
 * The record's own `rev` is deliberately NOT touched: a patch carries only
 * turns, and `deleteTurn` bumps rev WITHOUT updatedAt. Adopting the patch rev
 * would let it TIE the run-end full upsert on (updatedAt, rev), and the
 * turn-count heuristic below would then read the deletion as a stale copy and
 * RESURRECT the deleted turns — the exact bug the rev discipline exists to
 * prevent. The server's summary keeps the pre-run rev while its turnCount
 * climbs, which is all a second browser needs to see the record as newer
 * (its stale local copy fails localMatchesSummary on the count and fetches
 * the live body).
 */
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
      /** null = delete this turn id (mid-run regenerate must reach the server). */
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

/** Where a deleted chat's folder goes. Restore & purge live in the trash API. */
const TRASH_DIR = 'trash';

/** Trash entries older than this are swept on boot and on every trash read.
 *  User decision: bekas percakapan di folder trash dihapus otomatis setelah
 *  30 hari — purga berjalan best-effort, kegagalan disk tidak pernah fatal. */
const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function trashDir(): string {
  return path.join(conversationDir, TRASH_DIR);
}

/** Removes trash folders older than 30 hari — boot + tiap listTrash. */
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

/**
 * NEVER DESTROY A CHAT. A removed record leaves the manifest — so it is gone
 * from every list, every wire, and every browser — but its folder MOVES to
 * `conversation/trash/<folder>-<stamp>` instead of being deleted. Restore
 * (`restoreFromTrash`) and the 30-day purge (`sweepTrash`) live in the trash
 * API; `emptyTrash` is the manual cleanup.
 *
 * This store is the only copy of the user's history: the browser keeps no
 * durable record and there is no backup. An archive that can shrink from ~123
 * chats to 2 with no error anywhere (its `nextSeq` read 124 while two folders
 * were left on disk) is the reason recovery must not depend on having
 * predicted the failure. The trash is never scanned — `adoptOrphanFolders`
 * only re-adopts `chat-NNN-*` folders at the archive root — so a trashed chat
 * stays out of every list until it is restored explicitly.
 */
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

/**
 * Assigns (or keeps) a folder per changed chat, then queues ONE serialized
 * disk pass: per-chat records first (a crash between them and the index
 * rewrite can only orphan a folder, which boot re-adopts — never lose a
 * record), removed folders to the trash, then manifest + index rewritten.
 */
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

/** Awaits every queued disk write (tests / shutdown; routes don't need it). */
export function flushConversationWrites(): Promise<void> {
  return writeChain;
}

/**
 * TRASH API — list, restore, empty. A trashed chat is a folder under
 * `conversation/trash/` (`chat-NNN-YYYYMMDD-<stamp>`) holding its original
 * chat-data.json. The stamp splits id → folder: the FIRST `chat-NNN-*` run is
 * the original folder name, the trailing ISO stamp belongs to the deletion.
 */
export interface TrashEntry {
  /** Conversation id (parsed from the folder name). */
  id: string;
  /** Trash folder name (used by restore/empty). */
  folder: string;
  title: string;
  updatedAt: number;
  turnCount: number;
  /** Deletion time (the folder's mtime) — ms epoch. */
  deletedAt: number;
}

/** Parses `chat-012-20261005-2026-10-07T...` → original folder + stamp. */
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

/** Every trashed chat, newest deletion first. Sweeps >30-day entries first. */
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

/** Moves one trash folder back into the archive and re-registers it in the
 *  manifest. Returns the restored id (null when the folder is unreadable). */
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

/** Manual cleanup: deletes EVERY trash folder. Returns how many were removed. */
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
