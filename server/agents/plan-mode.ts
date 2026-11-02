/**
 * PLAN MODE (6A) — a per-session posture where the agent may EXPLORE but not
 * CHANGE.
 *
 * This is the core-harness counterpart to RSA/T, and the two live at different
 * scales on purpose:
 *   - plan mode disciplines ONE session's thinking (cheap, always available),
 *   - RSA/T coordinates MANY sessions through a shared contract (macro).
 * They compose: plan mode is legal INSIDE a claimed achievement when a change
 * needs designing or the scope needs renegotiating.
 *
 * The gate is PHYSICAL. A denied call never reaches its handler, so trying
 * anyway is not a strategy the model can learn. Every refusal names the tool,
 * the reason, and the exact way out — a refusal that cannot be acted on is
 * just an obstacle.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getActiveWorkspace } from './workspace.js';

export interface PlanModeState {
  active: boolean;
  /** Why this session is planning — echoed back in every refusal. */
  reason: string;
  enteredAt: number;
}

/**
 * session → plan-mode state. Deliberately IN-MEMORY: a harness restart clears
 * the posture rather than trapping a session in a lock nobody can lift. Losing
 * the flag costs one tool call; a stuck flag costs the whole session.
 */
const states = new Map<string, PlanModeState>();

function slot(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  return sessionId.trim() ? sessionId : null;
}

export function planModeState(sessionId: string | undefined): PlanModeState | undefined {
  const key = slot(sessionId);
  if (!key) return undefined;
  return states.get(key);
}

export function isPlanMode(sessionId: string | undefined): boolean {
  const state = planModeState(sessionId);
  return state !== undefined && state.active;
}

export function enterPlanMode(sessionId: string | undefined, reason: string): PlanModeState {
  const key = slot(sessionId);
  const next: PlanModeState = {
    active: true,
    reason: reason.trim().slice(0, 400),
    enteredAt: Date.now(),
  };
  if (key) states.set(key, next);
  return next;
}

/** Lifts the PLAN-MODE flag only. An RSAT lock is independent and stays. */
export function exitPlanMode(sessionId: string | undefined): void {
  const key = slot(sessionId);
  if (key) states.delete(key);
}

/* ------------------------------------------------------------------ *
 * RSAT PLAN LOCK — the macro layer's contribution to the same gate.
 * ------------------------------------------------------------------ */

/** Same relative location RSA/T's own store uses (`.moriko/rsat/`). */
const RSAT_PRD_FILE = path.join('.moriko', 'rsat', 'prd.rsprd.json');

/** workspace path → last read, so the gate stays off the disk hot path. */
const lockCache = new Map<string, { at: number; lock: RsatLock | null }>();
const LOCK_TTL_MS = 1_000;

export interface RsatLock {
  status: string;
  title: string;
  achievements: number;
}

/** The only fields this gate reads out of an RSA/T document. */
interface RsatPrdFields {
  status?: unknown;
  title?: unknown;
}

interface RsatDocShape {
  prd?: RsatPrdFields;
  achievements?: unknown;
}

/**
 * An RSA/T PRD that exists but has not been STARTED means the user is still
 * shaping the plan. The agent may help shape it (`rsat_prd`,
 * `rsat_achievement`) and may explore freely, but no code is written until
 * `prd.status === 'running'`.
 *
 * Two deliberate non-locks:
 *   - `done` / `archived` never lock: the project is finished, and blocking a
 *     workspace forever because of an old board would be worse than useless.
 *   - a `draft` with ZERO achievements never locks: that is an empty shell,
 *     not a plan in progress, and paralysing unrelated work over it would be
 *     a bug dressed as discipline.
 */
export function rsatLock(sessionId: string | undefined): RsatLock | null {
  const ws = getActiveWorkspace(sessionId);
  if (!ws || !ws.path) return null;

  // The gate runs on EVERY tool call; a synchronous read per call would put
  // disk I/O in the hot path of the whole harness. A short TTL is enough —
  // pressing Start on the board takes effect within a second.
  const cached = lockCache.get(ws.path);
  if (cached && Date.now() - cached.at < LOCK_TTL_MS) return cached.lock;

  const lock = readRsatLock(ws.path);
  lockCache.set(ws.path, { at: Date.now(), lock });
  return lock;
}

function readRsatLock(root: string): RsatLock | null {
  let doc: RsatDocShape;
  try {
    doc = JSON.parse(readFileSync(path.join(root, RSAT_PRD_FILE), 'utf8')) as RsatDocShape;
  } catch {
    return null; // no board, or unreadable — not this gate's business
  }

  const prd = doc.prd;
  const status = prd && typeof prd.status === 'string' ? prd.status : '';
  if (status !== 'draft' && status !== 'paused') return null;

  const achievements = Array.isArray(doc.achievements) ? doc.achievements.length : 0;
  if (status === 'draft' && achievements === 0) return null;

  const rawTitle = prd ? prd.title : undefined;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : '(untitled)';
  return { status, title, achievements };
}

/* ------------------------------------------------------------------ *
 * THE GATE POLICY — one table, read by the pipeline hook.
 * ------------------------------------------------------------------ */

/** Every tool that WRITES project files. Refused in plan mode / RSAT lock. */
const FILE_MUTATION_TOOLS = new Set([
  'edit_file', 'multi_edit', 'edit_lines', 'edit_between', 'insert_at_line',
  'write', 'apply_patch', 'layout_edit',
  'rename', 'move', 'copy', 'delete',
  // Restores a snapshot over live files — a write with a friendlier name.
  'vault_restore',
  'undo',
]);

/** Tools that run arbitrary commands or mutate the harness runtime. */
const EXECUTION_TOOLS = new Set([
  'run', 'exec', 'task_start', 'task_stop', 'task_output', 'harness_reload',
]);

/** git subcommands that only READ. Anything else counts as a mutation. */
const READONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files',
  'describe', 'shortlog',
]);

/** addon_manage actions that only READ. */
const READONLY_ADDON_ACTIONS = new Set(['list', 'read']);

/**
 * Why this call is a mutation, or null when it is not. Kept separate from the
 * denial text so the same classification can be reused by future gates.
 */
function mutationReason(name: string, args: Record<string, unknown>): string | null {
  if (FILE_MUTATION_TOOLS.has(name)) return 'it writes files';
  if (EXECUTION_TOOLS.has(name)) return 'it runs commands or mutates the harness runtime';

  if (name === 'git') {
    const rawSub = typeof args.subcommand === 'string' ? args.subcommand : '';
    const rawCmd = typeof args.command === 'string' ? args.command : '';
    const raw = rawSub || rawCmd;
    const head = raw.trim().toLowerCase().split(/\s+/)[0];
    const sub = head === undefined ? '' : head;
    if (!READONLY_GIT.has(sub)) {
      return 'it runs a mutating git command (' + (sub || 'unknown') + ')';
    }
    return null;
  }

  if (name === 'addon_manage') {
    const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
    if (!READONLY_ADDON_ACTIONS.has(action)) {
      return 'it writes addon source files (' + (action || 'unknown') + ')';
    }
    return null;
  }

  return null;
}

const ALLOWED_NOW =
  'Allowed now: exploration (read_file, batch_read, grep, glob, read_symbol, context_pack, arch_map, ' +
  'lsp_symbols, tree_outline, deps, interlinked, list), ask_user, adr, todo_*, and the rsat_* planning tools.';

/**
 * The single question the pipeline asks before every tool call.
 * Returns a readable refusal, or null when the call may proceed.
 */
export function planGateDenial(
  name: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): string | null {
  const why = mutationReason(name, args);
  if (!why) return null;
  const tool = 'agent__' + name;

  // The RSAT lock outranks plan mode: it is a cross-session contract, and its
  // exit is a user action, not something the agent can talk its way past.
  const lock = rsatLock(sessionId);
  if (lock) {
    return [
      'RSAT PLAN LOCK — ' + tool + ' is blocked (' + why + '). Nothing was written or run.',
      'The workspace carries an RSA/T PRD titled ' + lock.title + ' with status ' + lock.status +
        '. The user has not pressed Start, so no code may be written yet.',
      ALLOWED_NOW,
      'To lift: the USER presses Start on the RSA/T board (agents cannot start a PRD). ' +
        'Until then, shape the plan with rsat_prd / rsat_achievement instead of editing.',
    ].join('\n');
  }

  const state = planModeState(sessionId);
  if (state && state.active) {
    return [
      'PLAN MODE — ' + tool + ' is blocked (' + why + '). Nothing was written or run.',
      state.reason
        ? 'This session is planning because: ' + state.reason
        : 'This session is in plan mode.',
      ALLOWED_NOW,
      'To start implementing: call agent__exit_plan_mode with the structured plan — ' +
        'summary, files[], approach. That records the plan and lifts this gate.',
    ].join('\n');
  }

  return null;
}

/** The current posture, for the system-prompt injection. */
export interface PlanPosture {
  plan: PlanModeState | null;
  lock: RsatLock | null;
}

export function planModePosture(sessionId: string | undefined): PlanPosture {
  const plan = planModeState(sessionId);
  return {
    plan: plan === undefined ? null : plan,
    lock: rsatLock(sessionId),
  };
}
