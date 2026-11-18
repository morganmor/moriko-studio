
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, resolveWithPermission } from './shared.js';
import { spawnBackgroundShell } from '../exec.js';
import { auditToolCall } from '../audit.js';
import { isSneakyWebCommand, sneakyWebRefusal, commandTouchesWebScripts, approveCommand } from './terminal.js';

interface BgTask {
  id: string;
  
  sessionId: string;
  child: ChildProcess;
  command: string;
  cwd: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  
  endedBy?: string;
  output: string;
}

const tasks = new Map<string, BgTask>();
const MAX_TASKS = 10;
const MAX_TASK_OUTPUT = 48_000;

const EXITED_TTL_MS = 30 * 60 * 1000;
const MAX_EXITED_KEPT = 20;
const PANEL_TAIL_CHARS = 1600;
let taskCounter = 0;


function ownsTask(task: BgTask, sessionId: string | undefined): boolean {
  return !task.sessionId || task.sessionId === 'default' || !sessionId || task.sessionId === sessionId;
}


function pruneExited(): void {
  const now = Date.now();
  const exited = [...tasks.entries()].filter(([, task]) => task.exited).sort((a, b) => a[1].startedAt - b[1].startedAt);
  const drop = new Set<string>();
  for (const [id, task] of exited) {
    if (now - task.startedAt >= EXITED_TTL_MS) drop.add(id);
  }
  const survivors = exited.filter(([id]) => !drop.has(id));
  for (let i = 0; i < survivors.length - MAX_EXITED_KEPT; i += 1) drop.add(survivors[i][0]);
  for (const id of drop) tasks.delete(id);
}


function runningIds(): string {
  return [...tasks.values()].filter((task) => !task.exited).map((task) => task.id).join(', ') || 'none';
}

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

  if (ctx.webAccess === false && isSneakyWebCommand(rawCommand)) {
    return { ok: false, isError: true, errorCode: 'web_access_off', text: sneakyWebRefusal(rawCommand) };
  }

  pruneExited();
  const runningCount = [...tasks.values()].filter((task) => !task.exited).length;
  if (runningCount >= MAX_TASKS) {
    return { ok: false, isError: true, text: `Task limit reached (${MAX_TASKS} running). Stop an existing task first with agent__task_stop.` };
  }

  const cwdRaw = str(args, 'cwd').trim() || '.';
  const resolved = await resolveWithPermission('task_start', cwdRaw, ctx);
  if (!statSync(resolved.absolute).isDirectory()) {
    return { ok: false, isError: true, text: `cwd "${resolved.relative}" is not a directory.` };
  }

  if (ctx.webAccess === false && commandTouchesWebScripts(rawCommand, resolved.absolute)) {
    return { ok: false, isError: true, errorCode: 'web_access_off', text: sneakyWebRefusal(rawCommand) };
  }

  const approved = await approveCommand('task_start', rawCommand, resolved.absolute, false, ctx);
  if (!approved) {
    return {
      ok: false,
      isError: true,
      errorCode: 'approval_denied',
      text: `The user did not approve starting background task "${rawCommand}".`,
    };
  }

  const taskId = `task-${++taskCounter}`;
  const child = spawnBackgroundShell(rawCommand, { cwd: resolved.absolute });

  const task: BgTask = {
    id: taskId,
    sessionId: ctx.sessionId ?? 'default',
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

  const onAbort = (): void => {
    if (task.exited) return;
    try {
      task.child.kill('SIGKILL');
    } catch {
    }
    task.endedBy = 'aborted with the run';
    cap('\n[aborted with the run]');
  };
  if (ctx.signal) {
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

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

export async function taskOutputTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const taskId = str(args, 'taskId').trim();
  if (!taskId) return { ok: false, isError: true, text: 'task_output needs a "taskId".' };

  const task = tasks.get(taskId);
  if (!task) {
    return { ok: false, isError: true, text: `No background task with id "${taskId}". Running tasks: ${runningIds()}.` };
  }
  if (!ownsTask(task, ctx.sessionId)) {
    return { ok: false, isError: true, text: `Task "${taskId}" belongs to another session — it is not yours to read.` };
  }

  const waitMs = Math.min(Math.max(num(args, 'waitMs') ?? 0, 0), 30_000);
  if (waitMs > 0 && !task.exited) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const elapsed = Math.round((Date.now() - task.startedAt) / 100) / 10;
  const status = task.exited ? `exited (code ${task.exitCode ?? 'null'}${task.endedBy ? ` · ${task.endedBy}` : ''})` : 'running';
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
    return { ok: false, isError: true, text: `No background task with id "${taskId}". Running tasks: ${runningIds()}.` };
  }
  if (!ownsTask(task, ctx.sessionId)) {
    return { ok: false, isError: true, text: `Task "${taskId}" belongs to another session — it is not yours to stop.` };
  }

  if (!task.exited) {
    try {
      task.child.kill('SIGKILL');
      task.endedBy = 'stopped by agent (task_stop)';
      task.output += '\n[stopped by agent (task_stop)]';
    } catch {
    }
  }

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


export interface BgTaskDto {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  endedBy?: string;
  startedAt: number;
  elapsedSec: number;
  
  tail: string;
  outputBytes: number;
}


export function listBgTasks(sessionId?: string): BgTaskDto[] {
  pruneExited();
  const now = Date.now();
  return [...tasks.values()]
    .filter((task) => !sessionId || task.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((task) => ({
      id: task.id,
      sessionId: task.sessionId,
      command: task.command,
      cwd: task.cwd,
      pid: task.child.pid ?? null,
      running: !task.exited,
      exitCode: task.exitCode,
      ...(task.endedBy ? { endedBy: task.endedBy } : {}),
      startedAt: task.startedAt,
      elapsedSec: Math.round((now - task.startedAt) / 100) / 10,
      tail: task.output.slice(-PANEL_TAIL_CHARS),
      outputBytes: task.output.length,
    }));
}


export function stopBgTaskAsUser(taskId: string, sessionId?: string): { ok: boolean; error?: string; notOwner?: boolean } {
  const task = tasks.get(taskId);
  if (!task) return { ok: false, error: `No background task with id "${taskId}".` };
  if (!ownsTask(task, sessionId)) return { ok: false, notOwner: true };
  if (!task.exited) {
    try {
      task.child.kill('SIGKILL');
      task.endedBy = 'stopped via process panel';
      task.output += '\n[stopped via process panel]';
    } catch {
    }
    auditToolCall({
      session: sessionId ?? 'default',
      tool: 'task_stop_panel',
      ok: true,
      durationMs: 0,
      args: `${taskId} · ${task.command}`,
    });
  }
  return { ok: true };
}
