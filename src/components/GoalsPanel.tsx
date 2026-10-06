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

const STATUS_STYLE: Record<Goal['status'], string> = {
  running: 'border-accent/40 bg-accent-soft text-accent',
  paused: 'border-warning/40 bg-warning/10 text-warning',
  done: 'border-hairline bg-elevated text-faint',
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
      className="animate-scale-in fixed right-3 top-3 z-40 flex h-[calc(100vh-1.5rem)] w-[360px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-card border border-hairline bg-canvas shadow-popover"
    >
      <header className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
        <Target className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">Goals &amp; plans</h2>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-faint" aria-hidden="true" /> : null}
        <button type="button" className="icon-button" aria-label="Close goals panel" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {}
        {sessionId && reminders.length > 0 ? (
          <section className="mb-3 rounded-card border border-hairline bg-elevated/40 p-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
              <Bell className="h-3 w-3" aria-hidden="true" /> Reminders
            </p>
            <ul className="mt-1.5 space-y-1">
              {reminders.map((reminder) => {
                const due = reminder.fireAt <= Date.now();
                return (
                  <li key={reminder.id} className="flex items-start gap-2 rounded-control border border-hairline px-2 py-1.5">
                    <span
                      className={cx(
                        'mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        due ? 'bg-warning' : reminder.deliveredAt ? 'bg-faint/40' : 'bg-accent',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cx('block break-words text-[12px]', reminder.deliveredAt ? 'text-faint' : 'text-ink')}>
                        {reminder.label}
                      </span>
                      <span className="text-[10.5px] tabular-nums text-faint">
                        {due ? (reminder.deliveredAt ? 'delivered' : 'due now') : new Date(reminder.fireAt).toLocaleString()}
                      </span>
                    </span>
                    {!reminder.deliveredAt ? (
                      <button
                        type="button"
                        aria-label="Cancel reminder"
                        className="icon-button h-6 w-6 text-faint hover:text-ink"
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
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {!sessionId ? (
          <p className="px-1 text-[12.5px] text-faint">Open or start a chat first — goals belong to a conversation.</p>
        ) : goals.length === 0 ? (
          <p className="px-1 text-[12.5px] leading-relaxed text-faint">
            No goals yet. In Agent mode, ask the agent to plan something — it creates goals with
            <span className="font-mono"> goal_create</span>, works through the checklist, and this panel tracks it live.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {goals.map((goal) => {
              const expanded = expandedId === goal.id;
              const doneCount = goal.todos.filter((todo) => todo.done).length;
              return (
                <li key={goal.id} className="rounded-card border border-hairline bg-elevated/40">
                  {editingId === goal.id ? (
                    <div className="space-y-2 p-3">
                      <input
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        aria-label="Goal title"
                        className="w-full rounded-control border border-hairline bg-canvas px-2.5 py-1.5 text-[13px] text-ink focus:border-accent/50 focus:outline-none"
                      />
                      <textarea
                        value={draftPlan}
                        onChange={(event) => setDraftPlan(event.target.value)}
                        aria-label="Goal plan"
                        rows={5}
                        className="w-full resize-y rounded-control border border-hairline bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink focus:border-accent/50 focus:outline-none"
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="pill-button border border-hairline text-muted hover:text-ink"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="pill-button bg-accent text-accent-ink hover:brightness-110"
                          onClick={() => void saveEdit(goal.id)}
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 px-3 pt-2.5">
                        <span
                          className={cx(
                            'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                            STATUS_STYLE[goal.status],
                            goal.status === 'running' && 'animate-pulse',
                          )}
                        >
                          {goal.status}
                        </span>
                        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                          <Tip label={goal.title} align="start">{goal.title}</Tip>
                        </h3>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-faint">
                          {doneCount}/{goal.todos.length}
                        </span>
                      </div>

                      {goal.plan ? (
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : goal.id)}
                          aria-expanded={expanded}
                          className="mt-1 flex w-full items-center gap-1.5 px-3 text-left text-[11.5px] text-muted hover:text-ink"
                        >
                          <ListTodo className="h-3 w-3 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">{expanded ? 'Plan' : goal.plan}</span>
                          <ChevronDown
                            className={cx('h-3 w-3 shrink-0 transition-transform', !expanded && '-rotate-90')}
                            aria-hidden="true"
                          />
                        </button>
                      ) : null}

                      {expanded && goal.plan ? (
                        <p className="mx-3 mt-1.5 whitespace-pre-wrap rounded-control border border-hairline bg-canvas px-2.5 py-2 text-[11.5px] leading-relaxed text-muted">
                          {goal.plan}
                        </p>
                      ) : null}

                      {goal.todos.length > 0 ? (
                        <ul className="mt-1.5 space-y-0.5 px-2.5">
                          {goal.todos.map((todo) => (
                            <li key={todo.id}>
                              <label className="flex cursor-pointer items-start gap-2 rounded-control px-0.5 py-1 text-[12.5px] hover:bg-elevated">
                                <input
                                  type="checkbox"
                                  checked={todo.done}
                                  onChange={(event) =>
                                    void applyPatch(goal.id, {
                                      todos: [{ id: todo.id, done: event.target.checked }],
                                    })
                                  }
                                  className="mt-0.5 accent-[var(--accent)]"
                                />
                                <span className={cx('min-w-0 break-words', todo.done ? 'text-faint line-through' : 'text-muted')}>
                                  {todo.text}
                                </span>
                              </label>
                              {todo.subtasks?.length ? (
                                <ul className="ml-6 space-y-0.5 border-l border-hairline pl-2">
                                  {todo.subtasks.map((sub) => (
                                    <li key={sub.id}>
                                      <label className="flex cursor-pointer items-start gap-1.5 rounded-control px-0.5 py-0.5 text-[11.5px] hover:bg-elevated">
                                        <input
                                          type="checkbox"
                                          checked={sub.done}
                                          onChange={(event) =>
                                            void applyPatch(goal.id, {
                                              setSubtask: [{ id: sub.id, done: event.target.checked }],
                                            })
                                          }
                                          className="mt-0.5 accent-[var(--accent)]"
                                        />
                                        <span className={cx('min-w-0 break-words', sub.done ? 'text-faint line-through' : 'text-muted')}>
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

                      <div className="mt-1.5 flex items-center gap-0.5 border-t border-hairline/60 px-2 py-1.5">
                        {goal.status === 'running' ? (
                          <Tip label="Pause this goal">
                          <button
                            type="button"
                            className="icon-button h-7 w-7"
                            aria-label="Pause goal"
                            onClick={() => void applyPatch(goal.id, { status: 'paused' })}
                          >
                            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          </Tip>
                        ) : goal.status === 'paused' ? (
                          <Tip label="Resume this goal (status only — send the next message to continue the work)">
                          <button
                            type="button"
                            className="icon-button h-7 w-7 text-accent"
                            aria-label="Resume goal"
                            onClick={() => void applyPatch(goal.id, { status: 'running' })}
                          >
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          </Tip>
                        ) : (
                          <Tip label="Goal is done">
                          <span className="icon-button flex h-7 w-7 items-center justify-center">
                            <CircleSlash className="h-3.5 w-3.5 text-faint" aria-hidden="true" />
                          </span>
                          </Tip>
                        )}
                        <button
                          type="button"
                          className="icon-button h-7 w-7"
                          aria-label="Edit goal"
                          onClick={() => startEdit(goal)}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <span className="flex-1" />
                        <Tip label="Delete this goal">
                        <button
                          type="button"
                          aria-label="Delete goal"
                          className={cx(
                            'icon-button h-7 w-7',
                            confirmDeleteId === goal.id ? 'bg-danger/10 text-danger' : 'text-faint hover:text-ink',
                          )}
                          onClick={() => void remove(goal.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        </Tip>
                      </div>
                      {confirmDeleteId === goal.id ? (
                        <p className="px-3 pb-2 text-[10.5px] text-warning">Click the trash again to confirm.</p>
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
