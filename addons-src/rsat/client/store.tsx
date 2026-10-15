/**
 * RSA/T shared board store — versi backend penuh.
 * Sumber kebenaran: rpc('state') (server engine, persist ke
 * .moriko/rsat/prd.rsprd.json). Setiap aksi → rpc → SSE 'rsat.changed'
 * → refresh. Tanpa SEED/demo: PRD & quest dibuat user/agent lewat form.
 * Inventory (file ledger) dari rpc('files') — readAllLedgers server.
 */
import { useEffect, useState } from 'react';
import { rpc } from './shared.tsx';
import { toast } from './toast.tsx';
import { fromServerState } from './rsprd.ts';
import { useAddonBus } from '@moriko/host';

export type Claim = { by: string; at: string; beat: number; sid?: string; ag?: string | null };
export type Cmt = { by: string; t: string; at: string };
export type ScopeReq = { op: string; path: string; by: string; at: string; approved: boolean; why?: string };
export type FileRow = { p: string; op: string; s: string; by: string; at: string; pending: boolean; from?: string };
export type Ach = {
  id: string; no: number; title: string; kind: string; tier: string; pts: number; state: string;
  dep: string[]; tags: string[]; desc: string; tech: string;
  scope: { inc: string[]; exc: string[]; max: number; create: boolean; del: boolean };
  ac: Array<{ t: string; d: boolean }>;
  claim: Claim | null; cm: Cmt[]; sc: ScopeReq[]; files: FileRow[];
  acId?: string[];
  moduleId?: string; milestoneId?: string;
  contracts?: { provides: string[]; consumes: string[] };
};
export type Prd = {
  id: string; title: string; summary: string; status: string;
  inc: string[]; exc: string[]; cons: Array<{ t: string; m: string }>; goals: string[];
  createdAt: string;
  architecture?: string;
  modules?: Array<{ id: string; name: string; desc: string; inc: string[]; exc: string[]; layer?: string; allowedImports?: string[] }>;
  milestones?: Array<{ id: string; title: string; goal: string }>;
  nonFunctional?: Array<{ id: string; text: string; metric: string }>;
  risks?: Array<{ id: string; text: string; mitigation: string; severity: string }>;
  technicalDecisions?: Array<{ text: string; reason: string }>;
};
export type FeedItem = { ic: string; at: number; text: string };
export type Presence = { sessionId: string; model: string | null; label: string; isSelf?: boolean; agentId?: string | null };
export type BoardState = {
  /** true setelah rpc('state') pertama berhasil (mencegah kedip LangGate). */
  ready: boolean;
  language: string;
  prd: Prd | null;
  achs: Ach[];
  feed: FeedItem[];
  injected: { text: string; n: number; at: number } | null;
  presence: Presence[];
  guardMode: string;
  claimTtlSec: number;
  ilQuality: string;
  displayName: string;
  workspacePath: string | null;
};

/** State kosong — papan baru sampai rpc('state') kembali. */
const EMPTY: BoardState = {
  ready: false,
  language: '', prd: null, achs: [], feed: [], injected: null,
  presence: [], guardMode: 'advisory', claimTtlSec: 900, ilQuality: 'high', displayName: 'Rizky', workspacePath: null,
};

/* ── state + subscription ────────────────────────────────────────────────── */
let state: BoardState = EMPTY;
let loadSeq = 0;
const subs = new Set<() => void>();
const set = (fn: (s: BoardState) => BoardState) => {
  state = fn(state);
  for (const f of subs) f();
};
export const getRsat = (): BoardState => state;

/** Alias untuk board.tsx: muat awal + ikut event SSE. */
export const initRsat = refresh;
export const refreshRsat = refresh;

/** Event audit server (events.jsonl) → baris feed panel Live. */
const EV_ICON: Record<string, string> = {
  claimed: 'flag', completed: 'check', released: 'x', dropped: 'trash',
  progress: 'activity', review_requested: 'send', review_accepted: 'check',
  review_rejected: 'refactor', prd_created: 'plus', prd_updated: 'file-edit',
  achievement_created: 'plus', achievement_deleted: 'trash', restored: 'refactor',
  scope_change: 'shield', scope_approved: 'check', imported: 'upload',
  language_set: 'gear', commented: 'send', acceptance_marked: 'check',
};
function eventLine(o: Record<string, unknown>): FeedItem | null {
  const type = String(o.type ?? '');
  if (!type) return null;
  const at = Number(new Date(String(o.at ?? '')).valueOf()) || Date.now();
  const byRec = (o.by && typeof o.by === 'object' ? o.by : {}) as Record<string, unknown>;
  const by = byRec.kind === 'user' ? 'U' : String(byRec.label ?? byRec.name ?? byRec.kind ?? 'someone');
  const target = String(o.target ?? 'prd');
  return { ic: EV_ICON[type] ?? 'bell', at, text: `*${by}* · ${type.replace(/_/g, ' ')} *${target}*` };
}

/** Ledger file (rpc 'files' — readAllLedgers server) → Map quest → FileRow[]. */
function ledgersByQuest(files: unknown[]): Map<string, FileRow[]> {
  const map = new Map<string, FileRow[]>();
  for (const l of files) {
    const o = l && typeof l === 'object' ? (l as Record<string, unknown>) : {};
    const qid = String(o.achievementId ?? '');
    const p = String(o.path ?? '');
    if (!qid || !p) continue;
    const row: FileRow = {
      p,
      op: String(o.op ?? 'modify'),
      s: String(o.summary ?? ''),
      by: String((o.by as Record<string, unknown> | undefined)?.label ?? (o.by as Record<string, unknown> | undefined)?.sessionId ?? 'agent'),
      at: String(o.at ?? new Date().toISOString()),
      pending: !String(o.summary ?? ''),
      ...(o.from ? { from: String(o.from) } : {}),
    };
    const list = map.get(qid) ?? [];
    list.push(row);
    map.set(qid, list);
  }
  return map;
}

/** Event audit server → baris feed (helper — keeps refresh below the limit). */
function feedLines(events: unknown[]): FeedItem[] {
  const feed: FeedItem[] = [];
  for (const e of events) {
    const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    const line = eventLine(o);
    if (line) feed.push(line);
  }
  return feed;
}

/** Muat ulang penuh dari server (rpc 'state' + 'events' + 'files'). */
export async function refresh(): Promise<void> {
  const seq = ++loadSeq;
  try {
    const [st, ev, fl] = await Promise.all([
      rpc('state', {}) as Promise<Record<string, unknown>>,
      rpc('events', { limit: 120 }) as Promise<Record<string, unknown>>,
      rpc('files', { limit: 500 }) as Promise<Record<string, unknown>>,
    ]);
    if (seq !== loadSeq) return; // load lebih baru sudah menang
    const s = fromServerState(st ?? {});
    const events = Array.isArray(ev?.events) ? ev.events.slice(-60) : [];
    const feed = feedLines(events);
    // Quest TANPA ledger → files kosong; quest dengan ledger → baris rpc files.
    const filesByQuest = ledgersByQuest(Array.isArray(fl?.files) ? fl.files : []);
    set((prev) => ({
      ...prev,
      ready: true,
      language: s.language,
      prd: s.prd,
      achs: s.achs.map((a) => ({ ...a, files: filesByQuest.get(a.id) ?? [] })),
      presence: s.presence,
      guardMode: s.guardMode,
      claimTtlSec: s.claimTtlSec,
      ilQuality: s.ilQuality,
      displayName: s.displayName,
      workspacePath: s.workspacePath,
      injected: s.lastInject,
      feed: feed.length ? [...prev.feed, ...feed].slice(-80) : prev.feed,
    }));
  } catch (err) {
    toast('error', 'Board load failed', err instanceof Error ? err.message : 'RPC state error.');
  }
}

export function useRsat(): BoardState {
  const [snap, setSnap] = useState(state);
  useEffect(() => {
    const cb = () => setSnap(state);
    subs.add(cb);
    setSnap(state);
    if (!state.ready) void refresh();
    return () => { subs.delete(cb); };
  }, []);
  // SSE: setiap board event server (bus 'rsat.changed') → refresh penuh.
  const frame = useAddonBus('rsat.changed');
  useEffect(() => {
    if (frame) void refresh();
  }, [frame]);
  return snap;
}

/* ── derived (dipakai bersama semua panel) ───────────────────────────────── */
export const byId = (list: Ach[], id: string) => list.find((a) => a.id === id);
export const depsDone = (list: Ach[], a: Ach) => a.dep.every((d) => byId(list, d)?.state === 'done');
export const eff = (list: Ach[], a: Ach) =>
  a.state === 'locked' || a.state === 'available' ? (depsDone(list, a) ? 'available' : 'locked') : a.state;
export const prog = (a: Ach) =>
  a.state === 'done' ? 100 : a.ac.length ? Math.round((a.ac.filter((c) => c.d).length / a.ac.length) * 100) : 0;
export const isStale = (a: Ach, now: number) =>
  !!a.claim && now - a.claim.beat > (state.claimTtlSec || 900) * 1000;

/** Jendela heartbeat (ms) untuk komponen Hearts. */
export const ttlMs = () => (state.claimTtlSec || 900) * 1000;

/** Nama aktor aman untuk tampilan. */
export const who = (b: string) => (b === 'U' ? `${state.displayName} (user)` : b);

/** Jalankan RPC + refresh + pesan error ber-tanda. */
async function call(name: string, body: Record<string, unknown>, okMsg?: string): Promise<Record<string, unknown> | null> {
  try {
    const out = (await rpc(name, body)) as Record<string, unknown> | null;
    void refresh();
    if (okMsg) toast('ok', okMsg, '');
    return out ?? {};
  } catch (err) {
    toast('error', `${name} failed`, err instanceof Error ? err.message : 'The board engine refused.');
    return null;
  }
}

/* ── aksi terpusat → RPC server ─────────────────────────────────────────── */

/** LangGate: pilihan bahasa persisten (consent eksplisit). */
export function setLang(language: string) {
  const lang = language === 'id' ? 'id' : 'en';
  set((s) => ({ ...s, language: lang }));
  void call('setLanguage', { language: lang });
}

/** PRD payload → fields rpc createPrd/updatePrd (server shape). */
export type PrdFields = {
  title: string; summary: string; inc: string[]; exc: string[];
  cons: Array<{ t: string; m: string }>; goals: string[];
  architecture?: string;
  modules?: Array<{ id: string; name: string; desc: string; inc: string[]; exc: string[]; layer?: string; allowedImports?: string[] }>;
  milestones?: Array<{ id: string; title: string; goal: string }>;
  nonFunctional?: Array<{ id: string; text: string; metric: string }>;
  risks?: Array<{ id: string; text: string; mitigation: string; severity: string }>;
  technicalDecisions?: Array<{ text: string; reason: string }>;
};

/** Buat PRD baru (rpc createPrd) — hanya kalau belum ada. */
export function createPrd(fields: PrdFields, language: string) {
  void call('createPrd', {
    title: fields.title, summary: fields.summary, language,
    goals: fields.goals, globalScope: { include: fields.inc, exclude: fields.exc },
    constraints: fields.cons.map((c) => ({ text: c.t, mode: c.m })),
    architecture: fields.architecture,
    modules: fields.modules,
    milestones: fields.milestones,
    nonFunctional: fields.nonFunctional,
    risks: fields.risks,
    technicalDecisions: fields.technicalDecisions,
  }, 'PRD created');
}

/** Edit PRD (rpc updatePrd) — title/scope/goals/constraints; status lewat togglePrd. */
export function updatePrd(fields: PrdFields) {
  void call('updatePrd', {
    fields: {
      title: fields.title, summary: fields.summary, goals: fields.goals,
      globalScope: { include: fields.inc, exclude: fields.exc },
      constraints: fields.cons.map((c) => ({ text: c.t, mode: c.m })),
      architecture: fields.architecture,
      modules: fields.modules,
      milestones: fields.milestones,
      nonFunctional: fields.nonFunctional,
      risks: fields.risks,
      technicalDecisions: fields.technicalDecisions,
    },
  }, 'PRD updated');
}

/** Start/Pause/Resume PRD — status global, user-only (RSAT.txt 6.4). */
export function togglePrd() {
  const { prd } = getRsat();
  if (!prd) return;
  const name = prd.status === 'running' ? 'pause' : 'start';
  void call(name, {});
}

/** Quest baru (rpc createAchievement — engine yang menentukan id/no/state). */
export function createQuest(q: {
  title: string; kind: string; tier: string; pts: number; dep: string[];
  desc: string; tech: string; ac: string[]; inc: string[];
  provides?: string[]; consumes?: string[];
}) {
  void call('createAchievement', {
    title: q.title, kind: q.kind, tier: q.tier, points: q.pts,
    dependsOn: q.dep, description: q.desc, technical: q.tech,
    acceptance: q.ac, scope: { include: q.inc, exclude: [] },
    contracts: { provides: q.provides ?? [], consumes: q.consumes ?? [] },
    tags: [],
  }, `${q.title} created`);
}

/** Toggle satu acceptance box (rpc toggleAcceptance; acId dari server). */
export function toggleAcceptance(id: string, index: number, done: boolean) {
  const a = byId(getRsat().achs, id);
  const acId = a?.acId?.[index] ?? `ac${index + 1}`;
  void call('toggleAcceptance', { id, acceptanceId: acId, done });
}

/** Aksi quest (drawer): claim/reviewAccept/reviewReject/release/drop/restore. */
export function questAction(name: string, id: string, reason = ''): void {
  const map: Record<string, () => void> = {
    claim: () => void call('claim', { id }, `${id} claimed`),
    beat: () => void call('progress', { id, note: 'Progress heartbeat from the board' }),
    submit: () => void call('complete', { id, reason: 'Submitted from the board' }, `${id} done`),
    approve: () => void call('reviewAccept', { id }, `${id} marked done`),
    reopen: () => void call('reviewReject', { id, reason: reason || 'Needs more work' }),
    release: () => void call('release', { id, reason: reason || 'released from the board' }),
    takeover: () => void call('release', { id, reason: 'taken over by the user (stale claim)' }),
    drop: () => void call('drop', { id, reason: reason || 'dropped from the board' }),
    restore: () => void call('restoreAchievement', { id }, `${id} restored`),
    delete: () => void call('deleteAchievement', { id }, `${id} deleted`),
  };
  map[name]?.();
}

/** Scope change (widen/narrow) — rpc changeScope. */
export function changeScope(id: string, op: 'widen' | 'narrow', paths: string[], reason: string) {
  void call('changeScope', { id, op, paths, reason });
}

/** Approve pending scope request (strict mode, user). */
export function approveScope(id: string, index: number) {
  void call('approveScope', { id, index });
}

/** Guard test (drawer Scope tab) — rpc guardTest, tanpa write. */
export async function guardTest(id: string, path: string): Promise<{ ok: boolean; reason: string; holder: string | null } | null> {
  try {
    const r = (await rpc('guardTest', { id, path })) as Record<string, unknown> | null;
    return r ? { ok: Boolean(r.ok), reason: String(r.reason ?? ''), holder: (r.holder as string | null) ?? null } : null;
  } catch (err) {
    toast('error', 'Guard test failed', err instanceof Error ? err.message : 'RPC error.');
    return null;
  }
}

/** Komentar (quest atau PRD — id 'prd'). */
export function comment(id: string, text: string) {
  void call('comment', { id, text });
}

/** Ringkasan satu baris untuk file ledger quest (rpc setFileSummary). */
export function setFileSummary(id: string, path: string, summary: string) {
  void call('setFileSummary', { id, path, summary });
}

/** Import RS-PRD (rpc importDoc: dry-run lalu apply merge/replace). */
export async function importDoc(content: string): Promise<boolean> {
  try {
    const dry = (await rpc('importDoc', { content })) as Record<string, unknown> | null;
    if (!dry || dry.dryRun !== true) {
      toast('error', 'Import failed', 'Unexpected server response.');
      return false;
    }
    const conflicts = Array.isArray(dry.conflicts) ? dry.conflicts.length : Number(dry.conflicts ?? 0) || 0;
    const mode = conflicts > 0 ? 'replace' : 'merge';
    const apply = await rpc('importDoc', { content, mode }) as Record<string, unknown> | null;
    if (!apply) {
      toast('error', 'Import failed', 'The engine refused the import.');
      return false;
    }
    toast('ok', 'PRD imported', `${String(dry.total ?? '?')} achievements · mode ${mode}`);
    void refresh();
    return true;
  } catch (err) {
    toast('error', 'Import failed', err instanceof Error ? err.message : 'Unreadable file.');
    return false;
  }
}

/** Danger zone (user-only): hapus PRD + ledger (arsip tersimpan server). */
export function deletePrd() {
  void call('deletePrd', {}, 'PRD deleted — create a new one in Base camp');
}

/** Guard mode (Options) — rpc setGuard. */
export function setGuard(mode: string) {
  set((s) => ({ ...s, guardMode: mode }));
  void call('setGuard', { mode });
}

/** Heartbeat timeout (menit) — rpc setTtl. */
export function setTtl(minutes: number) {
  void call('setTtl', { minutes });
}

/** Graphics quality Interlinked (Options) — rpc setIlQuality. */
export function setIlQuality(q: string) {
  set((s) => ({ ...s, ilQuality: q }));
  void call('setIlQuality', { q });
}

export const nextQuestNo = (list: Ach[]) => list.reduce((m, a) => Math.max(m, a.no), 0) + 1;
