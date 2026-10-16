/**
 * RSA/T engine (R1/R2) — every state transition lives here so the agent tools
 * and the UI RPC share ONE rule set:
 *  - Start (draft→running) is USER-only (P6.4) — the agent proposes, never starts.
 *  - Delete is USER-only (P3); agents can only `drop` (recoverable).
 *  - done: by default the user; an agent may mark done ONLY when every
 *    acceptance box is checked (user decision Q5) — otherwise it lands in
 *    `review` with the reason.
 *  - claim: PRD must be running, dependencies done, and the achievement not
 *    held by another live claim.
 */

import {
  STATES, TIER_POINTS, unlocked, inScope, score, maxScore, MAX_HISTORY,
  normModules, normMilestones, normNonFunctional, normRisks, normTechnicalDecisions, normContracts,
} from './model.js';
import { loadDoc, saveDoc, archiveAndDelete, StoreLockedError } from './store.js';
import { verifyQuestContracts } from './interlink.js';

export class EngineError extends Error {}

function requireDoc(api, sessionId) {
  const doc = loadDoc(api, sessionId);
  if (!doc) throw new EngineError('No PRD yet — create one first with the rsat_prd tool (action "create").');
  return doc;
}

function requireAchievement(doc, id) {
  const a = doc.achievements.find((x) => x.id === id);
  if (!a) throw new EngineError(`Achievement "${id}" not found.`);
  return a;
}

function isUser(actor) {
  return actor?.kind === 'user';
}

/** Constraints masuk sebagai string atau {text, mode} — dinormalisasi ke {text, mode}. */
function normConstraints(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 30).map((c) => {
    const o = typeof c === 'string' ? { text: c } : c || {};
    return { text: String(o.text ?? '').slice(0, 300), mode: o.mode === 'strict' ? 'strict' : 'advisory' };
  }).filter((c) => c.text);
}

/** Next free achievement number (1-based, gaps allowed). */
export function nextNo(doc) {
  return doc.achievements.reduce((max, a) => Math.max(max, a.no ?? 0), 0) + 1;
}

/** Summary card for status tools/UI: PRD + one line per achievement. */
export function summarize(doc) {
  const byState = {};
  for (const a of doc.achievements) byState[a.state] = (byState[a.state] ?? 0) + 1;
  return {
    prd: {
      id: doc.prd.id,
      title: doc.prd.title,
      status: doc.prd.status,
      language: doc.prd.language,
      createdAt: doc.prd.createdAt,
    },
    counts: { total: doc.achievements.length, byState },
    score: score(doc),
    maxScore: maxScore(doc),
    achievements: doc.achievements.map((a) => ({
      id: a.id, no: a.no, title: a.title, state: a.state, tier: a.tier,
      points: a.points ?? TIER_POINTS[a.tier] ?? 10,
      holder: a.claim?.by?.label ?? a.claim?.by?.name ?? null,
      acceptance: a.acceptance ? `${a.acceptance.filter((x) => x.done).length}/${a.acceptance.length}` : '–',
    })),
  };
}

// ---------------------------------------------------------------------------
// PRD
// ---------------------------------------------------------------------------

export async function createPrd(api, sessionId, actor, fields) {
  const existing = loadDoc(api, sessionId);
  if (existing) throw new EngineError(`A PRD already exists (${existing.prd.title || existing.prd.id}) — update it instead.`);
  const { freshDoc } = await import('./store.js');
  const doc = freshDoc(actor);
  doc.prd.title = (fields.title || 'Untitled project').slice(0, 120);
  doc.prd.summary = (fields.summary || '').slice(0, 2000);
  doc.prd.language = fields.language === 'id' ? 'id' : 'en';
  if (fields.architecture) doc.prd.architecture = String(fields.architecture).slice(0, 4000);
  const td = normTechnicalDecisions(fields.technicalDecisions);
  if (td) doc.prd.technicalDecisions = td;
  const modules = normModules(fields.modules);
  if (modules) doc.prd.modules = modules;
  const milestones = normMilestones(fields.milestones);
  if (milestones) doc.prd.milestones = milestones;
  const nf = normNonFunctional(fields.nonFunctional);
  if (nf) doc.prd.nonFunctional = nf;
  const risks = normRisks(fields.risks);
  if (risks) doc.prd.risks = risks;
  if (Array.isArray(fields.goals)) doc.prd.goals = fields.goals.slice(0, 20);
  if (Array.isArray(fields.nonGoals)) doc.prd.nonGoals = fields.nonGoals.slice(0, 20);
  if (fields.globalScope && Array.isArray(fields.globalScope.include)) {
    doc.prd.globalScope = {
      include: fields.globalScope.include.slice(0, 50),
      exclude: (fields.globalScope.exclude || []).slice(0, 50),
    };
  }
  const constraints = normConstraints(fields.constraints);
  if (constraints) doc.prd.constraints = constraints;
  return saveDoc(api, sessionId, doc, { by: actor, type: 'prd_created', target: doc.prd.id });
}

export async function updatePrd(api, sessionId, actor, fields) {
  const doc = requireDoc(api, sessionId);
  if (fields.title !== undefined) doc.prd.title = String(fields.title).slice(0, 120);
  if (fields.summary !== undefined) doc.prd.summary = String(fields.summary).slice(0, 2000);
  if (fields.architecture !== undefined) doc.prd.architecture = String(fields.architecture).slice(0, 4000);
  const td = normTechnicalDecisions(fields.technicalDecisions);
  if (td) doc.prd.technicalDecisions = td;
  const modules = normModules(fields.modules);
  if (modules) doc.prd.modules = modules;
  const milestones = normMilestones(fields.milestones);
  if (milestones) doc.prd.milestones = milestones;
  const nf = normNonFunctional(fields.nonFunctional);
  if (nf) doc.prd.nonFunctional = nf;
  const risks = normRisks(fields.risks);
  if (risks) doc.prd.risks = risks;
  if (Array.isArray(fields.goals)) doc.prd.goals = fields.goals.slice(0, 20);
  if (Array.isArray(fields.nonGoals)) doc.prd.nonGoals = fields.nonGoals.slice(0, 20);
  if (fields.status !== undefined) {
    if (!['draft', 'running', 'paused', 'done', 'archived'].includes(fields.status)) {
      throw new EngineError(`Invalid status "${fields.status}".`);
    }
    if ((fields.status === 'running' || fields.status === 'done') && !isUser(actor)) {
      throw new EngineError('Only the user can start (running) or finish (done) a PRD — propose it and let the user confirm in the board.');
    }
    doc.prd.status = fields.status;
  }
  if (fields.globalScope) {
    doc.prd.globalScope = {
      include: fields.globalScope.include?.slice(0, 50) ?? doc.prd.globalScope.include,
      exclude: fields.globalScope.exclude?.slice(0, 50) ?? doc.prd.globalScope.exclude,
    };
  }
  const constraints = normConstraints(fields.constraints);
  if (constraints) doc.prd.constraints = constraints;
  return saveDoc(api, sessionId, doc, { by: actor, type: 'prd_updated', target: doc.prd.id, data: { keys: Object.keys(fields) } });
}

export function commentPrd(api, sessionId, actor, text, kind) {
  const doc = requireDoc(api, sessionId);
  const entry = { at: new Date().toISOString(), by: actor, text: String(text).slice(0, 2000), kind: kind || 'note' };
  doc.prd.comments = [...(doc.prd.comments || []), entry];
  return saveDoc(api, sessionId, doc, { by: actor, type: 'commented', target: doc.prd.id, data: { kind: entry.kind } });
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export async function createAchievement(api, sessionId, actor, fields) {
  const doc = requireDoc(api, sessionId);
  if (!actor) throw new EngineError('Actor missing.');
  if (!fields.title) throw new EngineError('title is required.');
  const tier = fields.tier && TIER_POINTS[fields.tier] ? fields.tier : 'bronze';
  const id = fields.id || `A-${String(nextNo(doc)).padStart(3, '0')}`;
  if (doc.achievements.some((a) => a.id === id)) throw new EngineError(`Achievement id "${id}" already exists.`);
  const created = {
    id, no: nextNo(doc),
    title: String(fields.title).slice(0, 140),
    kind: fields.kind && KINDS_OK.includes(fields.kind) ? fields.kind : 'feature',
    tier,
    points: fields.points ?? TIER_POINTS[tier],
    description: String(fields.description || '').slice(0, 4000),
    technical: String(fields.technical || '').slice(0, 4000),
    acceptance: (fields.acceptance || []).slice(0, 30).map((t, i) => ({ id: `ac${i + 1}`, text: String(t).slice(0, 200), done: false })),
    scope: {
      include: (fields.scope?.include || doc.prd.globalScope.include).slice(0, 50),
      exclude: (fields.scope?.exclude || []).slice(0, 50),
      maxFiles: fields.scope?.maxFiles ?? 12,
      allowCreate: fields.scope?.allowCreate !== false,
      allowDelete: fields.scope?.allowDelete === true,
    },
    dependsOn: (fields.dependsOn || []).slice(0, 20),
    moduleId: fields.moduleId ? String(fields.moduleId).slice(0, 40) : undefined,
    milestoneId: fields.milestoneId ? String(fields.milestoneId).slice(0, 40) : undefined,
    contracts: normContracts(fields.contracts) ?? { provides: [], consumes: [] },
    tags: (fields.tags || []).slice(0, 10),
    state: 'available',
    comments: [], scopeChanges: [], files: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: actor,
  };
  if ((created.dependsOn || []).length > 0) created.state = 'locked';
  doc.achievements.push(created);
  return saveDoc(api, sessionId, doc, { by: actor, type: 'achievement_created', target: id });
}

const KINDS_OK = ['feature', 'bugfix', 'refactor', 'chore', 'research', 'test'];

export async function updateAchievement(api, sessionId, actor, id, fields) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (fields.title !== undefined) a.title = String(fields.title).slice(0, 140);
  if (fields.description !== undefined) a.description = String(fields.description).slice(0, 4000);
  if (fields.technical !== undefined) a.technical = String(fields.technical).slice(0, 4000);
  if (fields.tier !== undefined && TIER_POINTS[fields.tier]) a.tier = fields.tier;
  if (fields.points !== undefined) a.points = Math.max(1, Math.min(500, Number(fields.points) || 10));
  if (Array.isArray(fields.tags)) a.tags = fields.tags.slice(0, 10);
  if (fields.moduleId !== undefined) a.moduleId = fields.moduleId ? String(fields.moduleId).slice(0, 40) : undefined;
  if (fields.milestoneId !== undefined) a.milestoneId = fields.milestoneId ? String(fields.milestoneId).slice(0, 40) : undefined;
  if (fields.contracts !== undefined) a.contracts = normContracts(fields.contracts) ?? a.contracts;
  if (Array.isArray(fields.dependsOn)) a.dependsOn = fields.dependsOn.slice(0, 20);
  if (fields.state !== undefined && STATES.includes(fields.state)) {
    if (!isUser(actor) && (fields.state === 'done' || fields.state === 'dropped' || fields.state === 'blocked')) {
      throw new EngineError(`Only the user can set state "${fields.state}" directly — use complete (review) or drop.`);
    }
    a.state = fields.state;
  }
  if (Array.isArray(fields.acceptance)) {
    // AC review flow (user request): agents REPORT each criterion via
    // rsat_progress; only the user ticks the boxes on the board.
    a.acceptance = fields.acceptance.slice(0, 30).map((t, i) => ({ id: `ac${i + 1}`, text: String(t).slice(0, 200), done: false, requiresUser: true }));
  }
  a.updatedAt = new Date().toISOString();
  return saveDoc(api, sessionId, doc, { by: actor, type: 'achievement_updated', target: id });
}

export async function markAcceptance(api, sessionId, actor, id, acceptanceId, done) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  const box = (a.acceptance || []).find((x) => x.id === acceptanceId);
  if (!box) throw new EngineError(`Acceptance "${acceptanceId}" not found on ${id}.`);
  if (!isUser(actor) && box.requiresUser) throw new EngineError('This acceptance box is user-only — report the criterion with rsat_progress instead; the user reviews and ticks it on the board.');
  box.done = Boolean(done);
  a.updatedAt = new Date().toISOString();
  return saveDoc(api, sessionId, doc, { by: actor, type: 'acceptance_marked', target: id, data: { acceptanceId, done: box.done } });
}

export async function dropAchievement(api, sessionId, actor, id, reason) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (!reason) throw new EngineError('A drop needs a reason.');
  a.state = 'dropped';
  a.dropReason = String(reason).slice(0, 500);
  a.claim = undefined;
  a.updatedAt = new Date().toISOString();
  return saveDoc(api, sessionId, doc, { by: actor, type: 'dropped', target: id, data: { reason } });
}

export async function restoreAchievement(api, sessionId, actor, id) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (a.state !== 'dropped') throw new EngineError(`${id} is not dropped.`);
  a.state = unlocked(doc, a) ? 'available' : 'locked';
  delete a.dropReason;
  return saveDoc(api, sessionId, doc, { by: actor, type: 'restored', target: id });
}

/** USER-only hard delete (P3). */
export async function deleteAchievement(api, sessionId, actor, id) {
  const doc = requireDoc(api, sessionId);
  if (!isUser(actor)) throw new EngineError('Only the user can delete — agents use drop.');
  const before = doc.achievements.length;
  doc.achievements = doc.achievements.filter((a) => a.id !== id);
  if (doc.achievements.length === before) throw new EngineError(`Achievement "${id}" not found.`);
  return saveDoc(api, sessionId, doc, { by: actor, type: 'achievement_deleted', target: id });
}

export function commentAchievement(api, sessionId, actor, id, text, kind) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  a.comments = [...(a.comments || []), { at: new Date().toISOString(), by: actor, text: String(text).slice(0, 2000), kind: kind || 'note' }];
  return saveDoc(api, sessionId, doc, { by: actor, type: 'commented', target: id });
}

// ---------------------------------------------------------------------------
// Claim / release / progress / complete (R2 core loop)
// ---------------------------------------------------------------------------

export async function claim(api, sessionId, actor, id, label) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (doc.prd.status !== 'running') throw new EngineError(`PRD is "${doc.prd.status}" — the user must Start it first (agents cannot).`);
  if (a.state === 'claimed' || a.state === 'in_progress' || a.state === 'review') {
    throw new EngineError(`${id} is already held by ${a.claim?.by?.label ?? a.claim?.by?.name ?? 'another agent'}.`);
  }
  if (a.state === 'done' || a.state === 'dropped') throw new EngineError(`${id} is ${a.state}.`);
  if (!unlocked(doc, a)) throw new EngineError(`${id} is locked: depends on ${(a.dependsOn || []).join(', ')}.`);
  a.state = 'claimed';
  const ttlSec = Number(api.settings?.get?.('claimTtlSec')) || 3600;
  a.claim = {
    by: actor, at: new Date().toISOString(),
    heartbeat: new Date().toISOString(), ttlSec,
    label: (label || actor.name || 'Agent').slice(0, 40),
  };
  a.updatedAt = a.claim.at;
  return saveDoc(api, sessionId, doc, { by: actor, type: 'claimed', target: id, data: { label: a.claim.label } });
}

export async function release(api, sessionId, actor, id, reason) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (!a.claim) throw new EngineError(`${id} is not claimed.`);
  if (a.claim.by.sessionId && actor.sessionId && a.claim.by.sessionId !== actor.sessionId && !isUser(actor)) {
    throw new EngineError(`${id} is held by ${a.claim.label} — only that agent or the user can release it.`);
  }
  if (!reason) throw new EngineError('A release needs a reason.');
  const back = unlocked(doc, a) ? 'available' : 'locked';
  const wasClaim = a.state;
  a.state = back;
  const prevClaim = a.claim;
  a.claim = undefined;
  a.updatedAt = new Date().toISOString();
  return saveDoc(api, sessionId, doc, { by: actor, type: 'released', target: id, data: { reason, from: wasClaim, holder: prevClaim.label } });
}

export async function progress(api, sessionId, actor, id, note) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (!a.claim) throw new EngineError(`${id} is not claimed — claim it first.`);
  if (a.claim.by.sessionId && actor.sessionId && a.claim.by.sessionId !== actor.sessionId && !isUser(actor)) {
    throw new EngineError(`${id} is held by ${a.claim.label}.`);
  }
  a.state = 'in_progress';
  a.claim.heartbeat = new Date().toISOString();
  if (note) a.progressNote = { at: a.claim.heartbeat, text: String(note).slice(0, 500) };
  a.updatedAt = a.claim.heartbeat;
  return saveDoc(api, sessionId, doc, { by: actor, type: 'progress', target: id, data: note ? { note: String(note).slice(0, 80) } : {} });
}

/**
 * Complete: an agent may only mark `done` when every acceptance box is
 * checked (user decision Q5); otherwise the achievement goes to `review`
 * with the reason and the user finishes it from the board.
 */
export async function complete(api, sessionId, actor, id, reason) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (!a.claim) throw new EngineError(`${id} is not claimed.`);
  const contractVerification = verifyQuestContracts(api, sessionId, a);
  if (!isUser(actor) && !contractVerification.ok) {
    throw new EngineError(
      `Contract Enforcer (${id}): Cannot mark complete — promised export(s) [${contractVerification.missingProvides.join(', ')}] in contracts.provides were not found in the AST of scoped files. Export the required symbol(s) or update the contract first.`,
    );
  }
  const boxes = a.acceptance || [];
  const allDone = boxes.length > 0 && boxes.every((b) => b.done);
  if (isUser(actor)) {
    a.state = 'done';
    a.doneBy = actor;
    a.doneAt = new Date().toISOString();
    a.claim = undefined;
  } else if (allDone && contractVerification.ok) {
    a.state = 'done';
    a.doneBy = actor;
    a.doneAt = new Date().toISOString();
    a.claim = undefined;
  } else {
    a.state = 'review';
    a.reviewReason = String(reason || boxes.filter((b) => !b.done).map((b) => b.text).join('; ')).slice(0, 500);
  }
  a.updatedAt = new Date().toISOString();
  if (a.state === 'done') refreshDependents(doc);
  return saveDoc(api, sessionId, doc, { by: actor, type: a.state === 'done' ? 'completed' : 'review_requested', target: id });
}

/**
 * STALE-LOCK SWEEP: after a state transition to/from done, recompute the
 * stored state of every dependent achievement. A stored 'locked' whose deps
 * are now all done becomes 'available' (and the reverse) — the persisted
 * state never lags the dependency rule again (agents were burning dozens of
 * steps investigating locked boards whose deps were already done).
 */
function refreshDependents(doc) {
  for (const dep of doc.achievements) {
    if (dep.state !== 'locked' && dep.state !== 'available') continue;
    dep.state = unlocked(doc, dep) ? 'available' : 'locked';
  }
}

/** User accepts a review → done. */
export async function acceptReview(api, sessionId, actor, id) {
  if (!isUser(actor)) throw new EngineError('Only the user can accept a review.');
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (a.state !== 'review') throw new EngineError(`${id} is not in review (state: ${a.state}).`);
  a.state = 'done';
  a.doneBy = actor;
  a.doneAt = new Date().toISOString();
  a.claim = undefined;
  delete a.reviewReason;
  refreshDependents(doc);
  return saveDoc(api, sessionId, doc, { by: actor, type: 'review_accepted', target: id });
}

/** User rejects a review → back to the claimant. */
export async function rejectReview(api, sessionId, actor, id, reason) {
  if (!isUser(actor)) throw new EngineError('Only the user can reject a review.');
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (a.state !== 'review') throw new EngineError(`${id} is not in review.`);
  a.state = 'claimed';
  a.comments = [...(a.comments || []), { at: new Date().toISOString(), by: actor, text: `Review rejected: ${reason || 'needs more work'}`, kind: 'decision' }];
  return saveDoc(api, sessionId, doc, { by: actor, type: 'review_rejected', target: id, data: { reason } });
}

// ---------------------------------------------------------------------------
// Scope changes (P3)
// ---------------------------------------------------------------------------

export async function changeScope(api, sessionId, actor, id, op, paths, reason) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (!['widen', 'narrow'].includes(op)) throw new EngineError('op must be "widen" or "narrow".');
  if (!Array.isArray(paths) || paths.length === 0) throw new EngineError('paths[] is required.');
  if (!reason) throw new EngineError('A scope change needs a reason.');
  const strictMode = api.settings?.get?.('guardMode') === 'strict';
  a.scopeChanges = [...(a.scopeChanges || []), {
    at: new Date().toISOString(), by: actor, op, paths: paths.slice(0, 50),
    reason: String(reason).slice(0, 500), approved: isUser(actor) ? true : !strictMode,
  }];
  const change = a.scopeChanges[a.scopeChanges.length - 1];
  if (change.approved) {
    if (op === 'widen') a.scope.include = [...new Set([...(a.scope.include || []), ...paths])].slice(0, 50);
    else a.scope.exclude = [...new Set([...(a.scope.exclude || []), ...paths])].slice(0, 50);
  }
  a.updatedAt = new Date().toISOString();
  return saveDoc(api, sessionId, doc, { by: actor, type: 'scope_change', target: id, data: { op, approved: change.approved } });
}

/** Scope guard question: is this path inside the achievement's scope? */
export function pathAllowed(doc, achievementId, relPath) {
  const a = doc?.achievements?.find((x) => x.id === achievementId);
  if (!a) return { ok: false, reason: 'no achievement' };
  const globalOk = inScope(doc.prd.globalScope, relPath);
  const localOk = inScope(a.scope, relPath);
  return {
    ok: globalOk && localOk,
    globalOk, localOk,
    achievement: a.id,
    holder: a.claim?.label ?? null,
    reason: !globalOk ? 'outside PRD globalScope' : !localOk ? 'outside achievement scope' : null,
  };
}

/** Which achievement (claimed by anyone) covers this path? For the guard. */
export function coveringAchievements(doc, relPath) {
  return (doc.achievements || []).filter((a) => ['claimed', 'in_progress', 'review'].includes(a.state) && inScope(a.scope, relPath));
}

/** Effective state (design eff()): locked ↔ available follow the dependency rule. */
export function effOf(doc, a) {
  if (a.state === 'locked' || a.state === 'available') return unlocked(doc, a) ? 'available' : 'locked';
  return a.state;
}

/** USER-only hard delete of the whole PRD (P3) — an archive copy stays in the project. */
export function deletePrd(api, sessionId, actor) {
  const doc = requireDoc(api, sessionId);
  if (!isUser(actor)) throw new EngineError('Only the user can delete a PRD — agents can drop achievements.');
  return archiveAndDelete(api, sessionId, doc, actor);
}

/** User approves a pending (strict-mode) scope request — applies the change. */
export async function approveScope(api, sessionId, actor, id, index) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  if (!isUser(actor)) throw new EngineError('Only the user can approve a scope request.');
  const change = (a.scopeChanges || [])[Number(index)];
  if (!change) throw new EngineError(`Scope change #${index} not found on ${id}.`);
  if (change.approved) throw new EngineError('That scope change is already approved.');
  change.approved = true;
  if (change.op === 'widen') a.scope.include = [...new Set([...(a.scope.include || []), ...change.paths])].slice(0, 50);
  else a.scope.exclude = [...new Set([...(a.scope.exclude || []), ...change.paths])].slice(0, 50);
  a.updatedAt = new Date().toISOString();
  return saveDoc(api, sessionId, doc, { by: actor, type: 'scope_approved', target: id, data: { op: change.op } });
}

/** One-line file summary from the board (pairs with the agent's rsat_note_file). */
export async function setFileSummary(api, sessionId, actor, id, filePath, summary) {
  const doc = requireDoc(api, sessionId);
  const a = requireAchievement(doc, id);
  const rel = String(filePath || '').replace(/\\/g, '/');
  const entry = (a.files || []).find((f) => f.path === rel);
  if (!entry) throw new EngineError(`File "${rel}" is not in the ledger of ${id}.`);
  entry.summary = String(summary || '').slice(0, 300);
  entry.pending = false;
  a.updatedAt = new Date().toISOString();
  return saveDoc(api, sessionId, doc, { by: actor, type: 'file_summary', target: id, data: { path: rel } });
}

/** R7: apply an imported RS-PRD doc after the dry-run preview.
 *  Claims from the source project are always reset (their sessions are gone);
 *  a running PRD arrives as paused — Start stays a user action. */
export async function applyImport(api, sessionId, actor, incoming, mode) {
  const doc = requireDoc(api, sessionId);
  if (mode !== 'merge' && mode !== 'replace') throw new EngineError('mode must be "merge" or "replace".');
  const cloned = JSON.parse(JSON.stringify(incoming));
  const doneIds = new Set((cloned.achievements || []).filter((x) => x.state === 'done').map((x) => x.id));
  for (const a of cloned.achievements || []) {
    a.dependsOn = (a.dependsOn || []).filter((d) => doneIds.has(d) || (cloned.achievements || []).some((x) => x.id === d));
    if (a.claim) {
      a.claim = undefined;
      if (a.state === 'claimed' || a.state === 'in_progress' || a.state === 'review') {
        a.state = (a.dependsOn || []).every((d) => doneIds.has(d)) ? 'available' : 'locked';
      }
    }
  }
  if (mode === 'replace') {
    doc.prd = {
      ...cloned.prd,
      id: doc.prd.id,
      status: cloned.prd.status === 'running' ? 'paused' : cloned.prd.status ?? 'draft',
    };
    doc.achievements = cloned.achievements || [];
  } else {
    const remap = new Map();
    for (const a of cloned.achievements || []) {
      let id = a.id;
      let n = 2;
      while (doc.achievements.some((x) => x.id === id)) id = `${a.id}-${n++}`;
      remap.set(a.id, id);
      a.id = id;
    }
    for (const a of cloned.achievements || []) {
      a.dependsOn = (a.dependsOn || []).map((d) => remap.get(d) ?? d)
        .filter((d) => doc.achievements.some((x) => x.id === d));
      a.no = nextNo(doc);
      doc.achievements.push(a);
    }
  }
  doc.history = [...(doc.history || []), {
    at: new Date().toISOString(), by: actor, type: 'imported', target: mode,
    data: { count: (cloned.achievements || []).length },
  }].slice(-MAX_HISTORY);
  return saveDoc(api, sessionId, doc, { by: actor, type: 'imported', target: mode, data: { count: (cloned.achievements || []).length } });
}

export function whoami(actor, sessionId) {
  return { actor, sessionId };
}

/**
 * AUTO-HEARTBEAT: refresh the claim heartbeat of every achievement held by
 * this session — called silently from every RSAT tool execution so an agent
 * actively working never loses its claim to the TTL reaper. No doc save if
 * nothing changed (cheap path). Returns the number of claims refreshed.
 */
export async function autoHeartbeat(api, sessionId, actor) {
  if (!sessionId || isUser(actor)) return 0;
  const doc = loadDoc(api, sessionId);
  if (!doc || doc.prd.status !== 'running') return 0;
  const now = new Date().toISOString();
  let touched = 0;
  for (const a of doc.achievements) {
    if (!a.claim || !['claimed', 'in_progress', 'review'].includes(a.state)) continue;
    if (a.claim.by?.sessionId !== sessionId && a.claim.by?.agentId !== actor?.agentId) continue;
    // Skip if heartbeat is fresh (< 60s old) to avoid write churn.
    const beat = Date.parse(a.claim.heartbeat ?? '') || 0;
    if (Date.now() - beat < 60_000) continue;
    a.claim.heartbeat = now;
    touched++;
  }
  if (touched > 0) {
    await saveDoc(api, sessionId, doc, { by: actor, type: 'progress', target: 'auto-heartbeat', data: { auto: true, refreshed: touched } });
  }
  return touched;
}
