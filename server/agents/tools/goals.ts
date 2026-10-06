/**
 * agent__goal_create / agent__goal_update / agent__goal_list — the goals
 * panel's state. Goals are per-conversation; the auto-run loop drives the
 * agent through the todo checklist.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput, requireGoalSession } from './shared.js';
import { createGoal, listGoals, updateGoal, type GoalStatus } from '../../goals/store.js';

function renderGoalSummary(goal: ReturnType<typeof listGoals>[number]): string {
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
    : '  (no todos)';
  return `"${goal.title}" — status: ${goal.status} (goalId: ${goal.id})\nPlan: ${goal.plan || '(none)'}\nTodos:\n${todos}`;
}

export async function goalCreateTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const goal = createGoal(sessionId, args);
  ctx.onGoalsChanged?.(sessionId);
  return {
    ok: true,
    isError: false,
    text:
      `Goal created and RUNNING. Work through its todos one by one; check each off with goal_update as you complete it, ` +
      `and set status "done" when everything is checked (that ends the auto-run loop).\n\n${renderGoalSummary(goal)}`,
  };
}

export async function goalUpdateTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const goalId = str(args, 'goalId').trim();
  if (!goalId) {
    return { ok: false, isError: true, text: 'goal_update needs the "goalId" (read goal_list first if unsure).' };
  }

  const patch: Parameters<typeof updateGoal>[2] = {};
  if (args.status !== undefined) {
    const status = str(args, 'status');
    if (status !== 'running' && status !== 'paused' && status !== 'done') {
      return { ok: false, isError: true, text: 'status must be "running", "paused" or "done".' };
    }
    patch.status = status as GoalStatus;
  }
  if (args.plan !== undefined) patch.plan = str(args, 'plan');
  const asIds = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const check = asIds(args.checkTodo);
  const uncheck = asIds(args.uncheckTodo);
  if (check.length || uncheck.length) {
    const todos: Array<{ id: string; done: boolean }> = [
      ...check.map((id) => ({ id, done: true })),
      ...uncheck.map((id) => ({ id, done: false })),
    ];
    patch.todos = todos;
  }
  // Nested checklists: add a subtask under a todo, or check/uncheck one by id.
  if (args.addSubtask && typeof args.addSubtask === 'object') {
    patch.addSubtask = args.addSubtask;
  }
  if (Array.isArray(args.setSubtask)) {
    patch.setSubtask = args.setSubtask;
  }

  let goal;
  try {
    goal = updateGoal(sessionId, goalId, patch);
  } catch (error) {
    return { ok: false, isError: true, text: error instanceof Error ? error.message : 'goal_update failed.' };
  }
  ctx.onGoalsChanged?.(sessionId);

  const remaining = goal.todos.filter((todo) => !todo.done).length;
  const openSubtasks = goal.todos.reduce(
    (count, todo) => count + (todo.subtasks?.filter((sub) => !sub.done).length ?? 0),
    0,
  );
  const tail =
    goal.status === 'done'
      ? 'Goal marked DONE — the auto-run loop ends here.'
      : openSubtasks > 0
        ? `${remaining} todo(s) and ${openSubtasks} subtask(s) left — keep working.`
        : remaining > 0
          ? `${remaining} todo(s) left — keep working.`
          : 'All todos are checked. Set status "done" to end the loop.';
  return { ok: true, isError: false, text: `Goal updated. ${tail}\n\n${renderGoalSummary(goal)}` };
}

export async function goalListTool(_args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const goals = listGoals(sessionId);
  if (goals.length === 0) {
    return { ok: true, isError: false, text: 'No goals in this conversation yet (create one with goal_create).' };
  }
  ctx.onGoalsChanged?.(sessionId);
  return { ok: true, isError: false, text: truncateOutput(goals.map(renderGoalSummary).join('\n\n')) };
}
