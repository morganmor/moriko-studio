/**
 * agent__todo_create / agent__todo_update / agent__todo_list /
 * agent__todo_delete — STANDALONE todos (not tied to a goal).
 *
 * The agent must create todos whenever it works on user input. Goals are
 * optional (large-scale work only). These tools let the agent track its work
 * without spinning up a full goal.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput, requireGoalSession } from './shared.js';
import { createTodo, listTodos, updateTodo, deleteTodo, type TodoPriority } from '../../todos/store.js';

function renderTodoSummary(todo: ReturnType<typeof listTodos>[number]): string {
  let line = `- [${todo.done ? 'x' : ' '}] (${todo.id}) [${todo.priority}] ${todo.text}`;
  if (todo.notes) line += `\n  notes: ${todo.notes}`;
  return line;
}

export async function todoCreateTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  try {
    const todo = createTodo(sessionId, args);
    ctx.onTodosChanged?.(sessionId);
    return {
      ok: true,
      isError: false,
      text: `Todo created.\n${renderTodoSummary(todo)}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: error instanceof Error ? error.message : 'todo_create failed.' };
  }
}

export async function todoUpdateTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const todoId = str(args, 'todoId').trim();
  if (!todoId) {
    return { ok: false, isError: true, text: 'todo_update needs the "todoId" (read todo_list first if unsure).' };
  }
  const patch: Parameters<typeof updateTodo>[2] = {};
  if (args.text !== undefined) patch.text = str(args, 'text');
  if (typeof args.done === 'boolean') patch.done = args.done;
  if (args.priority !== undefined) {
    const priority = str(args, 'priority');
    if (priority !== 'low' && priority !== 'medium' && priority !== 'high') {
      return { ok: false, isError: true, text: 'priority must be "low", "medium" or "high".' };
    }
    patch.priority = priority as TodoPriority;
  }
  if (args.notes !== undefined) patch.notes = str(args, 'notes');
  try {
    const todo = updateTodo(sessionId, todoId, patch);
    ctx.onTodosChanged?.(sessionId);
    return { ok: true, isError: false, text: `Todo updated.\n${renderTodoSummary(todo)}` };
  } catch (error) {
    return { ok: false, isError: true, text: error instanceof Error ? error.message : 'todo_update failed.' };
  }
}

export async function todoListTool(_args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const todos = listTodos(sessionId);
  if (todos.length === 0) {
    return { ok: true, isError: false, text: 'No standalone todos in this conversation yet (create one with todo_create).' };
  }
  ctx.onTodosChanged?.(sessionId);
  const open = todos.filter((todo) => !todo.done).length;
  const done = todos.length - open;
  return {
    ok: true,
    isError: false,
    text: truncateOutput(`${open} open, ${done} done:\n${todos.map(renderTodoSummary).join('\n')}`),
  };
}

export async function todoDeleteTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const todoId = str(args, 'todoId').trim();
  if (!todoId) {
    return { ok: false, isError: true, text: 'todo_delete needs the "todoId".' };
  }
  if (!deleteTodo(sessionId, todoId)) {
    return { ok: false, isError: true, text: `Unknown todo id: ${todoId}` };
  }
  ctx.onTodosChanged?.(sessionId);
  return { ok: true, isError: false, text: `Todo ${todoId} deleted.` };
}
