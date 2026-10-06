/**
 * agent__task_start / agent__task_output / agent__task_stop — background
 * process manager.
 *
 * task_start spawns a shell process in the BACKGROUND (non-blocking)
 * and returns a taskId. The command runs through the native system shell.
 * Output is buffered in memory (capped at 48 KB).
 * task_output reads the buffered output (optionally waiting N ms for more).
 * task_stop kills a running task and removes it from the registry.
 *
 * Up to 10 concurrent tasks. In-memory registry (not persisted). Requires
 * terminal mode enabled.
 */
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, resolveWithPermission } from './shared.js';
import { spawnBackgroundShell } from '../exec.js';
import { auditToolCall } from '../audit.js';
import { isSneakyWebCommand, sneakyWebRefusal, commandTouchesWebScripts } from './terminal.js';

interface BgTask {
  id: string;
  child: ChildProcess;
  command: string;
  cwd: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  output: string;
}

const tasks = new Map<string, BgTask>();
const MAX_TASKS = 10;
const MAX_TASK_OUTPUT = 48_000;
let taskCounter = 0;

export async function taskStartTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return {
      ok: false,
      isError: true,
      text:
        'Terminal execution is turned OFF in the harness settings. Ask the user to enable it ' +
        '(Tools → Terminal: Ask or Auto) if starting background tasks is needed.',
    };
  }

  const rawCommand = str(args, 'command').trim();
  if (!rawCommand) return { ok: false, isError: true, text: 'task_start needs a "command" line.' };

  // WEB ACCESS LOOPHOLE — same guard as agent__run: a background shell can
  // launch the browser or fetch when Web Access is off; refuse it.
  if (ctx.webAccess === false && isSneakyWebCommand(rawCommand)) {
    return { ok: false, isError: true, errorCode: 'web_access_off', text: sneakyWebRefusal(rawCommand) };
  }

  if (tasks.size >= MAX_TASKS) {
    return { ok: false, isError: true, text: `Task limit reached (${MAX_TASKS}). Stop an existing task first with agent__task_stop.` };
  }

  const cwdRaw = str(args, 'cwd').trim() || '.';
  const resolved = await resolveWithPermission('task_start', cwdRaw, ctx);
  if (!statSync(resolved.absolute).isDirectory()) {
    return { ok: false, isError: true, text: `cwd "${resolved.relative}" is not a directory.` };
  }

  // Same script-content scan as agent__run: a background task is an even
  // better hiding spot for a browser launcher — check what it runs.
  if (ctx.webAccess === false && commandTouchesWebScripts(rawCommand, resolved.absolute)) {
    return { ok: false, isError: true, errorCode: 'web_access_off', text: sneakyWebRefusal(rawCommand) };
  }

  const taskId = `task-${++taskCounter}`;
  const child = spawnBackgroundShell(rawCommand, { cwd: resolved.absolute });

  const task: BgTask = {
    id: taskId,
    child,
    command: rawCommand,
    cwd: resolved.relative,
    startedAt: Date.now(),
    exited: false,
    exitCode: null,
    output: '',
  };

  const cap = (addition: string): void => {
    if (task.output.length >= MAX_TASK_OUTPUT) return;
    task.output += addition;
    if (task.output.length > MAX_TASK_OUTPUT) {
      task.output = `${task.output.slice(0, MAX_TASK_OUTPUT)}\n...(output capped)`;
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => cap(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => cap(chunk.toString('utf8')));
  child.on('close', (code: number | null) => {
    task.exited = true;
    task.exitCode = code;
    cap(`\n[process exited with code ${code ?? 'null'}]`);
  });
  child.on('error', (error: Error) => {
    task.exited = true;
    cap(`\n[process error: ${error.message}]`);
  });

  tasks.set(taskId, task);

  auditToolCall({
    session: ctx.sessionId ?? 'default',
    tool: 'task_start',
    ok: true,
    durationMs: 0,
    args: `${rawCommand} · pid=${child.pid ?? 'unknown'}`,
  });

  return {
    ok: true,
    isError: false,
    text:
      `Background task started: ${taskId}\n` +
      `  command: ${rawCommand}\n` +
      `  cwd: ${resolved.relative}\n` +
      `  pid: ${child.pid ?? 'unknown'}\n\n` +
      `Poll output with agent__task_output { taskId: "${taskId}" }.\n` +
      `Stop with agent__task_stop { taskId: "${taskId}" }.`,
  };
}

export async function taskOutputTool(args: Record<string, unknown>, _ctx: AgentToolContext): Promise<HarnessToolResult> {
  const taskId = str(args, 'taskId').trim();
  if (!taskId) return { ok: false, isError: true, text: 'task_output needs a "taskId".' };

  const task = tasks.get(taskId);
  if (!task) {
    const active = [...tasks.keys()].join(', ') || 'none';
    return { ok: false, isError: true, text: `No background task with id "${taskId}". Active tasks: ${active}.` };
  }

  const waitMs = Math.min(Math.max(num(args, 'waitMs') ?? 0, 0), 30_000);
  if (waitMs > 0 && !task.exited) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const elapsed = Math.round((Date.now() - task.startedAt) / 100) / 10;
  const status = task.exited ? `exited (code ${task.exitCode ?? 'null'})` : 'running';
  const header = `${taskId} — ${status} — ${elapsed}s elapsed — pid ${task.child.pid ?? 'n/a'}`;

  return {
    ok: true,
    isError: false,
    text: truncateOutput(`${header}\n${task.output || '(no output yet)'}`),
  };
}

export async function taskStopTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const taskId = str(args, 'taskId').trim();
  if (!taskId) return { ok: false, isError: true, text: 'task_stop needs a "taskId".' };

  const task = tasks.get(taskId);
  if (!task) {
    const active = [...tasks.keys()].join(', ') || 'none';
    return { ok: false, isError: true, text: `No background task with id "${taskId}". Active tasks: ${active}.` };
  }

  if (!task.exited) {
    try {
      task.child.kill('SIGKILL');
      task.output += '\n[process killed by agent__task_stop]';
    } catch {
    }
  }

  tasks.delete(taskId);

  auditToolCall({
    session: ctx.sessionId ?? 'default',
    tool: 'task_stop',
    ok: true,
    durationMs: 0,
    args: `${taskId} · ${task.command}`,
  });

  const elapsed = Math.round((Date.now() - task.startedAt) / 100) / 10;
  return {
    ok: true,
    isError: false,
    text: `Stopped ${taskId} (${task.command}, ran for ${elapsed}s).`,
  };
}