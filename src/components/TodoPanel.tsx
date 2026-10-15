import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ListTodo,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from './icons';

import { createTodoApi, deleteTodoApi, fetchTodos, patchTodoApi } from '../lib/api';
import type { Todo } from '../types';
import { useStore } from '../store/useStore';
import { cx } from './ui';

interface TodoPanelProps {
  open: boolean;
  onClose: () => void;
}

type FilterMode = 'all' | 'open' | 'done';

const PRIORITIES: Array<{ value: Todo['priority']; label: string }> = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

/**
 * STANDALONE TODOS panel — todos that live WITHOUT a parent goal.
 *
 * The agent creates todos via the `todo_*` harness tools whenever it works on
 * user input (system prompt rule). This panel gives the user the same power:
 * quick-add with priority/notes, filter, toggle, edit, and delete.
 * Goals stay in the Goals panel — reserved for large-scale implementations.
 */
export function TodoPanel({ open, onClose }: TodoPanelProps) {
  const conversation = useStore((state) => state.activeConversation());
  const setConversationTodos = useStore((state) => state.setConversationTodos);
  const showNotice = useStore((state) => state.showNotice);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftPriority, setDraftPriority] = useState<Todo['priority']>('medium');
  const [draftNotes, setDraftNotes] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editPriority, setEditPriority] = useState<Todo['priority']>('medium');
  const [editNotes, setEditNotes] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  const sessionId = conversation?.id;
  const todos = conversation?.todos ?? [];

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    fetchTodos(sessionId)
      .then((fresh) => {
        if (!cancelled) setConversationTodos(sessionId, fresh);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, setConversationTodos]);

  /* CLOSE ON OUTSIDE CLICK — same pattern as CommandPalette/Popover. Ignores
     clicks inside the panel and on plus-menu rows that toggle it (otherwise
     pointerdown closes, then the toggle's click re-opens → flicker). */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (target.closest('[data-plus-item]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const doneCount = todos.filter((todo) => todo.done).length;
  const openCount = todos.length - doneCount;
  const percent = todos.length ? Math.round((doneCount / todos.length) * 100) : 0;
  const visible = todos.filter((todo) =>
    filter === 'all' ? true : filter === 'open' ? !todo.done : todo.done,
  );

  const add = async () => {
    const text = draft.trim();
    if (!sessionId || !text) return;
    setAdding(true);
    try {
      const todo = await createTodoApi(sessionId, {
        text,
        priority: draftPriority,
        notes: draftNotes.trim() || undefined,
      });
      setConversationTodos(sessionId, [...todos, todo]);
      setDraft('');
      setDraftNotes('');
      setDraftPriority('medium');
      if (filter === 'done') setFilter('all');
    } catch (cause) {
      showNotice('todo.addFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (todo: Todo, done: boolean) => {
    if (!sessionId) return;
    try {
      const fresh = await patchTodoApi(sessionId, todo.id, { done });
      setConversationTodos(sessionId, todos.map((entry) => (entry.id === fresh.id ? fresh : entry)));
    } catch (cause) {
      showNotice('todo.updateFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    }
  };

  const startEdit = (todo: Todo) => {
    setEditingId(todo.id);
    setEditText(todo.text);
    setEditPriority(todo.priority);
    setEditNotes(todo.notes ?? '');
  };

  const saveEdit = async () => {
    if (!sessionId || !editingId) return;
    const text = editText.trim();
    if (!text) return;
    try {
      const fresh = await patchTodoApi(sessionId, editingId, {
        text,
        priority: editPriority,
        notes: editNotes.trim() || undefined,
      });
      setConversationTodos(sessionId, todos.map((entry) => (entry.id === fresh.id ? fresh : entry)));
      setEditingId(null);
    } catch (cause) {
      showNotice('todo.updateFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    }
  };

  const remove = async (todoId: string) => {
    if (!sessionId) return;
    if (confirmDeleteId !== todoId) {
      setConfirmDeleteId(todoId);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await deleteTodoApi(sessionId, todoId);
      setConversationTodos(sessionId, todos.filter((entry) => entry.id !== todoId));
    } catch (cause) {
      showNotice('todo.deleteFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    }
  };

  const priorityChips = (
    value: Todo['priority'],
    setValue: (next: Todo['priority']) => void,
  ) =>
    PRIORITIES.map((entry) => (
      <button
        key={entry.value}
        type="button"
        className={cx('todop-chip', value === entry.value ? 'on' : undefined)}
        aria-pressed={value === entry.value}
        onClick={() => setValue(entry.value)}
      >
        <span
          className="todop-dot"
          style={{ background: `rgb(var(--c-todo-${entry.value}))` }}
          aria-hidden="true"
        />
        {entry.label}
      </button>
    ));

  return (
    <aside
      ref={rootRef}
      aria-label="Todos"
      style={{
        position: 'fixed',
        right: 12,
        top: 12,
        zIndex: 40,
        display: 'flex',
        height: 'calc(100vh - 1.5rem)',
        width: 380,
        maxWidth: 'calc(100vw - 1.5rem)',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 'var(--r-lg)',
        border: '1px solid var(--line)',
        background: 'rgb(var(--c-canvas))',
        boxShadow: 'var(--sh2)',
        animation: 'mIn .25s var(--ease)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 0' }}>
        <ListTodo className="ic" style={{ width: 20, height: 20, color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.2, color: 'rgb(var(--c-ink))' }}>Todos</h2>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {sessionId
              ? todos.length
                ? `${doneCount} of ${todos.length} done`
                : 'Nothing planned yet'
              : 'Open a chat first'}
          </div>
        </div>
        {loading ? <Loader2 className="ic spin" style={{ color: 'var(--faint)' }} aria-hidden="true" /> : null}
        <button type="button" className="ib" aria-label="Close todos panel" onClick={onClose}>
          <X className="ic" aria-hidden="true" />
        </button>
      </header>

      <div style={{ padding: '12px 16px 0' }}>
        <div className="todop-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div style={{ padding: '12px 16px 0', display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void add();
            }
          }}
          placeholder="Add a todo and press Enter"
          aria-label="New todo text"
          className="field"
          style={{ flex: 1, fontSize: 12.5 }}
        />
        <button type="button" className="btn primary sm" onClick={() => void add()} disabled={adding || !draft.trim()}>
          {adding ? <Loader2 className="ic spin" aria-hidden="true" /> : <Plus className="ic" aria-hidden="true" />}
          Add
        </button>
      </div>

      <div style={{ padding: '8px 16px 0', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {priorityChips(draftPriority, setDraftPriority)}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={cx('todop-chip', notesOpen ? 'on' : undefined)}
          aria-pressed={notesOpen}
          onClick={() => setNotesOpen((value) => !value)}
        >
          <Pencil className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
          Note
        </button>
      </div>
      {notesOpen ? (
        <div style={{ padding: '6px 16px 0' }}>
          <textarea
            value={draftNotes}
            onChange={(event) => setDraftNotes(event.target.value)}
            placeholder="Add details for this todo"
            aria-label="New todo notes"
            rows={2}
            className="field"
            style={{ width: '100%', fontSize: 12, resize: 'vertical' }}
          />
        </div>
      ) : null}

      <div style={{ padding: '10px 16px 4px' }}>
        <div className="todop-seg" role="tablist">
          {(['all', 'open', 'done'] as FilterMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={filter === mode}
              className={filter === mode ? 'on' : undefined}
              onClick={() => setFilter(mode)}
            >
              {mode === 'all' ? 'All' : mode === 'open' ? 'Open' : 'Done'}
              {' '}
              <span style={{ opacity: 0.6 }}>{mode === 'all' ? todos.length : mode === 'open' ? openCount : doneCount}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ minHeight: 0, flex: 1, overflowY: 'auto', padding: '4px 16px 16px' }}>
        {!sessionId ? (
          <p className="todop-empty" style={{ padding: '28px 8px', fontSize: 12.5 }}>
            Todos belong to a conversation — open or start a chat first.
          </p>
        ) : visible.length === 0 ? (
          <div className="todop-empty">
            <Sparkles className="ic" style={{ width: 24, height: 24, color: 'var(--faint)' }} aria-hidden="true" />
            <div style={{ fontWeight: 500, color: 'rgb(var(--c-ink))', marginTop: 6 }}>
              {filter === 'done' ? 'Nothing finished yet' : 'Start your first todo'}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              {filter === 'done'
                ? 'Completed todos will show up here.'
                : 'Add one above, or let the agent create them as it works.'}
            </div>
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {visible.map((todo) => {
              const editing = editingId === todo.id;
              if (editing) {
                return (
                  <li key={todo.id} style={{ borderBottom: '1px solid rgb(var(--c-line) / 0.6)', padding: '10px 4px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <input
                        value={editText}
                        onChange={(event) => setEditText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void saveEdit();
                          }
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                        aria-label="Todo text"
                        className="field"
                        style={{ fontSize: 12.5 }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        {priorityChips(editPriority, setEditPriority)}
                        <span style={{ flex: 1 }} />
                        <button type="button" className="btn ghost sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn primary sm"
                          onClick={() => void saveEdit()}
                          disabled={!editText.trim()}
                        >
                          <Check className="ic" aria-hidden="true" />
                          Save
                        </button>
                      </div>
                      <textarea
                        value={editNotes}
                        onChange={(event) => setEditNotes(event.target.value)}
                        placeholder="Notes (optional)"
                        aria-label="Todo notes"
                        rows={2}
                        className="field"
                        style={{ fontSize: 11.5, resize: 'vertical' }}
                      />
                    </div>
                  </li>
                );
              }
              return (
                <li key={todo.id} className="todop-row">
                  <button
                    type="button"
                    className={cx('todop-cb', todo.done ? 'done' : undefined)}
                    aria-label={todo.done ? `Reopen: ${todo.text}` : `Complete: ${todo.text}`}
                    aria-pressed={todo.done}
                    onClick={() => void toggle(todo, !todo.done)}
                  >
                    <Check className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
                  </button>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <button
                      type="button"
                      className="todop-text"
                      onClick={() => startEdit(todo)}
                      style={{
                        display: 'block',
                        width: '100%',
                        fontSize: 12.5,
                        color: todo.done ? 'var(--faint)' : 'rgb(var(--c-ink))',
                        textDecoration: todo.done ? 'line-through' : undefined,
                      }}
                    >
                      {todo.text}
                    </button>
                    {todo.notes ? (
                      <p style={{ margin: '2px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--muted)', overflowWrap: 'break-word' }}>
                        {todo.notes}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className="todop-dot"
                    style={{ background: `rgb(var(--c-todo-${todo.priority}))`, marginTop: 6 }}
                    aria-label={`${todo.priority} priority`}
                  />
                  <button
                    type="button"
                    className={cx('todop-act', confirmDeleteId === todo.id ? 'danger' : undefined)}
                    aria-label="Delete todo"
                    onClick={() => void remove(todo.id)}
                  >
                    <Trash2 className="ic" style={{ width: 15, height: 15 }} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {confirmDeleteId && visible.some((todo) => todo.id === confirmDeleteId) ? (
          <p style={{ margin: '8px 4px 0', fontSize: 10.5, color: 'rgb(var(--c-warn))' }}>Click the trash again to confirm.</p>
        ) : null}
      </div>
    </aside>
  );
}
