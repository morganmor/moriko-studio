/**
 * RS-PRD v1 — serializer/parser frontend. Format ID/version sama dengan
 * server/model.ts (format:'rs-prd', version:1) supaya file bisa dipakai
 * lintas project & sesi percakapan (RSAT.txt butir 4).
 */
import type { Ach, Prd } from './store.tsx';

export const FORMAT_ID = 'rs-prd';
export const FORMAT_VERSION = 1;

const STATES = ['locked', 'available', 'claimed', 'in_progress', 'review', 'done', 'blocked', 'dropped'];
const TIERS = ['bronze', 'silver', 'gold', 'diamond'];

const str = (v: unknown, fb = '') => (typeof v === 'string' ? v : fb);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strList = (v: unknown, fb: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fb;
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Nama aktor: string atau objek actor {kind,name} dari dokumen server. */
const name = (v: unknown): string => {
  if (typeof v === 'string') return v;
  const o = rec(v);
  return str(o.name) || str(o.kind) || '?';
};

/* ── serialize ───────────────────────────────────────────────────────────── */

function toDocAch(a: Ach) {
  return {
    id: a.id, no: a.no, title: a.title, kind: a.kind, tier: a.tier, points: a.pts, state: a.state,
    description: a.desc, technical: a.tech, tags: a.tags, dependsOn: a.dep,
    moduleId: a.moduleId, milestoneId: a.milestoneId,
    contracts: a.contracts ?? { provides: [], consumes: [] },
    acceptance: a.ac.map((c, i) => ({ id: `${a.id}-ac${i + 1}`, text: c.t, done: c.d })),
    scope: {
      include: a.scope.inc, exclude: a.scope.exc, maxFiles: a.scope.max,
      allowCreate: a.scope.create, allowDelete: a.scope.del,
    },
    claim: a.claim
      ? { by: { kind: a.claim.by === 'U' ? 'user' : 'agent', name: a.claim.by }, at: a.claim.at, beat: a.claim.beat }
      : null,
    comments: a.cm.map((c) => ({ by: { kind: c.by === 'U' ? 'user' : 'agent', name: c.by }, text: c.t, at: c.at })),
    scopeRequests: a.sc,
    ledger: a.files.map((f) => ({ path: f.p, op: f.op, summary: f.s, by: f.by, at: f.at, from: f.from })),
  };
}

/** State board → dokumen RS-PRD v1 utuh (untuk unduhan export). */
export function toDoc(s: { language: string; prd: Prd; achs: Ach[] }) {
  return {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    rev: 0,
    prd: {
      id: s.prd.id, title: s.prd.title, summary: s.prd.summary, status: s.prd.status,
      createdAt: s.prd.createdAt, createdBy: { kind: 'user', name: 'Rizky' },
      language: s.language || 'en',
      goals: s.prd.goals, nonGoals: [],
      constraints: s.prd.cons.map((c) => ({ text: c.t, mode: c.m })),
      globalScope: { include: s.prd.inc, exclude: s.prd.exc },
      architecture: s.prd.architecture ?? '',
      modules: (s.prd.modules ?? []).map((m) => ({
        id: m.id, name: m.name, desc: m.desc,
        layer: m.layer, allowedImports: m.allowedImports,
        scope: { include: m.inc, exclude: m.exc },
      })),
      milestones: (s.prd.milestones ?? []).map((m) => ({ id: m.id, title: m.title, goal: m.goal })),
      nonFunctional: (s.prd.nonFunctional ?? []).map((n) => ({ id: n.id, text: n.text, metric: n.metric })),
      risks: (s.prd.risks ?? []).map((r) => ({ id: r.id, text: r.text, mitigation: r.mitigation, severity: r.severity })),
      technicalDecisions: (s.prd.technicalDecisions ?? []).map((td) => ({ text: td.text, reason: td.reason })),
    },
    achievements: s.achs.map(toDocAch),
    history: [],
  };
}

/* ── parse + normalisasi (baca format server & format board lama) ────────── */

/** op ledger server (add|modify|delete|rename|copy) → kode pendek board. */
const OPC: Record<string, string> = { add: 'add', modify: 'mod', delete: 'del', rename: 'ren', copy: 'ref' };

function fromDocAch(x: Record<string, unknown>, i: number): Ach {
  const scope = rec(x.scope);
  const claim = rec(x.claim);
  const ac = arr(x.acceptance ?? x.ac).map((c) => {
    const o = typeof c === 'string' ? { t: c } : rec(c);
    return { t: str(o.t ?? o.text), d: Boolean(o.d ?? o.done) };
  }).filter((c) => c.t);
  const files = arr(x.ledger ?? x.files).map((f) => {
    const o = rec(f);
    const s = str(o.s ?? o.summary);
    return {
      p: str(o.p ?? o.path), op: OPC[str(o.op)] ?? 'mod', s, by: name(o.by), at: str(o.at),
      pending: o.pending != null ? Boolean(o.pending) : !s,
      ...(o.from ? { from: str(o.from) } : {}),
    };
  }).filter((f) => f.p);
  return {
    id: str(x.id, `A-${String(i + 1).padStart(3, '0')}`),
    no: Number(x.no) || i + 1,
    title: str(x.title, 'Untitled quest'),
    kind: str(x.kind, 'feature'),
    tier: TIERS.includes(str(x.tier)) ? str(x.tier) : 'bronze',
    pts: Number(x.points ?? x.pts) || 10,
    state: STATES.includes(str(x.state)) ? str(x.state) : 'available',
    dep: strList(x.dependsOn ?? x.dep, []),
    tags: strList(x.tags, []),
    desc: str(x.description ?? x.desc),
    tech: str(x.technical ?? x.tech),
    moduleId: str(x.moduleId) || undefined,
    milestoneId: str(x.milestoneId) || undefined,
    contracts: x.contracts && typeof x.contracts === 'object'
      ? {
          provides: strList(rec(x.contracts).provides, []),
          consumes: strList(rec(x.contracts).consumes, []),
        }
      : undefined,
    scope: {
      inc: strList(scope.include ?? scope.inc, ['src/**']),
      exc: strList(scope.exclude ?? scope.exc, []),
      max: Number(scope.maxFiles ?? scope.max) || 10,
      create: Boolean(scope.allowCreate ?? scope.create ?? true),
      del: Boolean(scope.allowDelete ?? scope.del ?? false),
    },
    ac,
    claim: x.claim && typeof x.claim === 'object'
      ? { by: name(claim.by), at: str(claim.at), beat: Number(claim.beat) || Date.now() }
      : null,
    cm: arr(x.comments ?? x.cm).map((c) => {
      const o = rec(c);
      return { by: name(o.by), t: str(o.t ?? o.text), at: str(o.at) };
    }).filter((c) => c.t),
    sc: arr(x.scopeChanges ?? x.scopeRequests ?? x.sc).map((c) => {
      const o = rec(c);
      return {
        op: str(o.op, 'widen'),
        path: Array.isArray(o.paths) ? o.paths.filter((p) => typeof p === 'string').join(', ') : str(o.path),
        by: name(o.by), at: str(o.at),
        approved: Boolean(o.approved), ...(o.why ? { why: str(o.why) } : {}),
      };
    }).filter((s) => s.path),
    files,
  };
}

/** Parse isi .rsprd.json → { prd, achs }. Error message dapat dibaca user. */
export function fromDoc(raw: unknown): { prd: Prd; achs: Ach[] } {
  const doc = rec(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('File is not an RS-PRD document.');
  if (doc.format && doc.format !== FORMAT_ID) throw new Error(`format: expected "${FORMAT_ID}", got "${str(doc.format)}".`);
  const p = rec(doc.prd);
  if (!doc.prd || typeof doc.prd !== 'object') throw new Error('prd: missing — this file has no PRD.');
  if (doc.achievements != null && !Array.isArray(doc.achievements)) throw new Error('achievements: not an array.');
  const gs = rec(p.globalScope);
  const mods = arr(p.modules).map((m) => {
    const o = rec(m);
    const ms = rec(o.scope);
    return {
      id: str(o.id), name: str(o.name), desc: str(o.desc),
      inc: strList(ms.include, []), exc: strList(ms.exclude, []),
      layer: str(o.layer) || undefined,
      allowedImports: Array.isArray(o.allowedImports) ? strList(o.allowedImports, []) : undefined,
    };
  }).filter((m) => m.name);
  const miles = arr(p.milestones).map((m) => {
    const o = rec(m);
    return { id: str(o.id), title: str(o.title), goal: str(o.goal) };
  }).filter((m) => m.title);
  const nf = arr(p.nonFunctional).map((n, idx) => {
    const o = typeof n === 'string' ? { text: n } : rec(n);
    return { id: str(o.id, `nf${String(idx + 1).padStart(2, '0')}`), text: str(o.text), metric: str(o.metric) };
  }).filter((n) => n.text);
  const risk = arr(p.risks).map((r, idx) => {
    const o = typeof r === 'string' ? { text: r } : rec(r);
    return { id: str(o.id, `r${String(idx + 1).padStart(2, '0')}`), text: str(o.text), mitigation: str(o.mitigation), severity: str(o.severity, 'medium') };
  }).filter((r) => r.text);
  const tds = arr(p.technicalDecisions).map((t) => {
    const o = typeof t === 'string' ? { text: t } : rec(t);
    return { text: str(o.text), reason: str(o.reason) };
  }).filter((t) => t.text);
  const prd: Prd = {
    id: str(p.id, 'prd_imported'),
    title: str(p.title, 'Imported PRD'),
    summary: str(p.summary),
    status: ['draft', 'running', 'paused', 'done', 'archived'].includes(str(p.status)) ? str(p.status) : 'draft',
    inc: strList(gs.include ?? p.inc, ['src/**']),
    exc: strList(gs.exclude ?? p.exc, ['**/*.env*', '.data/**']),
    cons: arr(p.constraints ?? p.cons).map((c) => {
      const o = typeof c === 'string' ? { t: c } : rec(c);
      return { t: str(o.t ?? o.text), m: str(o.m ?? o.mode, 'advisory') };
    }).filter((c) => c.t),
    goals: strList(p.goals, []),
    createdAt: str(p.createdAt, new Date().toISOString()),
    architecture: str(p.architecture),
    modules: mods,
    milestones: miles,
    nonFunctional: nf,
    risks: risk,
    technicalDecisions: tds,
  };
  const achs = arr(doc.achievements).map((x, i) => fromDocAch(rec(x), i));
  return { prd, achs };
}

/* ── adapter dokumen server (rpc 'state') → state board client ─────────── */

/** Nama aktor dari objek actor server: 'U' untuk user, label > name > kind. */
export function actorName(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = rec(v);
  if (o.kind === 'user') return 'U';
  return str(o.label) || str(o.name) || str(o.kind) || '?';
}

/**
 * Normalisasi dokumen RS-PRD v1 dari rpc 'state' ({ doc, presence, … })
 * menjadi bentuk board client. Reuse fromDocAch/fromDoc — server shape
 * sama dengan format ekspor, plus field heartbeat/beat untuk claim.
 */
export function fromServerState(payload: Record<string, unknown>): {
  prd: Prd | null;
  achs: Ach[];
  presence: Array<{ sessionId: string; model: string | null; label: string }>;
  language: string;
  guardMode: string;
  claimTtlSec: number;
  ilQuality: string;
  showToast: boolean;
  sound: boolean;
  displayName: string;
  lastInject: { text: string; n: number; at: number } | null;
  workspacePath: string | null;
} {
  const doc = payload.doc && typeof payload.doc === 'object' && !Array.isArray(payload.doc) ? payload.doc : null;
  const p = doc ? fromDoc(doc) : null;
  // Heartbeat: server claim { by, at, heartbeat, ttlSec, label } → client { by, at, beat }.
  const achs: Ach[] = (p?.achs ?? []).map((a) => {
    const raw = doc && Array.isArray((doc as { achievements?: unknown[] }).achievements)
      ? rec((doc as { achievements: unknown[] }).achievements.find((x) => rec(x).id === a.id))
      : rec({});
    const claim = rec(raw.claim);
    const claimBy = rec(claim.by);
    const beat = Number(new Date(str(claim.heartbeat ?? claim.beat) || Date.now()).valueOf()) || Date.now();
    const cBy = claimBy.kind === 'user' ? 'U' : str(claim.label) || actorName(claim.by);
    const sid = str(claimBy.sessionId) || undefined;
    const ag = str(claimBy.agentId) || null;
    return cBy ? { ...a, claim: { by: cBy, at: str(claim.at), beat, ...(sid ? { sid } : {}), ...(ag ? { ag } : {}) } } : { ...a, claim: null };
  });
  const inj = rec(payload.lastInject);
  const pres = Array.isArray(payload.presence) ? payload.presence.map((x) => {
    const o = rec(x);
    return { sessionId: str(o.sessionId), model: str(o.model) || null, label: str(o.label ?? o.model) || 'session', isSelf: o.isSelf === true, agentId: str(o.agentId) || null };
  }) : [];
  return {
    prd: p?.prd ?? null,
    achs,
    presence: pres,
    language: str(payload.language),
    guardMode: ['off', 'advisory', 'strict'].includes(str(payload.guardMode)) ? str(payload.guardMode) : 'advisory',
    claimTtlSec: Number(payload.claimTtlSec) || 900,
    ilQuality: ['verylow', 'low', 'medium', 'high'].includes(str(payload.ilQuality)) ? str(payload.ilQuality) : 'high',
    showToast: payload.showToast !== false,
    sound: payload.sound === true,
    displayName: str(payload.displayName) || 'Rizky',
    lastInject: inj.text
      ? { text: str(inj.text), n: Number(inj.delivered ?? inj.n) || 0, at: Number(inj.at) || Date.now() }
      : null,
    workspacePath: str(payload.workspacePath) || null,
  };
}
