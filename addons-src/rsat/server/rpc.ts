/**
 * RSA/T UI RPC (R6) — the board talks to these via /api/addons/rsat/rpc/*.
 * Every mutating handler enforces the SAME engine rules as the agent tools:
 * user-only actions (Start/Pause, delete, review accept/reject) verify
 * actor.kind === 'user' — the HTTP route guarantees it.
 */

import path from 'node:path';

import * as engine from './engine.js';
import { loadDoc, saveDoc, readEvents, readAllLedgers, writeExport, writeImport, invalidate, rootOf } from './store.js';
import { broadcast, presence } from './sync.js';
import { userActor, readActivity } from './platform.js';

/** The route already wraps the handler value in `{ ok, result }` and the host
 *  `invoke()` unwraps one level — handlers must return the PAYLOAD ITSELF. */
const ok = (result) => result;
const fail = (error) => { throw error; };

/** Candidate workspaces for the board's picker: the active workspace plus every
 *  running session's folder. (The addon API exposes no registry list, so this
 *  derives the real folders the harness is actually bound to.) */
function listWsp(api) {
  const out = [];
  const seen = new Set();
  try {
    const active = api.workspace?.root?.();
    if (active) { seen.add(active); out.push({ id: active, path: active, label: path.basename(active) }); }
  } catch {  }
  try {
    for (const s of api.sessions?.list?.() ?? []) {
      if (s.workspacePath && !seen.has(s.workspacePath)) {
        seen.add(s.workspacePath);
        out.push({ id: s.workspacePath, path: s.workspacePath, label: path.basename(s.workspacePath) });
      }
    }
  } catch {  }
  return out;
}

/** The board's workspace picker: list registered workspaces + current binding. */
export async function workspaces(api, sessionId) {
  return ok({ items: listWsp(api), binding: rootOf(api, sessionId) });
}

/** Bind RSA/T to a registered workspace (by id or path) — persisted in the addon store. */
export async function setWorkspace(api, sessionId, body) {
  const idOrPath = String(body?.id ?? body?.path ?? '');
  const items = listWsp(api);
  const hit = items.find((w) => w.id === idOrPath || w.path === idOrPath);
  if (!hit) throw new Error(`Workspace "${idOrPath}" is not registered.`);
  api.store.set('workspacePath', hit.path);
  invalidate(api, sessionId);
  await broadcast(api, sessionId, { type: 'workspace_bound', target: hit.label, by: userActor() });
  return ok({ workspacePath: hit.path, label: hit.label });
}

/** The full board state in one payload (initial load). */
export async function state(api, sessionId) {
  try {
    const doc = loadDoc(api, sessionId);
    const language = api.settings.get('language') || doc?.prd?.language || '';
    const guardMode = api.settings.get('guardMode') === 'strict' ? 'strict'
      : api.settings.get('guardMode') === 'off' ? 'off' : 'advisory';
    const claimTtlSec = Number(api.settings.get('claimTtlSec')) || 900;
    const ilQuality = ['verylow', 'low', 'medium', 'high'].includes(api.settings.get('ilQuality'))
      ? api.settings.get('ilQuality') : 'high';
    const showToast = api.settings.get('showToast') !== false;
    const sound = api.settings.get('sound') === true;
    const lastInject = readActivity(60).find((e) => e.kind === 'inject') ?? null;
    const base = {
      presence: presence(api, sessionId), language, guardMode, claimTtlSec, showToast, sound, lastInject, ilQuality,
      workspaces: listWsp(api), workspacePath: rootOf(api, sessionId),
      displayName: api.settings.get('displayName') || 'Rizky',
    };
    if (!doc) return ok({ doc: null, ...base });
    return ok({ doc, score: engine.summarize(doc), ...base });
  } catch (error) {
    fail(error);
  }
}

export async function start(api, sessionId, body) {
  await engine.updatePrd(api, sessionId, userActor(), { status: 'running' });
  await broadcast(api, sessionId, { type: 'started', target: 'prd', by: userActor() });
  return ok({ started: true });
}

export async function pause(api, sessionId) {
  await engine.updatePrd(api, sessionId, userActor(), { status: 'paused' });
  await broadcast(api, sessionId, { type: 'paused', target: 'prd', by: userActor() });
  return ok({ paused: true });
}

export async function reviewAccept(api, sessionId, body) {
  const doc = await engine.acceptReview(api, sessionId, userActor(), String(body?.id));
  const a = doc.achievements.find((x) => x.id === body.id);
  await broadcast(api, sessionId, {
    type: 'completed', target: a.id, title: a.title, tier: a.tier, points: a.points, by: userActor(),
  });
  return ok({ done: true });
}

export async function reviewReject(api, sessionId, body) {
  await engine.rejectReview(api, sessionId, userActor(), String(body?.id), String(body?.reason ?? ''));
  await broadcast(api, sessionId, { type: 'review_rejected', target: String(body?.id), by: userActor() });
  return ok({ rejected: true });
}

export async function deleteAchievement(api, sessionId, body) {
  await engine.deleteAchievement(api, sessionId, userActor(), String(body?.id));
  await broadcast(api, sessionId, { type: 'achievement_deleted', target: String(body?.id), by: userActor() });
  return ok({ deleted: true });
}

/** USER-only full PRD teardown (P3 + design danger zone) — archive copy kept. */
export async function deletePrd(api, sessionId) {
  const result = await engine.deletePrd(api, sessionId, userActor());
  await broadcast(api, sessionId, { type: 'prd_deleted', target: 'prd', by: userActor() });
  return ok({ deleted: true, archive: result?.archive ?? null });
}

export async function restoreAchievement(api, sessionId, body) {
  await engine.restoreAchievement(api, sessionId, userActor(), String(body?.id));
  await broadcast(api, sessionId, { type: 'restored', target: String(body?.id), by: userActor() });
  return ok({ restored: true });
}

/** User checks/unchecks an acceptance box from the drawer. */
export async function toggleAcceptance(api, sessionId, body) {
  const doc = await engine.markAcceptance(
    api, sessionId, userActor(),
    String(body?.id), String(body?.acceptanceId), Boolean(body?.done),
  );
  await broadcast(api, sessionId, { type: 'acceptance', target: String(body?.id), by: userActor() });
  return ok({ doc });
}

/** LangGate (P0a): the user picks the board language — consent is explicit. */
export async function setLanguage(api, sessionId, body) {
  const lang = body?.language === 'id' ? 'id' : 'en';
  const doc = loadDoc(api, sessionId);
  if (doc) {
    doc.prd.language = lang;
    await saveDoc(api, sessionId, doc, { by: userActor(), type: 'language_set', target: 'prd', data: { language: lang } });
  }
  api.settings.set('language', lang);
  await broadcast(api, sessionId, { type: 'language_set', target: 'prd', by: userActor() });
  return ok({ language: lang });
}

export async function events(api, sessionId, body) {
  return ok({ events: readEvents(api, sessionId, Number(body?.limit) || 200) });
}

export async function files(api, sessionId, body) {
  return ok({ files: readAllLedgers(api, sessionId, Number(body?.limit) || 500) });
}

export async function exportDoc(api, sessionId) {
  const doc = loadDoc(api, sessionId);
  if (!doc) throw new Error('Nothing to export yet.');
  const file = await writeExport(api, sessionId, doc);
  return ok({ file, content: JSON.stringify(doc, null, 2), name: `${doc.prd.id}.rsprd.json` });
}

/** Import (R7): no mode → DRY-RUN diff; mode=merge|replace → apply (claims reset). */
export async function importDoc(api, sessionId, body) {
  const content = String(body?.content ?? '');
  if (!content) throw new Error('content (the .rsprd.json text) is required.');
  let incoming;
  try { incoming = writeImport(api, sessionId, content); }
  catch (error) { throw error; }
  const mode = body?.mode === 'merge' || body?.mode === 'replace' ? body.mode : null;
  const existing = loadDoc(api, sessionId);
  const existingIds = new Set((existing?.achievements ?? []).map((a) => a.id));
  const conflicts = (incoming.achievements ?? []).filter((a) => existingIds.has(a.id)).map((a) => a.id);
  const claimsReset = (incoming.achievements ?? []).filter((a) => a.claim).length;
  if (!mode) {
    return ok({ dryRun: true, total: (incoming.achievements ?? []).length, conflicts, claimsReset, title: incoming.prd?.title ?? '' });
  }
  if (!existing) {
    invalidate(api, sessionId);
    const { freshDoc } = await import('./store.js');
    const doc = freshDoc(userActor());
    Object.assign(doc, { prd: { ...incoming.prd, id: doc.prd.id }, achievements: incoming.achievements ?? [], history: [] });
    await saveDoc(api, sessionId, doc, { by: userActor(), type: 'imported', target: mode });
    await broadcast(api, sessionId, { type: 'imported', target: doc.prd.id, by: userActor() });
    return ok({ imported: true, mode, id: doc.prd.id, total: doc.achievements.length });
  }
  await engine.applyImport(api, sessionId, userActor(), incoming, mode);
  await broadcast(api, sessionId, { type: 'imported', target: mode, by: userActor() });
  return ok({ imported: true, mode, conflicts: mode === 'merge' ? conflicts.length : 0, total: (incoming.achievements ?? []).length });
}

export async function guardTest(api, sessionId, body) {
  const doc = loadDoc(api, sessionId);
  if (!doc) throw new Error('No PRD.');
  const { pathAllowed } = engine;
  const r = pathAllowed(doc, String(body?.id), String(body?.path ?? ''));
  return { ok: r.ok, reason: r.reason ?? 'inside scope', holder: r.holder };
}

export async function setGuard(api, sessionId, body) {
  const mode = body?.mode === 'strict' ? 'strict' : body?.mode === 'off' ? 'off' : 'advisory';
  api.settings.set('guardMode', mode);
  await broadcast(api, sessionId, { type: 'guard_set', target: 'settings', data: { mode } });
  return { guardMode: mode };
}

export async function changeScope(api, sessionId, body) {
  await engine.changeScope(api, sessionId, userActor(), String(body?.id), String(body?.op), body?.paths ?? [], String(body?.reason ?? ''));
  await broadcast(api, sessionId, { type: 'scope_change', target: String(body?.id), by: userActor() });
  return { ok: true };
}

/** User edits the PRD fields from the Base camp form (title/scope/goals/…). */
export async function updatePrdRpc(api, sessionId, body) {
  const fields = (body?.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) ? body.fields : {};
  await engine.updatePrd(api, sessionId, userActor(), fields);
  await broadcast(api, sessionId, { type: 'prd_updated', target: 'prd', by: userActor() });
  return { ok: true };
}

/** User approves a pending strict-mode scope request. */
export async function approveScope(api, sessionId, body) {
  await engine.approveScope(api, sessionId, userActor(), String(body?.id), Number(body?.index ?? -1));
  await broadcast(api, sessionId, { type: 'scope_approved', target: String(body?.id), by: userActor() });
  return { ok: true };
}

/** Drawer action bar (user): claim a quest (engine enforces running+unlocked). */
export async function claim(api, sessionId, body) {
  const id = String(body?.id);
  await engine.claim(api, sessionId, userActor(), id, String(body?.label ?? ''));
  await broadcast(api, sessionId, { type: 'claimed', target: id, by: userActor() });
  return { ok: true };
}

/** Drawer action bar (user): finish a quest the user holds — engine marks it done. */
export async function complete(api, sessionId, body) {
  const id = String(body?.id);
  const doc = await engine.complete(api, sessionId, userActor(), id, String(body?.reason ?? ''));
  const a = doc.achievements.find((x) => x.id === id);
  await broadcast(api, sessionId, {
    type: 'completed', target: id, title: a?.title, tier: a?.tier, points: a?.points, by: userActor(),
  });
  return { ok: true };
}

/** Drawer action bar (user): release/take over a claim (reason required by the engine). */
export async function release(api, sessionId, body) {
  await engine.release(api, sessionId, userActor(), String(body?.id), String(body?.reason ?? 'released from the board'));
  await broadcast(api, sessionId, { type: 'released', target: String(body?.id), by: userActor() });
  return { ok: true };
}

/** Drawer action bar (user): drop (recoverable) — never a hard delete. */
export async function drop(api, sessionId, body) {
  await engine.dropAchievement(api, sessionId, userActor(), String(body?.id), String(body?.reason ?? 'dropped from the board'));
  await broadcast(api, sessionId, { type: 'dropped', target: String(body?.id), by: userActor() });
  return { ok: true };
}

/** Heartbeat from the drawer (the holder or the user keeps the claim alive). */
export async function progress(api, sessionId, body) {
  await engine.progress(api, sessionId, userActor(), String(body?.id), String(body?.note ?? ''));
  await broadcast(api, sessionId, { type: 'progress', target: String(body?.id), by: userActor() });
  return { ok: true };
}

/** One-line ledger summary typed in the drawer's Files tab. */
export async function setFileSummary(api, sessionId, body) {
  await engine.setFileSummary(api, sessionId, userActor(), String(body?.id), String(body?.path ?? ''), String(body?.summary ?? ''));
  await broadcast(api, sessionId, { type: 'file_summary', target: String(body?.id), by: userActor() });
  return { ok: true };
}

/** User creates a quest from the board (P1: user/operator/agent can create). */
export async function createAchievement(api, sessionId, body) {
  const doc = await engine.createAchievement(api, sessionId, userActor(), body ?? {});
  await broadcast(api, sessionId, { type: 'achievement_created', target: 'board', by: userActor() });
  return ok({ doc });
}


/** The roster the Create Agent panel + Basecamp party card render. */
export async function agents(api, sessionId) {
  const { loadAgents } = await import('./agents.js');
  return ok({ agents: loadAgents(api, sessionId) });
}

/** USER-only: create an agent (identity + logo + provider/model + seed note). */
export async function createAgent(api, sessionId, body) {
  const { createAgent: make } = await import('./agents.js');
  const rec = await make(api, sessionId, userActor(), body ?? {});
  await broadcast(api, sessionId, { type: 'agent_created', target: rec.id, by: userActor(), data: { name: rec.name } });
  return ok({ agent: rec });
}

/** USER-only: edit an agent — swap provider/model WITHOUT touching identity/memory. */
export async function updateAgent(api, sessionId, body) {
  const { updateAgent: edit } = await import('./agents.js');
  const rec = await edit(api, sessionId, userActor(), String(body?.id), body?.fields ?? body ?? {});
  await broadcast(api, sessionId, { type: 'agent_updated', target: rec.id, by: userActor() });
  return ok({ agent: rec });
}

/** USER-only: delete an agent from the registry. */
export async function deleteAgent(api, sessionId, body) {
  const { deleteAgent: rm } = await import('./agents.js');
  await rm(api, sessionId, userActor(), String(body?.id));
  await broadcast(api, sessionId, { type: 'agent_deleted', target: String(body?.id), by: userActor() });
  return ok({ deleted: true });
}

/** Dispatch step 2: bind the freshly created conversation to the agent. */
export async function bindAgentSession(api, sessionId, body) {
  const { bindSession } = await import('./agents.js');
  const out = await bindSession(api, sessionId, userActor(), String(body?.agentId), String(body?.sessionId ?? ''));
  await broadcast(api, sessionId, { type: 'session_bound', target: String(body?.agentId), by: userActor() });
  return ok(out);
}

/** Heartbeat timeout (minutes → seconds stored). */
export async function setTtl(api, sessionId, body) {
  const minutes = Math.max(1, Math.min(120, Number(body?.minutes) || 15));
  api.settings.set('claimTtlSec', minutes * 60);
  await broadcast(api, sessionId, { type: 'ttl_set', target: 'settings', data: { minutes } });
  return { claimTtlSec: minutes * 60 };
}

/** Graphics quality Interlinked (Options) — rpc setIlQuality. */
export async function setIlQuality(api, sessionId, body) {
  const q = ['verylow', 'low', 'medium', 'high'].includes(body?.q) ? body.q : 'high';
  api.settings.set('ilQuality', q);
  await broadcast(api, sessionId, { type: 'ilquality_set', target: 'settings', data: { q } });
  return { ilQuality: q };
}

export async function comment(api, sessionId, body) {
  if (body?.id === 'prd') await engine.commentPrd(api, sessionId, userActor(), String(body?.text ?? ''), 'note');
  else await engine.commentAchievement(api, sessionId, userActor(), String(body?.id), String(body?.text ?? ''), 'note');
  await broadcast(api, sessionId, { type: 'commented', target: String(body?.id), by: userActor() });
  return { ok: true };
}

export async function createPrdRpc(api, sessionId, body) {
  await engine.createPrd(api, sessionId, userActor(), body ?? {});
  await broadcast(api, sessionId, { type: 'prd_created', target: 'prd', by: userActor() });
  return { ok: true };
}

/** Live Interlinked Node-Wire Graph & @RSLK v1 payload from the bound Moriko workspace. */
export async function interlinkGraph(api, sessionId, body) {
  const { buildWorkspaceInterlink } = await import('./interlink.js');
  return ok(buildWorkspaceInterlink(api, sessionId, {
    focusPath: body?.focusPath ? String(body.focusPath) : undefined,
    force: body?.force === true,
  }));
}

/** Save dragged node positions in `.moriko/rsat/interlink-positions.json`. */
export async function saveNodePositions(api, sessionId, body) {
  const { saveNodePositions: persistPos } = await import('./interlink.js');
  return ok(await persistPos(api, sessionId, body?.positions ?? {}));
}

/** The registry of handlers main.ts wires into ctx.rpc.handle. */
export const rpcHandlers = {
  state, start, pause, updatePrd: updatePrdRpc, reviewAccept, reviewReject, deleteAchievement, deletePrd, restoreAchievement,
  toggleAcceptance, setLanguage, events, files, exportDoc, importDoc,
  guardTest, setGuard, changeScope, approveScope,
  release, drop, progress, complete, setFileSummary, createAchievement, setTtl,
  workspaces, setWorkspace,
  comment, createPrd: createPrdRpc, claim,
  agents, createAgent, updateAgent, deleteAgent, bindAgentSession,
  interlinkGraph, saveNodePositions, setIlQuality,
};
