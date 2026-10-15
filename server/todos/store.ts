import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { chatDirFor } from '../conversationStore.js';
import { detachedTodosDir } from '../paths.js';

/**
 * STANDALONE TODOS store — todos that exist WITHOUT a parent goal.
 *
 * The agent must create todos whenever it works on user input (system prompt
 * rule). Goals are optional and only for large-scale work. Before this module,
 * the agent had no way to create a todo without also creating a goal — it was
 * forced to spin up a `goal_create` just to have a checklist. This store fixes
 * that: `todo_create` makes a standalone todo, `todo_update` checks it off, and
 * the TodoPanel renders them independently of the Goals panel.
 *
 * Per-session storage, same pattern as goals: NEXT TO THE CHAT folder
 * (`todos.json`), falling back to the detached dir for synthetic session ids.
 */

export type TodoPriority = 'low' | 'medium' | 'high';

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  priority: TodoPriority;
  /** Optional longer-form detail the agent or user attached. */
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

const MAX_TEXT = 300;
const MAX_NOTES = 2_000;
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

function isTodo(value: unknown): value is Todo {
  const todo = value as Todo;
  return (
    typeof todo?.id === 'string' &&
    typeof todo?.text === 'string' &&
    typeof todo?.done === 'boolean' &&
    (todo?.priority === 'low' || todo?.priority === 'medium' || todo?.priority === 'high')
  );
}

function loadSession(sessionId: string): Todo[] {
  const cached = store.get(sessionId);
  if (cached) return cached;
  const todos: Todo[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(todosFileFor(sessionId), 'utf8'));
    if (Array.isArray(parsed)) {
      for (const todo of parsed) if (isTodo(todo)) todos.push(todo);
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

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizePriority(value: unknown): TodoPriority {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'medium';
}

const PRIORITY_ORDER: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };

export function listTodos(sessionId: string): Todo[] {
  const todos = [...loadSession(sessionId)];
  todos.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
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
    done: false,
    priority: normalizePriority(input.priority),
    notes: cleanText(input.notes, MAX_NOTES) || undefined,
    createdAt: now,
    updatedAt: now,
  };
  store.set(sessionId, [...todos, todo]);
  persistSession(sessionId);
  return todo;
}

export interface TodoPatch {
  text?: unknown;
  done?: unknown;
  priority?: unknown;
  notes?: unknown;
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
  if (typeof patch.done === 'boolean') todo.done = patch.done;
  if (patch.priority !== undefined) todo.priority = normalizePriority(patch.priority);
  if (patch.notes !== undefined) {
    const notes = cleanText(patch.notes, MAX_NOTES);
    todo.notes = notes || undefined;
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

/** Renders the standalone todo state for the model's context injection. */
export function renderTodosForContext(todos: Todo[]): string {
  if (todos.length === 0) return '(no standalone todos)';
  const open = todos.filter((todo) => !todo.done);
  const done = todos.filter((todo) => todo.done);
  const render = (todo: Todo) => {
    const line = `- [${todo.done ? 'x' : ' '}] (${todo.id}) [${todo.priority}] ${todo.text}`;
    return todo.notes ? `${line}\n  notes: ${todo.notes}` : line;
  };
  const parts: string[] = [];
  if (open.length) parts.push('Open:', ...open.map(render));
  if (done.length) parts.push('Done:', ...done.map(render));
  return parts.join('\n');
}
