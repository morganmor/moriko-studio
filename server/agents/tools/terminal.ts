/**
 * agent__run / agent__git — shell-based process execution.
 *
 * Commands run through the native system shell (cmd.exe on Windows, /bin/sh
 * on Unix). No program allowlist; the agent has full shell access equivalent
 * to a command prompt. The workspace-write sandbox clamps cwd inside the
 * workspace root and scrubs secrets from the child environment.
 *
 * Terminal mode default is 'auto': commands run without approval dialogs.
 * Git clone/push always ask the user first regardless of mode.
 *
 * WEB ACCESS LOOPHOLE (kill-switch fix): `run` can launch a browser or fetch
 * through curl/powershell — a "licik" (sneaky) path around the Web Access
 * which only filters the agent browser/fetch/download tools. While web
 * access is OFF, commands that launch a browser or reach the public web are
 * refused at the same gate.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, resolveWithPermission, requireWorkspace } from './shared.js';
import { toolByName } from './registry.js';
import './registered.js';
import { requestApproval } from '../permissions.js';
import { formatRunOutcome, runShellCommand } from '../exec.js';
import { auditToolCall } from '../audit.js';

const GIT_ALWAYS_ASK = new Set(['clone', 'push']);

/**
 * True when a shell command would reach the public web or launch a browser —
 * the semantic equivalent of the agent browser/fetch/download tools, which
 * the Web Access kill-switch already refuses. Quoted paths and env-var
 * prefixes are stripped first so a quoted chrome.exe path still matches.
 *
 * V2 (the probe.mjs lesson): the FIRST guard was token-based and a plain
 * `node probe.mjs "http://127.0.0.1:8123/..."` sailed through — the command
 * line holds no browser token, yet the SCRIPT it runs launches headless
 * Chrome from inside. Two new layers close that hole:
 *   1. LOCAL URLS count too: a URL argument means "go online" regardless of
 *      host — a headless render of a local page still spawns the browser.
 *   2. Referenced scripts (.js/.mjs/.cjs/.py/.ps1) are read and scanned for
 *      launch/fetch patterns (puppeteer/playwright, chrome spawn, curl,
 *      urllib, requests...). The shell is not the only door; the file it
 *      opens is the same door.
 */
export function isSneakyWebCommand(commandLine: string): boolean {
  const flattened = commandLine.replace(/[\r\n]+/g, ' ');
  if (/https?:\/\//i.test(flattened)) return true;
  const tokens = flattened.match(/"[^"]*"|'[^']*'|\S+/g) ?? [flattened];
  const browserNames = ['chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera', 'chromium'];
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    const base = token.split(/[\\/]/).pop()?.toLowerCase() ?? '';
    if (browserNames.some((name) => base === `${name}.exe` || base === name)) return true;
  }
  return /\b(curl|wget|wget\.exe|curl\.exe|powershell|pwsh|start|cmd)\b/i.test(flattened);
}

/** Script extensions whose FILE CONTENT may hide a browser launch. */
const SCRIPT_EXTENSIONS = /\.(js|mjs|cjs|py|ps1)$/i;

/** Patterns inside a script that launch a browser or perform network I/O. */
const SCRIPT_WEB_PATTERNS: RegExp[] = [
  /\bpuppeteer\b/i,
  /\bplaywright\b/i,
  /\bchromium\b/i,
  /\bchrome(-|\.)?headless|headless.*chrome/i,
  /\b(spawn|exec|execFile|execSync)\b[^]{0,120}\b(chrome|msedge|firefox|chromium)\b/i,
  /\b(fetch|http\.get|https\.get|axios|undici|got\()\b/i,
  /\bimport\s+(http|https)\b/i,
  /\brequire\(\s*['"](http|https|node-fetch|axios)['"]\s*\)/i,
  /\burllib|urlopen|requests\.get|httpx/i,
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-Process\s+.*chrome)\b/i,
];

/**
 * Synchronous best-effort scan of scripts referenced by a command line.
 * Called with the RESOLVED cwd so relative paths are read against it. A
 * missing file is not a violation — the command fails on its own merits.
 */
export function commandTouchesWebScripts(commandLine: string, cwdAbsolute: string): boolean {
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    if (!SCRIPT_EXTENSIONS.test(token)) continue;
    if (/[\\/]{2,}|^https?:/i.test(token)) continue;
    const absolute = path.isAbsolute(token) ? token : path.join(cwdAbsolute, token);
    let source: string;
    try {
      source = readFileSync(absolute, 'utf8').slice(0, 524_288);
    } catch {
      continue;
    }
    if (SCRIPT_WEB_PATTERNS.some((pattern) => pattern.test(source))) return true;
  }
  return false;
}

/** Refusal text shared by run/task_start when web access is off. */
export function sneakyWebRefusal(commandLine: string): string {
  return (
    'Web access is OFF — the user disabled it for this conversation. This command would reach the public web ' +
    `(browser/fetch through the shell): ${commandLine.slice(0, 160)}. ` +
    'Do not attempt to reach the web through shell workarounds; ask the user to enable Web Access if the task truly needs it.'
  );
}

/** Shared run/git gate: terminal mode + (command-based) user approval. */
async function approveCommand(
  tool: 'run' | 'git',
  commandLine: string,
  cwdAbsolute: string,
  alwaysAsk: boolean,
  ctx: AgentToolContext,
): Promise<boolean> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') return false;
  if (mode === 'auto' && !alwaysAsk) return true;
  return requestApproval({ tool, paths: [cwdAbsolute], root: requireWorkspace(ctx).root, command: commandLine }, ctx);
}

export async function runTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const rawCommand = str(args, 'command').trim();
  if (!rawCommand) return { ok: false, isError: true, text: 'run needs a "command" line.' };

  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return {
      ok: false,
      isError: true,
      text:
        'Terminal execution is turned OFF in the harness settings. Ask the user to enable it ' +
        '(Tools → Terminal: Ask or Auto) if running commands is needed for the task.',
    };
  }

  const cwdRaw = str(args, 'cwd').trim() || '.';
  const cwd = await resolveWithPermission('run', cwdRaw, ctx);
  if (!statSync(cwd.absolute).isDirectory()) {
    return { ok: false, isError: true, text: `cwd "${cwd.relative}" is not a directory.` };
  }

  if (
    ctx.webAccess === false &&
    (isSneakyWebCommand(rawCommand) || commandTouchesWebScripts(rawCommand, cwd.absolute))
  ) {
    return { ok: false, isError: true, errorCode: 'web_access_off', text: sneakyWebRefusal(rawCommand) };
  }

  const approved = await approveCommand('run', rawCommand, cwd.absolute, false, ctx);
  if (!approved) {
    return { ok: false, isError: true, text: `The user did not approve running "${rawCommand}".` };
  }

  const timeoutSec = num(args, 'timeoutSec');
  const sandboxOptions = {
    workspaceRoot: requireWorkspace(ctx).root,
    policy: 'workspace-write' as const,
  };
  const outcome = await runShellCommand(rawCommand, {
    cwd: cwd.absolute,
    timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
    signal: ctx.signal,
    sandbox: sandboxOptions,
  });
  auditToolCall({
    session: ctx.sessionId ?? 'default',
    tool: 'run/exec',
    ok: outcome.exitCode === 0 && !outcome.timedOut,
    durationMs: 0,
    args: `[sandbox:workspace-write] ${rawCommand}`.slice(0, 280) + ` · exit=${outcome.exitCode ?? 'signal'}` + (outcome.timedOut ? ' · TIMED OUT' : ''),
  });
  return {
    ok: !outcome.timedOut && (outcome.exitCode === 0 || outcome.exitCode === null),
    isError: outcome.timedOut || (outcome.exitCode !== 0 && outcome.exitCode !== null),
    text: truncateOutput(formatRunOutcome(outcome, rawCommand)),
  };
}

export async function gitTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const subcommand = str(args, 'subcommand').trim().toLowerCase();
  if (!subcommand) return { ok: false, isError: true, text: 'git needs a "subcommand".' };

  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return {
      ok: false,
      isError: true,
      text:
        'Terminal execution is turned OFF in the harness settings. Ask the user to enable it ' +
        '(Tools → Terminal: Ask or Auto) if git operations are needed for the task.',
    };
  }

  const rawArgs = Array.isArray(args.args)
    ? args.args.filter((entry): entry is string => typeof entry === 'string')
    : [];

  if (subcommand === 'clone') {
    const url = rawArgs.find((token) => /^https?:\/\//i.test(token)) ?? rawArgs[0];
    if (!url || !/^https:\/\/[\w.-]+/i.test(url)) {
      return { ok: false, isError: true, text: 'git clone needs an https:// repository URL.' };
    }
    if (!rawArgs.some((token) => /^--depth\b|^--depth$/i.test(token) || token === '--depth=1')) {
      rawArgs.unshift('--depth', '1');
    }
  }

  const cwdRaw = str(args, 'cwd').trim() || '.';
  const cwd = await resolveWithPermission('git', cwdRaw, ctx);
  if (!statSync(cwd.absolute).isDirectory()) {
    return { ok: false, isError: true, text: `cwd "${cwd.relative}" is not a directory.` };
  }

  const commandLine = ['git', subcommand, ...rawArgs].join(' ');

  const approved = await approveCommand('git', commandLine, cwd.absolute, GIT_ALWAYS_ASK.has(subcommand), ctx);
  if (!approved) {
    return { ok: false, isError: true, text: `The user did not approve "git ${subcommand}".` };
  }

  const gitOutcome = await runShellCommand(commandLine, {
    cwd: cwd.absolute,
    signal: ctx.signal,
    sandbox: { workspaceRoot: requireWorkspace(ctx).root, policy: 'workspace-write' },
  });
  auditToolCall({
    session: ctx.sessionId ?? 'default',
    tool: 'git/exec',
    ok: gitOutcome.exitCode === 0 && !gitOutcome.timedOut,
    durationMs: 0,
    args: `[sandbox:workspace-write] ${commandLine}`.slice(0, 280) + ` · exit=${gitOutcome.exitCode ?? 'signal'}` + (gitOutcome.timedOut ? ' · TIMED OUT' : ''),
  });
  return {
    ok: !gitOutcome.timedOut && (gitOutcome.exitCode === 0 || gitOutcome.exitCode === null),
    isError: gitOutcome.timedOut || (gitOutcome.exitCode !== 0 && gitOutcome.exitCode !== null),
    text: truncateOutput(formatRunOutcome(gitOutcome, commandLine)),
  };
}

/** Exported for the loop's tool catalogue filter (Terminal mode). */
export function isTerminalTool(wireName: string): boolean {
  return wireName === 'agent__run' || wireName === 'agent__git' || toolByName(wireName)?.terminal === true;
}
