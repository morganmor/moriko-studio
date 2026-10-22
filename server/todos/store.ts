import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { chatDirFor } from '../conversationStore.js';
import { detachedTodosDir } from '../paths.js';

/**
 * STANDALONE TODOS store — todos that exist WITHOUT a parent goal.
 *
 * This is a STATE MACHINE, not a passive checklist. Two invariants are
 * enforced here (the third — no false completion — needs the diagnostics
 * ledger and is enforced by the tool layer, which can see the build):
 *
 *   1. SINGLE ACTIVE FOCUS — at most one todo is in_progress. Two "current"
 *      tasks means the model has stopped deciding what it is doing.
 *   2. NO SHORTCUT — pending cannot jump to completed. It must pass through
 *      in_progress, which requires an activeForm: one present-continuous
 *      sentence naming the work actually happening. That sentence is the
 *      difference between a plan and a claim.
 *
 * The legacy `done` boolean is still accepted and still read by the UI, but it
 * is DERIVED from `state` — never an independent flag. Both are written
 * together so no reader can observe them disagreeing.
 *
 * Per-session storage, same pattern as goals: NEXT TO THE CHAT folder
 * (todos.json), falling back to the detached dir for synthetic session ids.
 */

export type TodoPriority = 'low' | 'medium' | 'high';
export type TodoState = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  id: string;
  text: string;
  /** The state machine — the ONLY authority on whether work is finished. */
  state: TodoState;
  /** Derived mirror of state === completed (kept for older readers/UI). */
  done: boolean;
  /** Present continuous: what is happening NOW. Required while in_progress. */
  activeForm?: string;
  priority: TodoPriority;
  /** Optional longer-form detail the agent or user attached. */
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

const MAX_TEXT = 300;
const MAX_NOTES = 2_000;
const MAX_ACTIVE_FORM = 200;
const MAX_TODOS = 200;

/** session → todos. Lazily loaded per session, written through on change. */
const store = new Map<string, Todo[]>();

function safeSession(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

function todosFileFor(sessionId: string): string {
  const chatDir = chatDirFor(sessionId);
  if (chatDir) return path.join(chatDir, 'todos.json');
  return path.join(detachedTodosDir, `${safeSession(sessionId)}.json`);
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizePriority(value: unknown): TodoPriority {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'medium';
}

function isState(value: unknown): value is TodoState {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

/**
 * Reads one persisted record, healing legacy shapes. A record written before
 * the state machine existed carries only `done` — it is mapped onto the
 * nearest legal state rather than discarded.
 */
function normalizeTodo(value: unknown): Todo | null {
  const raw = value as Partial<Todo> | null;
  if (!raw || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null;
  const state: TodoState = isState(raw.state) ? raw.state : raw.done === true ? 'completed' : 'pending';
  const activeForm = cleanText(raw.activeForm, MAX_ACTIVE_FORM);
  const notes = cleanText(raw.notes, MAX_NOTES);
  const todo: Todo = {
    id: raw.id,
    text: raw.text,
    state,
    done: state === 'completed',
    priority: normalizePriority(raw.priority),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
  if (activeForm) todo.activeForm = activeForm;
  if (notes) todo.notes = notes;
  return todo;
}

function loadSession(sessionId: string): Todo[] {
  const cached = store.get(sessionId);
  if (cached) return cached;
  const todos: Todo[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(todosFileFor(sessionId), 'utf8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const todo = normalizeTodo(entry);
        if (todo) todos.push(todo);
      }
    }
  } catch {
  }
  store.set(sessionId, todos);
  return todos;
}

function persistSession(sessionId: string): void {
  try {
    const file = todosFileFor(sessionId);
    mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJson(file, store.get(sessionId) ?? []);
  } catch {
  }
}

const PRIORITY_ORDER: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };
const STATE_ORDER: Record<TodoState, number> = { in_progress: 0, pending: 1, completed: 2 };

export function listTodos(sessionId: string): Todo[] {
  const todos = [...loadSession(sessionId)];
  todos.sort((a, b) => {
    const sd = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (sd !== 0) return sd;
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return a.createdAt - b.createdAt;
  });
  return todos;
}

export function createTodo(
  sessionId: string,
  input: { text?: unknown; priority?: unknown; notes?: unknown },
): Todo {
  const todos = loadSession(sessionId);
  if (todos.length >= MAX_TODOS) {
    throw new Error(`This session already has ${MAX_TODOS} todos — finish or delete some first.`);
  }
  const text = cleanText(input.text, MAX_TEXT);
  if (!text) throw new Error('A todo needs non-empty "text".');
  const now = Date.now();
  const todo: Todo = {
    id: randomUUID().slice(0, 8),
    text,
    // Creation never starts work: activating it is a separate, deliberate act.
    state: 'pending',
    done: false,
    priority: normalizePriority(input.priority),
    createdAt: now,
    updatedAt: now,
  };
  const notes = cleanText(input.notes, MAX_NOTES);
  if (notes) todo.notes = notes;
  store.set(sessionId, [...todos, todo]);
  persistSession(sessionId);
  return todo;
}

export interface TodoPatch {
  text?: unknown;
  state?: unknown;
  done?: unknown;
  activeForm?: unknown;
  priority?: unknown;
  notes?: unknown;
}

/**
 * The state a patch is asking for, without applying it. Exported so the tool
 * layer can run its own (build-aware) checks BEFORE the store mutates — and so
 * the same resolution rules are never duplicated.
 */
export function targetStateOf(todo: Todo, patch: TodoPatch): TodoState {
  if (isState(patch.state)) return patch.state;
  if (typeof patch.state === 'string' && patch.state.trim()) {
    const raw = patch.state.trim().toLowerCase();
    if (isState(raw)) return raw;
    throw new Error('state must be "pending", "in_progress" or "completed".');
  }
  if (typeof patch.done === 'boolean') return patch.done ? 'completed' : 'pending';
  return todo.state;
}

/** The single legal-transition check. Throws with an actionable message. */
function assertTransition(todos: Todo[], todo: Todo, next: TodoState, activeForm: string): void {
  if (next === todo.state) return;

  if (next === 'in_progress') {
    if (!activeForm) {
      throw new Error(
        'Moving ' + todo.id + ' to in_progress needs activeForm — one present-continuous sentence ' +
          'describing the work happening now (e.g. Rewriting the skills frontmatter parser). ' +
          'Without it the panel shows a task nobody is doing.',
      );
    }
    const holder = todos.find((entry) => entry.id !== todo.id && entry.state === 'in_progress');
    if (holder) {
      const label = holder.activeForm || holder.text;
      throw new Error(
        'Single active focus: ' + holder.id + ' is already in_progress (' + label + '). ' +
          'Finish it (state completed) or park it (state pending) before starting ' + todo.id + '.',
      );
    }
    return;
  }

  if (next === 'completed' && todo.state === 'pending') {
    throw new Error(
      todo.id + ' cannot jump from pending to completed. Move it to in_progress (with ' +
        'activeForm) first, do the work, then complete it — that is what keeps the checklist honest.',
    );
  }
}

export function updateTodo(sessionId: string, todoId: string, patch: TodoPatch): Todo {
  const todos = loadSession(sessionId);
  const todo = todos.find((entry) => entry.id === todoId);
  if (!todo) throw new Error(`Unknown todo id: ${todoId}`);

  if (patch.text !== undefined) {
    const text = cleanText(patch.text, MAX_TEXT);
    if (!text) throw new Error('Todo text cannot be empty.');
    todo.text = text;
  }
  if (patch.priority !== undefined) todo.priority = normalizePriority(patch.priority);
  if (patch.notes !== undefined) {
    const notes = cleanText(patch.notes, MAX_NOTES);
    todo.notes = notes || undefined;
  }

  const next = targetStateOf(todo, patch);
  const activeForm = cleanText(patch.activeForm, MAX_ACTIVE_FORM);
  assertTransition(todos, todo, next, activeForm);

  if (next !== todo.state) {
    if (next === 'in_progress') {
      todo.activeForm = activeForm;
    } else if (next === 'pending') {
      // Parking or reopening: the live description is no longer true.
      if (activeForm) todo.activeForm = activeForm;
      else delete todo.activeForm;
    } else {
      // Completion: nothing is currently happening any more.
      delete todo.activeForm;
    }
    todo.state = next;
    todo.done = next === 'completed';
  } else if (activeForm && next === 'in_progress') {
    // Same state, refreshed description — allowed and useful.
    todo.activeForm = activeForm;
  }

  todo.updatedAt = Date.now();
  persistSession(sessionId);
  return todo;
}

export function deleteTodo(sessionId: string, todoId: string): boolean {
  const todos = loadSession(sessionId);
  const next = todos.filter((todo) => todo.id !== todoId);
  if (next.length === todos.length) return false;
  store.set(sessionId, next);
  persistSession(sessionId);
  return true;
}

const STATE_LABEL: Record<TodoState, string> = {
  pending: ' ',
  in_progress: '~',
  completed: 'x',
};

/** Renders the standalone todo state for the model's context injection. */
export function renderTodosForContext(todos: Todo[]): string {
  if (todos.length === 0) return '(no standalone todos)';
  const open = todos.filter((todo) => todo.state !== 'completed');
  const done = todos.filter((todo) => todo.state === 'completed');
  const render = (todo: Todo) => {
    const marker = STATE_LABEL[todo.state];
    const live = todo.state === 'in_progress' && todo.activeForm ? ' — doing: ' + todo.activeForm : '';
    const line = '- [' + marker + '] (' + todo.id + ') [' + todo.priority + '] ' + todo.text + live;
    return todo.notes ? `${line}\n  notes: ${todo.notes}` : line;
  };
  const parts: string[] = [];
  if (open.length) parts.push('Open:', ...open.map(render));
  if (done.length) parts.push('Done:', ...done.map(render));
  return parts.join('\n');
}
