/**
 * agent__todo_create / agent__todo_update / agent__todo_list /
 * agent__todo_delete — STANDALONE todos (not tied to a goal).
 *
 * The agent must create todos whenever it works on user input. Goals are
 * optional (large-scale work only). These tools let the agent track its work
 * without spinning up a full goal.
 *
 * The store enforces the two data invariants (single active focus, no
 * pending-to-completed shortcut). This layer adds the third, which needs to
 * see the BUILD: a todo cannot be completed while a file this session edited
 * still carries a syntax diagnostic the edit introduced.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput, requireGoalSession } from './shared.js';
import {
  createTodo, listTodos, updateTodo, deleteTodo, targetStateOf,
  type Todo, type TodoPriority, type TodoPatch, type TodoState,
} from '../../todos/store.js';
import { listUnresolvedDiagnostics } from '../diagnostics-ledger.js';

const STATE_MARK: Record<TodoState, string> = {
  pending: ' ',
  in_progress: '~',
  completed: 'x',
};

function renderTodoSummary(todo: Todo): string {
  const live = todo.state === 'in_progress' && todo.activeForm ? ' — doing: ' + todo.activeForm : '';
  let line = '- [' + STATE_MARK[todo.state] + '] (' + todo.id + ') [' + todo.priority + '] ' + todo.text + live;
  if (todo.notes) line += '\n  notes: ' + todo.notes;
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
      text:
        'Todo created (state: pending).\n' + renderTodoSummary(todo) +
        '\n\nBefore you start it, move it to in_progress with an activeForm describing the work ' +
        'happening right now.',
    };
  } catch (error) {
    return { ok: false, isError: true, text: error instanceof Error ? error.message : 'todo_create failed.' };
  }
}

/**
 * The build-aware half of the completion gate. Returns a refusal, or null when
 * completing is honest.
 */
function falseCompletionDenial(sessionId: string, todoId: string): string | null {
  const unresolved = listUnresolvedDiagnostics(sessionId);
  if (unresolved.length === 0) return null;
  const detail = unresolved.slice(0, 5).map((entry) => {
    const head = entry.items.slice(0, 3).map((item) => {
      return item.line + ':' + item.column + ' TS' + item.code + ' ' + item.message;
    });
    const more = entry.items.length > 3 ? ' (+' + (entry.items.length - 3) + ' more)' : '';
    return '  ' + entry.file + ': ' + head.join(' | ') + more;
  });
  return [
    'todo_update: cannot complete ' + todoId + ' — ' + unresolved.length +
      ' file(s) edited in this session still have unresolved syntax diagnostics:',
    ...detail,
    '',
    'These are the diagnostics the edits themselves introduced (the edit result showed the exact ' +
      'line and column). Fix them first, then complete the todo. A checklist that can outrun a ' +
      'broken build is not a checklist.',
  ].join('\n');
}

export async function todoUpdateTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const todoId = str(args, 'todoId').trim();
  if (!todoId) {
    return { ok: false, isError: true, text: 'todo_update needs the "todoId" (read todo_list first if unsure).' };
  }

  const patch: TodoPatch = {};
  if (args.text !== undefined) patch.text = str(args, 'text');
  if (args.state !== undefined) patch.state = args.state;
  if (typeof args.done === 'boolean') patch.done = args.done;
  if (args.activeForm !== undefined) patch.activeForm = str(args, 'activeForm');
  if (args.notes !== undefined) patch.notes = str(args, 'notes');
  if (args.priority !== undefined) {
    const priority = str(args, 'priority');
    if (priority !== 'low' && priority !== 'medium' && priority !== 'high') {
      return { ok: false, isError: true, text: 'priority must be "low", "medium" or "high".' };
    }
    patch.priority = priority as TodoPriority;
  }

  // Resolve the requested state up front so the build check runs BEFORE any
  // mutation. The data invariants stay in the store — it owns them, and
  // duplicating them here would let the two drift apart.
  const current = listTodos(sessionId).find((entry) => entry.id === todoId);
  if (current) {
    let target: TodoState;
    try {
      target = targetStateOf(current, patch);
    } catch (error) {
      return { ok: false, isError: true, text: error instanceof Error ? error.message : 'todo_update failed.' };
    }
    if (target === 'completed' && current.state === 'in_progress') {
      const denial = falseCompletionDenial(sessionId, todoId);
      if (denial) return { ok: false, isError: true, errorCode: 'false_completion_blocked', text: denial };
    }
  }

  try {
    const todo = updateTodo(sessionId, todoId, patch);
    ctx.onTodosChanged?.(sessionId);
    return { ok: true, isError: false, text: 'Todo updated.\n' + renderTodoSummary(todo) };
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
  const active = todos.filter((todo) => todo.state === 'in_progress').length;
  const pending = todos.filter((todo) => todo.state === 'pending').length;
  const done = todos.filter((todo) => todo.state === 'completed').length;
  const head = active + ' in_progress, ' + pending + ' pending, ' + done + ' completed:';
  const notes: string[] = [];
  if (active > 1) notes.push('WARNING: more than one todo is in_progress — the state machine allows one.');
  const body = head + '\n' + todos.map(renderTodoSummary).join('\n');
  const suffix = notes.length > 0 ? '\n\n' + notes.join('\n') : '';
  return { ok: true, isError: false, text: truncateOutput(body + suffix) };
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
