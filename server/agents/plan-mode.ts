
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getActiveWorkspace } from './workspace.js';

export interface PlanModeState {
  active: boolean;
  
  reason: string;
  enteredAt: number;
}


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


export function exitPlanMode(sessionId: string | undefined): void {
  const key = slot(sessionId);
  if (key) states.delete(key);
}



const RSAT_PRD_FILE = path.join('.moriko', 'rsat', 'prd.rsprd.json');


const lockCache = new Map<string, { at: number; lock: RsatLock | null }>();
const LOCK_TTL_MS = 1_000;

export interface RsatLock {
  status: string;
  title: string;
  achievements: number;
}


interface RsatPrdFields {
  status?: unknown;
  title?: unknown;
}

interface RsatDocShape {
  prd?: RsatPrdFields;
  achievements?: unknown;
}


export function rsatLock(sessionId: string | undefined): RsatLock | null {
  const ws = getActiveWorkspace(sessionId);
  if (!ws || !ws.path) return null;

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
    return null;
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



const FILE_MUTATION_TOOLS = new Set([
  'edit_file', 'multi_edit', 'edit_lines', 'edit_between', 'insert_at_line',
  'write', 'overwrite', 'apply_patch', 'layout_edit',
  'rename', 'move', 'copy', 'delete',
  'vault_restore',
  'undo',
]);


const EXECUTION_TOOLS = new Set([
  'run', 'exec', 'task_start', 'task_stop', 'task_output', 'harness_reload',
]);


const READONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files',
  'describe', 'shortlog',
]);


const READONLY_ADDON_ACTIONS = new Set(['list', 'read']);


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


export function planGateDenial(
  name: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): string | null {
  const why = mutationReason(name, args);
  if (!why) return null;
  const tool = 'agent__' + name;

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
