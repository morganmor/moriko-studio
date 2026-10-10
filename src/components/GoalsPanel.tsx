import { useEffect, useState } from 'react';
import {
  Bell,
  Check,
  ChevronDown,
  CircleSlash,
  ListTodo,
  Loader2,
  Pencil,
  Play,
  Pause,
  Target,
  Trash2,
  X,
} from './icons';

import { cancelReminderApi, deleteGoalApi, patchGoal } from '../lib/api';
import type { Goal, Reminder } from '../types';
import { useStore } from '../store/useStore';
import { Tip, cx } from './ui';

interface GoalsPanelProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_STYLE: Record<Goal['status'], { border: string; background: string; color: string }> = {
  running: { border: 'rgb(var(--c-accent) / 0.4)', background: 'var(--c-accent-soft)', color: 'rgb(var(--c-accent))' },
  paused: { border: 'rgb(var(--c-warn) / 0.4)', background: 'rgb(var(--c-warn) / 0.1)', color: 'rgb(var(--c-warn))' },
  done: { border: 'var(--line)', background: 'rgb(var(--c-elev))', color: 'var(--faint)' },
};

/**
 * GOALS & PLANS panel.
 *
 * Goals (with their plan and todo checklist) are created and progressed by
 * the AGENT through harness tools; this panel shows the live state and gives
 * the user control: pause, resume, edit, or delete a goal. Status is
 * bookkeeping only — nothing auto-continues the conversation; the user sends
 * the next message whenever they want the agent to keep working.
 */
export function GoalsPanel({ open, onClose }: GoalsPanelProps) {
  const conversation = useStore((state) => state.activeConversation());
  const setConversationGoals = useStore((state) => state.setConversationGoals);
  const showNotice = useStore((state) => state.showNotice);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftPlan, setDraftPlan] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sessionId = conversation?.id;
  const goals = conversation?.goals ?? [];
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    import('../lib/api').then(({ fetchGoals }) =>
      fetchGoals(sessionId)
        .then((fresh) => {
          if (!cancelled) setConversationGoals(sessionId, fresh);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setLoading(false);
        }),
    );
    import('../lib/api').then(({ fetchReminders }) =>
      fetchReminders(sessionId)
        .then((fresh) => {
          if (!cancelled) setReminders(fresh);
        })
        .catch(() => undefined),
    );
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, setConversationGoals]);

  if (!open) return null;

  const applyPatch = async (goalId: string, patch: Parameters<typeof patchGoal>[2]) => {
    if (!sessionId) return;
    try {
      const goal = await patchGoal(sessionId, goalId, patch);
      setConversationGoals(
        sessionId,
        goals.map((entry) => (entry.id === goal.id ? goal : entry)),
      );
    } catch (cause) {
      showNotice('goal.updateFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    }
  };

  const remove = async (goalId: string) => {
    if (!sessionId) return;
    if (confirmDeleteId !== goalId) {
      setConfirmDeleteId(goalId);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await deleteGoalApi(sessionId, goalId);
      setConversationGoals(
        sessionId,
        goals.filter((entry) => entry.id !== goalId),
      );
      showNotice('goal.deleted');
    } catch (cause) {
      showNotice('goal.updateFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    }
  };

  const startEdit = (goal: Goal) => {
    setEditingId(goal.id);
    setDraftTitle(goal.title);
    setDraftPlan(goal.plan);
  };

  const saveEdit = async (goalId: string) => {
    await applyPatch(goalId, { title: draftTitle, plan: draftPlan });
    setEditingId(null);
  };

  return (
    <aside
      aria-label="Goals and plans"
      style={{
        position: 'fixed',
        right: 12,
        top: 12,
        zIndex: 40,
        display: 'flex',
        height: 'calc(100vh - 1.5rem)',
        width: 360,
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
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line)', padding: '12px 16px' }}>
        <Target className="ic" style={{ color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        <h2 style={{ margin: 0, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600, color: 'rgb(var(--c-ink))' }}>Goals &amp; plans</h2>
        {loading ? <Loader2 className="ic spin" style={{ color: 'var(--faint)' }} aria-hidden="true" /> : null}
        <button type="button" className="ib" aria-label="Close goals panel" onClick={onClose}>
          <X className="ic" aria-hidden="true" />
        </button>
      </header>

      <div style={{ minHeight: 0, flex: 1, overflowY: 'auto', padding: 12 }}>
        {}
        {sessionId && reminders.length > 0 ? (
          <section className="card" style={{ marginBottom: 12, padding: 10, background: 'rgb(var(--c-elev) / 0.4)' }}>
            <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--faint)' }}>
              <Bell className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" /> Reminders
            </p>
            <ul style={{ margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4, listStyle: 'none' }}>
              {reminders.map((reminder) => {
                const due = reminder.fireAt <= Date.now();
                return (
                  <li key={reminder.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 'var(--r-md)', border: '1px solid var(--line)', padding: '6px 8px' }}>
                    <span
                      style={{
                        marginTop: 2,
                        width: 6,
                        height: 6,
                        flexShrink: 0,
                        borderRadius: '50%',
                        background: due ? 'rgb(var(--c-warn))' : reminder.deliveredAt ? 'rgb(var(--c-faint) / 0.4)' : 'rgb(var(--c-accent))',
                      }}
                      aria-hidden="true"
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', overflowWrap: 'break-word', fontSize: 12, color: reminder.deliveredAt ? 'var(--faint)' : 'rgb(var(--c-ink))' }}>
                        {reminder.label}
                      </span>
                      <span style={{ fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}>
                        {due ? (reminder.deliveredAt ? 'delivered' : 'due now') : new Date(reminder.fireAt).toLocaleString()}
                      </span>
                    </span>
                    {!reminder.deliveredAt ? (
                      <button
                        type="button"
                        aria-label="Cancel reminder"
                        className="ib xs"
                        onClick={async () => {
                          if (!sessionId) return;
                          try {
                            await cancelReminderApi(sessionId, reminder.id);
                            setReminders((current) => current.filter((entry) => entry.id !== reminder.id));
                          } catch {
                            showNotice('goal.reminderCancelFailed');
                          }
                        }}
                      >
                        <X className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {!sessionId ? (
          <p style={{ padding: '0 4px', fontSize: 12.5, color: 'var(--faint)' }}>Open or start a chat first — goals belong to a conversation.</p>
        ) : goals.length === 0 ? (
          <p style={{ padding: '0 4px', fontSize: 12.5, lineHeight: 1.625, color: 'var(--faint)' }}>
            No goals yet. In Agent mode, ask the agent to plan something — it creates goals with
            <span style={{ fontFamily: 'var(--f-mono)' }}> goal_create</span>, works through the checklist, and this panel tracks it live.
          </p>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 0, margin: 0, listStyle: 'none' }}>
            {goals.map((goal) => {
              const expanded = expandedId === goal.id;
              const doneCount = goal.todos.filter((todo) => todo.done).length;
              return (
                <li key={goal.id} className="card" style={{ padding: 0, background: 'rgb(var(--c-elev) / 0.4)' }}>
                  {editingId === goal.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
                      <input
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        aria-label="Goal title"
                        className="field"
                        style={{ fontSize: 13 }}
                      />
                      <textarea
                        value={draftPlan}
                        onChange={(event) => setDraftPlan(event.target.value)}
                        aria-label="Goal plan"
                        rows={5}
                        className="field"
                        style={{ fontSize: 12.5, resize: 'vertical' }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn primary sm"
                          onClick={() => void saveEdit(goal.id)}
                        >
                          <Check className="ic" aria-hidden="true" />
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 0' }}>
                        <span
                          className="cap"
                          style={{
                            flexShrink: 0,
                            fontSize: 10,
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '.05em',
                            ...STATUS_STYLE[goal.status],
                            animation: goal.status === 'running' ? 'breathe 2s ease-in-out infinite' : undefined,
                          }}
                        >
                          {goal.status}
                        </span>
                        <h3 style={{ margin: 0, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
                          <Tip label={goal.title} align="start">{goal.title}</Tip>
                        </h3>
                        <span style={{ flexShrink: 0, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}>
                          {doneCount}/{goal.todos.length}
                        </span>
                      </div>

                      {goal.plan ? (
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : goal.id)}
                          aria-expanded={expanded}
                          className="nav"
                          style={{ marginTop: 4, height: 'auto', padding: '4px 12px', fontSize: 11.5, justifyContent: 'flex-start' }}
                        >
                          <ListTodo className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
                          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{expanded ? 'Plan' : goal.plan}</span>
                          <ChevronDown
                            className="chev"
                            style={{ width: 12, height: 12, transform: expanded ? undefined : 'rotate(-90deg)' }}
                            aria-hidden="true"
                          />
                        </button>
                      ) : null}

                      {expanded && goal.plan ? (
                        <p style={{ margin: '6px 12px 0', whiteSpace: 'pre-wrap', borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'rgb(var(--c-canvas))', padding: '8px 10px', fontSize: 11.5, lineHeight: 1.625, color: 'var(--muted)' }}>
                          {goal.plan}
                        </p>
                      ) : null}

                      {goal.todos.length > 0 ? (
                        <ul style={{ margin: '6px 0 0', padding: '0 10px', display: 'flex', flexDirection: 'column', gap: 2, listStyle: 'none' }}>
                          {goal.todos.map((todo) => (
                            <li key={todo.id}>
                              <label style={{ display: 'flex', cursor: 'pointer', alignItems: 'flex-start', gap: 8, borderRadius: 'var(--r-sm)', padding: '4px 2px', fontSize: 12.5 }}>
                                <input
                                  type="checkbox"
                                  checked={todo.done}
                                  onChange={(event) =>
                                    void applyPatch(goal.id, {
                                      todos: [{ id: todo.id, done: event.target.checked }],
                                    })
                                  }
                                  style={{ marginTop: 2, accentColor: 'rgb(var(--c-accent))' }}
                                />
                                <span style={{ minWidth: 0, overflowWrap: 'break-word', color: todo.done ? 'var(--faint)' : 'var(--muted)', textDecoration: todo.done ? 'line-through' : undefined }}>
                                  {todo.text}
                                </span>
                              </label>
                              {todo.subtasks?.length ? (
                                <ul style={{ marginLeft: 24, display: 'flex', flexDirection: 'column', gap: 2, borderLeft: '1px solid var(--line)', paddingLeft: 8 }}>
                                  {todo.subtasks.map((sub) => (
                                    <li key={sub.id}>
                                      <label style={{ display: 'flex', cursor: 'pointer', alignItems: 'flex-start', gap: 6, borderRadius: 'var(--r-sm)', padding: '2px', fontSize: 11.5 }}>
                                        <input
                                          type="checkbox"
                                          checked={sub.done}
                                          onChange={(event) =>
                                            void applyPatch(goal.id, {
                                              setSubtask: [{ id: sub.id, done: event.target.checked }],
                                            })
                                          }
                                          style={{ marginTop: 2, accentColor: 'rgb(var(--c-accent))' }}
                                        />
                                        <span style={{ minWidth: 0, overflowWrap: 'break-word', color: sub.done ? 'var(--faint)' : 'var(--muted)', textDecoration: sub.done ? 'line-through' : undefined }}>
                                          {sub.text}
                                        </span>
                                      </label>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 2, borderTop: '1px solid rgb(var(--c-line) / 0.6)', padding: '6px 8px' }}>
                        {goal.status === 'running' ? (
                          <Tip label="Pause this goal">
                          <button
                            type="button"
                            className="ib sm"
                            aria-label="Pause goal"
                            onClick={() => void applyPatch(goal.id, { status: 'paused' })}
                          >
                            <Pause className="ic" aria-hidden="true" />
                          </button>
                          </Tip>
                        ) : goal.status === 'paused' ? (
                          <Tip label="Resume this goal (status only — send the next message to continue the work)">
                          <button
                            type="button"
                            className="ib sm on"
                            aria-label="Resume goal"
                            onClick={() => void applyPatch(goal.id, { status: 'running' })}
                          >
                            <Play className="ic" aria-hidden="true" />
                          </button>
                          </Tip>
                        ) : (
                          <Tip label="Goal is done">
                          <span className="ib sm" style={{ opacity: 0.5 }}>
                            <CircleSlash className="ic" style={{ color: 'var(--faint)' }} aria-hidden="true" />
                          </span>
                          </Tip>
                        )}
                        <button
                          type="button"
                          className="ib sm"
                          aria-label="Edit goal"
                          onClick={() => startEdit(goal)}
                        >
                          <Pencil className="ic" aria-hidden="true" />
                        </button>
                        <span style={{ flex: 1 }} />
                        <Tip label="Delete this goal">
                        <button
                          type="button"
                          aria-label="Delete goal"
                          className={cx('ib sm', confirmDeleteId === goal.id ? 'danger' : undefined)}
                          style={confirmDeleteId === goal.id ? { background: 'rgb(var(--c-danger) / 0.1)', color: 'rgb(var(--c-danger))' } : undefined}
                          onClick={() => void remove(goal.id)}
                        >
                          <Trash2 className="ic" aria-hidden="true" />
                        </button>
                        </Tip>
                      </div>
                      {confirmDeleteId === goal.id ? (
                        <p style={{ padding: '0 12px 8px', margin: 0, fontSize: 10.5, color: 'rgb(var(--c-warn))' }}>Click the trash again to confirm.</p>
                      ) : null}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
