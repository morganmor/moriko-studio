import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { chatDirFor } from '../conversationStore.js';
import { appDataDir, detachedGoalsDir } from '../paths.js';

/**
 * GOALS / PLANS / TODOS store for the agent harness (Context Injection).
 *
 * Goals live per conversation session (keyed by the conversation id the
 * client sends with every chat request). The AGENT manages them through the
 * `goal_*` harness tools; the USER manages them through the Goals panel
 * (REST in routes.ts). Each session's goals persist NEXT TO ITS CHAT —
 * `.data/conversation/<chat-…>/goals-plan.json` — so a chat folder carries
 * everything about that conversation: its record and its plan. Sessions with
 * no archived chat (synthetic/test ids) fall back to
 * `.data/conversation/detached/<session>.json`.
 *
 * A goal is the PARENT of its plan text and its todo checklist. Status is
 * bookkeeping surfaced to the agent and the user — nothing auto-continues
 * the conversation; the user drives the next message.
 */

export type GoalStatus = 'running' | 'paused' | 'done';

export interface GoalTodo {
  id: string;
  text: string;
  done: boolean;
  /** Optional nested checklist ("checklist dalam checklist"), one level deep. */
  subtasks?: GoalSubtask[];
}

export interface GoalSubtask {
  id: string;
  text: string;
  done: boolean;
}

export interface Goal {
  id: string;
  title: string;
  /** The plan: how the agent intends to reach the goal. */
  plan: string;
  status: GoalStatus;
  todos: GoalTodo[];
  createdAt: number;
  updatedAt: number;
  /** How many automatic continuation rounds this goal has consumed. */
  loopCount: number;
  /**
   * MODEL-OWNED round budget (goal_update): how many auto-continuation rounds
   * the model allows itself. Undefined = the harness default cap; 0 = the
   * model opted out of auto rounds entirely.
   */
  maxRounds?: number;
  /**
   * MODEL-OWNED injection cadence (goal_update): re-inject the FULL goal
   * context after every N completed todos (top-level + subtasks). The
   * client defaults to 3 when unset.
   */
  injectEveryTodos?: number;
}

const MAX_TITLE = 200;
const MAX_PLAN = 8_000;
const MAX_TODO_TEXT = 300;
const MAX_TODOS = 100;
const MAX_GOALS_PER_SESSION = 20;

/** Pre-restructure single-file store (sessions with no chat folder kept here too). */
const LEGACY_GOALS_FILE = path.join(appDataDir, 'goals.json');

/** session → goals. Lazily loaded per session, written through on change. */
const store = new Map<string, Goal[]>();
let legacySplit = false;

function safeSession(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

/** Where this session's goals live on disk (chat folder first, detached else). */
function goalsFileFor(sessionId: string): string {
  const chatDir = chatDirFor(sessionId);
  if (chatDir) return path.join(chatDir, 'goals-plan.json');
  return path.join(detachedGoalsDir, `${safeSession(sessionId)}.json`);
}

function isGoal(value: unknown): value is Goal {
  const goal = value as Goal;
  return (
    typeof goal?.id === 'string' &&
    typeof goal?.title === 'string' &&
    typeof goal?.plan === 'string' &&
    (goal?.status === 'running' || goal?.status === 'paused' || goal?.status === 'done') &&
    Array.isArray(goal?.todos)
  );
}

/**
 * One-time split of the legacy `.data/goals.json` (Record<session, Goal[]>)
 * into the per-chat files. The original is parked as `.migrated`.
 */
function splitLegacyGoals(): void {
  if (legacySplit) return;
  legacySplit = true;
  if (!existsSync(LEGACY_GOALS_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(LEGACY_GOALS_FILE, 'utf8')) as Record<string, unknown>;
    for (const [session, value] of Object.entries(raw)) {
      if (!Array.isArray(value)) continue;
      const goals = value.filter((goal): goal is Goal => isGoal(goal));
      if (goals.length === 0) continue;
      store.set(session, goals);
      persistSession(session);
    }
    renameSync(LEGACY_GOALS_FILE, `${LEGACY_GOALS_FILE}.migrated`);
  } catch {
  }
}

function loadSession(sessionId: string): Goal[] {
  splitLegacyGoals();
  const cached = store.get(sessionId);
  if (cached) return cached;
  const goals: Goal[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(goalsFileFor(sessionId), 'utf8'));
    if (Array.isArray(parsed)) {
      for (const goal of parsed) if (isGoal(goal)) goals.push(goal);
    }
  } catch {
  }
  store.set(sessionId, goals);
  return goals;
}

/** Best-effort persist of ONE session's goals into its own file. */
function persistSession(sessionId: string): void {
  try {
    const file = goalsFileFor(sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJson(file, store.get(sessionId) ?? []);
  } catch {
  }
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function listGoals(sessionId: string): Goal[] {
  return [...loadSession(sessionId)];
}

export function createGoal(
  sessionId: string,
  input: { title?: unknown; plan?: unknown; todos?: unknown },
): Goal {
  const goals = loadSession(sessionId);
  if (goals.length >= MAX_GOALS_PER_SESSION) {
    throw new Error(`This session already has ${MAX_GOALS_PER_SESSION} goals — finish or delete one first.`);
  }
  const title = cleanText(input.title, MAX_TITLE);
  if (!title) throw new Error('A goal needs a non-empty "title".');
  const rawTodos = Array.isArray(input.todos) ? input.todos : [];
  const now = Date.now();
  const goal: Goal = {
    id: randomUUID(),
    title,
    plan: cleanText(input.plan, MAX_PLAN),
    status: 'running',
    todos: rawTodos.slice(0, MAX_TODOS).map((text) => ({
      id: randomUUID().slice(0, 8),
      text: cleanText(text, MAX_TODO_TEXT),
      done: false,
    })).filter((todo) => todo.text),
    createdAt: now,
    updatedAt: now,
    loopCount: 0,
  };
  store.set(sessionId, [...goals, goal]);
  persistSession(sessionId);
  return goal;
}

export interface GoalPatch {
  title?: unknown;
  plan?: unknown;
  status?: unknown;
  /** Todo checkoff by id: { id, done }. */
  todos?: unknown;
  /** Add a subtask: { todoId, text }. */
  addSubtask?: unknown;
  /** Subtask checkoff by id: { id, done } — ids are unique across the goal. */
  setSubtask?: unknown;
  loopCount?: unknown;
  /** Model-owned: auto-continuation round budget (0 = no auto rounds). */
  maxRounds?: unknown;
  /** Model-owned: full goal-context re-injection cadence in completed todos. */
  injectEveryTodos?: unknown;
}

const MAX_SUBTASKS_PER_TODO = 20;

export function updateGoal(sessionId: string, goalId: string, patch: GoalPatch): Goal {
  const goals = loadSession(sessionId);
  const goal = goals.find((entry) => entry.id === goalId);
  if (!goal) throw new Error(`Unknown goal id: ${goalId}`);

  if (patch.title !== undefined) {
    const title = cleanText(patch.title, MAX_TITLE);
    if (!title) throw new Error('Goal title cannot be empty.');
    goal.title = title;
  }
  if (patch.plan !== undefined) goal.plan = cleanText(patch.plan, MAX_PLAN);
  if (patch.status !== undefined) {
    if (patch.status !== 'running' && patch.status !== 'paused' && patch.status !== 'done') {
      throw new Error('Goal status must be "running", "paused" or "done".');
    }
    goal.status = patch.status;
  }
  if (Array.isArray(patch.todos)) {
    for (const entry of patch.todos as Array<{ id?: unknown; done?: unknown }>) {
      const todo = goal.todos.find((candidate) => candidate.id === entry?.id);
      if (todo && typeof entry.done === 'boolean') todo.done = entry.done;
    }
  }
  if (patch.addSubtask && typeof patch.addSubtask === 'object') {
    const spec = patch.addSubtask as { todoId?: unknown; text?: unknown };
    const todo = goal.todos.find((candidate) => candidate.id === spec?.todoId);
    const text = cleanText(spec?.text, MAX_TODO_TEXT);
    if (!todo) throw new Error(`Unknown todo id for subtask: ${String(spec?.todoId)}`);
    if (!text) throw new Error('A subtask needs non-empty text.');
    if (!todo.subtasks) todo.subtasks = [];
    if (todo.subtasks.length >= MAX_SUBTASKS_PER_TODO) {
      throw new Error(`Todo "${todo.text.slice(0, 40)}" already has ${MAX_SUBTASKS_PER_TODO} subtasks.`);
    }
    todo.subtasks.push({ id: randomUUID().slice(0, 8), text, done: false });
  }
  if (Array.isArray(patch.setSubtask)) {
    for (const entry of patch.setSubtask as Array<{ id?: unknown; done?: unknown }>) {
      for (const todo of goal.todos) {
        const subtask = todo.subtasks?.find((candidate) => candidate.id === entry?.id);
        if (subtask && typeof entry.done === 'boolean') subtask.done = entry.done;
      }
    }
  }
  if (typeof patch.loopCount === 'number' && Number.isFinite(patch.loopCount)) {
    goal.loopCount = Math.max(0, Math.min(10_000, Math.trunc(patch.loopCount)));
  }
  if (patch.maxRounds !== undefined) {
    if (typeof patch.maxRounds !== 'number' || !Number.isFinite(patch.maxRounds)) {
      throw new Error('maxRounds must be a number (0 = no auto rounds).');
    }
    goal.maxRounds = Math.max(0, Math.min(10_000, Math.trunc(patch.maxRounds)));
  }
  if (patch.injectEveryTodos !== undefined) {
    if (typeof patch.injectEveryTodos !== 'number' || !Number.isFinite(patch.injectEveryTodos)) {
      throw new Error('injectEveryTodos must be a number >= 1.');
    }
    goal.injectEveryTodos = Math.max(1, Math.min(100, Math.trunc(patch.injectEveryTodos)));
  }
  goal.updatedAt = Date.now();
  persistSession(sessionId);
  return goal;
}

export function deleteGoal(sessionId: string, goalId: string): boolean {
  const goals = loadSession(sessionId);
  const next = goals.filter((goal) => goal.id !== goalId);
  if (next.length === goals.length) return false;
  store.set(sessionId, next);
  persistSession(sessionId);
  return true;
}

/** Renders the goal state for the model's context injection. */
export function renderGoalsForContext(goals: Goal[]): string {
  return goals
    .map((goal) => {
      const todos = goal.todos.length
        ? goal.todos
            .map((todo) => {
              const line = `  - [${todo.done ? 'x' : ' '}] (${todo.id}) ${todo.text}`;
              const subs = todo.subtasks?.length
                ? todo.subtasks.map((sub) => `\n      · [${sub.done ? 'x' : ' '}] (${sub.id}) ${sub.text}`).join('')
                : '';
              return line + subs;
            })
            .join('\n')
        : '  (no todos yet)';
      return [
        `### Goal "${goal.title}" — status: ${goal.status} (id: ${goal.id})`,
        goal.plan ? `Plan:\n${goal.plan}` : '(no plan written)',
        `Todos:\n${todos}`,
      ].join('\n');
    })
    .join('\n\n');
}
