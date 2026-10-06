/**
 * agent__typecheck — structured type-check wrapper.
 *
 * Runs the workspace typecheck command (default: pnpm typecheck) through the
 * native system shell and parses the tsc compiler output into structured
 * errors: file:line:col + TS code + message, grouped by file. The agent can
 * then read_file the exact error locations. Requires terminal mode enabled.
 */
import { statSync } from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { runShellCommand } from '../exec.js';
import { auditToolCall } from '../audit.js';

interface TscError {
  file: string;
  line: number;
  col: number;
  severity: string;
  code: string;
  message: string;
}

const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;

function parseTscOutput(output: string): TscError[] {
  const errors: TscError[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(TSC_ERROR_RE);
    if (m) {
      errors.push({
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: m[4],
        code: m[5],
        message: m[6],
      });
    }
  }
  return errors;
}

export async function typecheckTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return {
      ok: false,
      isError: true,
      text:
        'Terminal execution is turned OFF in the harness settings. Ask the user to enable it ' +
        '(Tools → Terminal: Ask or Auto) if running typecheck is needed for the task.',
    };
  }

  const cwdRaw = str(args, 'cwd').trim() || '.';
  const resolved = await resolveWithPermission('typecheck', cwdRaw, ctx);
  if (!statSync(resolved.absolute).isDirectory()) {
    return { ok: false, isError: true, text: `cwd "${resolved.relative}" is not a directory.` };
  }

  const command = str(args, 'command').trim() || 'pnpm typecheck';

  const outcome = await runShellCommand(command, {
    cwd: resolved.absolute,
    timeoutMs: 120_000,
    signal: ctx.signal,
    sandbox: { workspaceRoot: requireWorkspace(ctx).root, policy: 'workspace-write' as const },
  });

  auditToolCall({
    session: ctx.sessionId ?? 'default',
    tool: 'typecheck',
    ok: outcome.exitCode === 0,
    durationMs: outcome.durationMs,
    args: `${command} · exit=${outcome.exitCode ?? 'signal'}`,
  });

  if (outcome.exitCode === 0) {
    return {
      ok: true,
      isError: false,
      text: `> ${command}\nexit code: 0 · ${Math.round(outcome.durationMs / 100) / 10}s\n\nNo type errors. Clean build.`,
    };
  }

  const errors = parseTscOutput(`${outcome.stdout}\n${outcome.stderr}`);
  if (errors.length === 0) {
    return {
      ok: false,
      isError: true,
      text: truncateOutput(`> ${command}\nexit code: ${outcome.exitCode} · ${Math.round(outcome.durationMs / 100) / 10}s\n\n${outcome.output}`),
    };
  }

  const byFile = new Map<string, TscError[]>();
  for (const err of errors) {
    const list = byFile.get(err.file) ?? [];
    list.push(err);
    byFile.set(err.file, list);
  }

  const lines: string[] = [];
  lines.push(`> ${command}`);
  lines.push(`exit code: ${outcome.exitCode} · ${Math.round(outcome.durationMs / 100) / 10}s`);
  lines.push('');
  lines.push(`${errors.length} error${errors.length === 1 ? '' : 's'} across ${byFile.size} file${byFile.size === 1 ? '' : 's'}:`);
  lines.push('');

  for (const [file, fileErrors] of byFile) {
    lines.push(`-- ${file} (${fileErrors.length}) --`);
    for (const err of fileErrors) {
      lines.push(`  ${err.line}:${err.col}  ${err.code}: ${err.message}`);
    }
    lines.push('');
  }

  return {
    ok: false,
    isError: true,
    text: truncateOutput(lines.join('\n')),
  };
}