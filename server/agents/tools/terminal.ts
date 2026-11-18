
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, resolveWithPermission, requireWorkspace, isLoopbackUrl } from './shared.js';
import { getActiveWorkspace, isInsideRoot } from '../workspace.js';
import { toolByName } from './registry.js';
import './registered.js';
import { requestApproval } from '../permissions.js';
import { formatRunOutcome, runShellCommand } from '../exec.js';
import { auditToolCall } from '../audit.js';

const GIT_ALWAYS_ASK = new Set(['clone', 'push', 'reset', 'clean', 'rebase']);
const GIT_REMOTE_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule']);

const WEB_DOWNLOAD_BINARIES = new Set([
  'curl',
  'wget',
  'aria2c',
  'httpie',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ftp',
  'sftp',
  'lynx',
  'links',
  'w3m',
  'elinks',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
  'start-bitstransfer',
]);

const WEB_BROWSER_BINARIES = new Set([
  'chrome',
  'google-chrome',
  'msedge',
  'edge',
  'microsoft-edge',
  'firefox',
  'brave',
  'opera',
  'chromium',
  'vivaldi',
  'iexplore',
]);

const SHELL_ENV_PREFIXES = new Set(['env', 'sudo', 'nohup', 'nice', 'time', 'command']);
const SUBSHELL_BINARIES = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'start']);

function stripQuotes(token: string): string {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

function binaryBaseName(token: string): string {
  const clean = stripQuotes(token).trim();
  const base = clean.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function tokenizeSegment(segment: string): string[] {
  return segment.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? [];
}

function splitShellSegments(commandLine: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < commandLine.length) {
        cur += ch + commandLine[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = commandLine.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segments.push(cur.trim());
  return segments;
}

function containsExternalHttpUrl(text: string): boolean {
  const matches = text.match(/https?:\/\/[^\s"'`)>\]]+/gi) ?? [];
  return matches.some((url) => !isLoopbackUrl(url));
}

const HTTP_CLIENT_BINARIES = new Set([
  'curl',
  'wget',
  'httpie',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
]);

function httpClientTargetsOnlyLoopback(segment: string, argTokens: string[]): boolean {
  const urls = segment.match(/https?:\/\/[^\s"'`)>\]]+/gi) ?? [];
  if (urls.length === 0 || !urls.every((url) => isLoopbackUrl(url))) return false;
  const nonHttpScheme = /\b(?:ftp|ftps|sftp|scp|file|dict|gopher|ldap|ldaps|smb):\/\//i;
  if (nonHttpScheme.test(segment)) return false;
  const valueFlags = new Set(['-x', '-h', '-d', '-o', '-a', '-u', '-m', '-w', '-b', '-c', '--request', '--header', '--data', '--data-raw', '--data-binary', '--output', '--user-agent', '--user', '--max-time', '--connect-timeout', '--method']);
  for (let i = 0; i < argTokens.length; i += 1) {
    const clean = stripQuotes(argTokens[i]);
    if (!clean) continue;
    const low = clean.toLowerCase();
    if (low === '-k' || low === '--config' || low === '--next') return false;
    if (valueFlags.has(low)) {
      i += 1;
      continue;
    }
    if (clean.startsWith('-') || /^https?:\/\//i.test(clean)) continue;
    if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:\/|$)/.test(clean) && !isLoopbackUrl(`http://${clean}`)) {
      return false;
    }
  }
  return true;
}

function segmentInvokesWeb(segment: string): boolean {
  if (containsExternalHttpUrl(segment)) return true;
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return false;

  let idx = 0;
  while (idx < tokens.length) {
    const clean = stripQuotes(tokens[idx]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(clean) || SHELL_ENV_PREFIXES.has(binaryBaseName(clean))) {
      idx += 1;
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return false;

  const bin = binaryBaseName(tokens[idx]);
  if (WEB_DOWNLOAD_BINARIES.has(bin)) {
    if (HTTP_CLIENT_BINARIES.has(bin) && httpClientTargetsOnlyLoopback(segment, tokens.slice(idx + 1))) {
      return false;
    }
    return true;
  }
  if (WEB_BROWSER_BINARIES.has(bin)) return true;

  if (SUBSHELL_BINARIES.has(bin)) {
    const restJoined = tokens.slice(idx + 1).map(stripQuotes).join(' ');
    if (/\b(Start-BitsTransfer|System\.Net\.WebClient|DownloadString|DownloadFile)\b/i.test(restJoined)) {
      return true;
    }
    if (bin === 'cmd' || bin === 'powershell' || bin === 'pwsh' || bin === 'sh' || bin === 'bash' || bin === 'zsh') {
      const payloadStart = tokens.findIndex((t, i) => i > idx && /^(\/c|-c|-command)$/i.test(stripQuotes(t)));
      if (payloadStart >= 0 && payloadStart + 1 < tokens.length) {
        const subPayload = tokens.slice(payloadStart + 1).map(stripQuotes).join(' ');
        return splitShellSegments(subPayload).some((sub) => segmentInvokesWeb(sub));
      }
    }
    if (/\b(Invoke-WebRequest|Invoke-RestMethod)\b/i.test(restJoined)) {
      return !httpClientTargetsOnlyLoopback(restJoined, tokens.slice(idx + 1));
    }
    if (bin === 'start') {
      const target = tokens.slice(idx + 1).find((t) => !stripQuotes(t).startsWith('/'));
      if (target) {
        const tBin = binaryBaseName(target);
        if (WEB_BROWSER_BINARIES.has(tBin) || WEB_DOWNLOAD_BINARIES.has(tBin)) return true;
      }
    }
  }

  return false;
}

export function isSneakyWebCommand(commandLine: string): boolean {
  return splitShellSegments(commandLine).some((segment) => segmentInvokesWeb(segment));
}


const SCRIPT_EXTENSIONS = /\.(js|mjs|cjs|ts|mts|cts|py|ps1)$/i;


const SCRIPT_WEB_PATTERNS: RegExp[] = [
  /\b(?:puppeteer|playwright)\.(?:launch|connect)\b/i,
  /\b(?:spawn|exec|execFile|execSync|Start-Process)\b[^;\r\n]{0,120}\b(?:chrome|google-chrome|msedge|firefox|chromium)\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|System\.Net\.WebClient)\b/i,
  /\b(?:axios|undici|node-fetch|got)\s*\.\s*(?:get|post|put|patch|delete|request|create|stream)\b/i,
  /\brequire\(\s*['"](?:node-fetch|axios|undici|got)['"]\s*\)/i,
  /\b(?:urllib\.request|urlopen|requests\.(?:get|post|put|delete|head|request)|httpx\.(?:get|post|AsyncClient|Client))\b/i,
  /\bhttps?\.(?:get|request)\s*\(\s*['"`]https?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)\b)/i,
  /\bfetch\s*\(\s*['"`]https?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)\b)/i,
];


export function commandTouchesWebScripts(commandLine: string, cwdAbsolute?: string): boolean {
  const tokens = tokenizeSegment(commandLine);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = stripQuotes(tokens[i]);
    if (!token) continue;
    if (/^(-e|--eval|-c|-p|--print)$/i.test(token) && i + 1 < tokens.length) {
      const inlineCode = stripQuotes(tokens[i + 1]);
      if (SCRIPT_WEB_PATTERNS.some((pattern) => pattern.test(inlineCode))) return true;
    }
    if (!cwdAbsolute || token.startsWith('-')) continue;
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


export function sneakyWebRefusal(commandLine: string): string {
  return (
    'Web access is OFF — the user disabled it for this conversation. This command would reach the public web ' +
    `(browser/fetch through the shell): ${commandLine.slice(0, 160)}. ` +
    'Do not attempt to reach the web through shell workarounds; ask the user to enable Web Access if the task truly needs it.'
  );
}


export function isDestructiveShellCommand(commandLine: string, workspaceRoot?: string): boolean {
  const flat = commandLine.replace(/[\r\n]+/g, ' ');
  if (
    /\brm\b[^;|&]*(?:\s-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)|--recursive\b[^;|&]*--force\b|--force\b[^;|&]*--recursive\b)/i.test(flat) ||
    /\b(?:del|erase)\b[^;|&]*\s\/[sq]/i.test(flat) ||
    /\b(?:rmdir|rd)\b[^;|&]*\s\/s/i.test(flat) ||
    /\bRemove-Item\b[^;|&]*-(?:Recurse|Force)\b/i.test(flat) ||
    /\bgit\s+clean\b[^;|&]*\s-[a-z]*f/i.test(flat) ||
    /\bgit\s+reset\s+--hard\b/i.test(flat) ||
    /\bgit\s+push\b[^;|&]*(?:\s--force(?:-with-lease)?\b|\s-[a-z]*f\b)/i.test(flat) ||
    /\b(?:mkfs|diskpart|dd\s+if=|format\s+[a-z]:)\b/i.test(flat) ||
    /\bchmod\s+-R\s+777\b/i.test(flat) ||
    /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i.test(flat)
  ) {
    return true;
  }

  if (workspaceRoot) {
    const tokens = tokenizeSegment(flat);
    for (const raw of tokens) {
      const token = stripQuotes(raw);
      if (!token || token.startsWith('-') || /^https?:\/\//i.test(token)) continue;
      if (/^\/[a-z]$/i.test(token)) continue; // Windows cmd switches (/c, /s, /q)
      const looksOutsideRef =
        /^[A-Za-z]:[\\/]/.test(token) ||
        /^\\\\/.test(token) ||
        /^~[\\/]/.test(token) ||
        /\.\.[\\/]/.test(token) ||
        /^\/(?:etc|var|usr|home|root|opt|mnt|Users|Windows|Program\s*Files)\b/i.test(token);
      if (!looksOutsideRef) continue;
      const candidate = token.startsWith('~/') || token.startsWith('~\\')
        ? path.resolve(path.join(workspaceRoot, '..', token.slice(2)))
        : path.resolve(workspaceRoot, token);
      if (!isInsideRoot(candidate, workspaceRoot)) return true;
    }
  }
  return false;
}

export async function approveCommand(
  tool: string,
  commandLine: string,
  cwdAbsolute: string,
  alwaysAsk: boolean,
  ctx: AgentToolContext,
): Promise<boolean> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') return false;
  const root = getActiveWorkspace(ctx.sessionId)?.path ?? cwdAbsolute;
  const mustAsk = alwaysAsk || isDestructiveShellCommand(commandLine, root);
  if (mode === 'auto' && !mustAsk) return true;
  const decision = await requestApproval(
    { tool, paths: [cwdAbsolute], root, intent: 'exec', command: commandLine },
    ctx,
  );
  return decision.granted;
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

function gitRemoteUrl(repoDir: string, remoteName: string): string | null {
  let dir = path.resolve(repoDir);
  for (let i = 0; i < 8; i += 1) {
    const cfgPath = path.join(dir, '.git', 'config');
    if (existsSync(cfgPath)) {
      try {
        const cfg = readFileSync(cfgPath, 'utf8');
        const escaped = remoteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sectionRe = new RegExp(`\\[remote\\s+"${escaped}"\\]([\\s\\S]*?)(?:\\n\\[|$)`, 'i');
        const m = cfg.match(sectionRe);
        if (!m) return null;
        const urlMatch = m[1].match(/^\s*url\s*=\s*(.+)$/m);
        return urlMatch ? urlMatch[1].trim() : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isLocalOrLoopbackGitTarget(target: string, repoDir: string): boolean {
  const t = target.trim();
  if (!t) return false;
  if (/^file:\/\//i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return isLoopbackUrl(t);
  if (/^(?:ssh|git):\/\/([^/:]+)/i.test(t)) {
    const host = RegExp.$1.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  }
  if (/^[^@\s]+@([^:]+):/.test(t)) {
    const host = RegExp.$1.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  }
  return existsSync(path.resolve(repoDir, t));
}

function isRemoteGitDisallowed(subcommand: string, rawArgs: string[], repoDir: string): string | null {
  if (!GIT_REMOTE_SUBCOMMANDS.has(subcommand)) return null;
  const positional = rawArgs.filter((a) => !a.startsWith('-'));
  if (subcommand === 'clone') {
    const source = positional[0];
    if (!source || !isLocalOrLoopbackGitTarget(source, repoDir)) {
      return source || '(remote)';
    }
    return null;
  }
  if (subcommand === 'submodule') {
    const sub = (positional[0] ?? '').toLowerCase();
    if (sub === 'update' || sub === 'sync' || sub === 'add') {
      const explicitUrl = positional.find((p) => /:\/\/|@[^:]+:/.test(p));
      if (explicitUrl) return isLocalOrLoopbackGitTarget(explicitUrl, repoDir) ? null : explicitUrl;
      const originUrl = gitRemoteUrl(repoDir, 'origin');
      if (!originUrl || !isLocalOrLoopbackGitTarget(originUrl, repoDir)) return originUrl ?? 'origin';
    }
    return null;
  }
  const explicitTarget = positional[0];
  if (explicitTarget) {
    if (/:\/\/|@[^:]+:|[\\/]/.test(explicitTarget)) {
      return isLocalOrLoopbackGitTarget(explicitTarget, repoDir) ? null : explicitTarget;
    }
    const remoteUrl = gitRemoteUrl(repoDir, explicitTarget);
    if (!remoteUrl || !isLocalOrLoopbackGitTarget(remoteUrl, repoDir)) return remoteUrl ?? explicitTarget;
    return null;
  }
  const originUrl = gitRemoteUrl(repoDir, 'origin');
  if (!originUrl || !isLocalOrLoopbackGitTarget(originUrl, repoDir)) return originUrl ?? 'origin';
  return null;
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
    const target = rawArgs.find((token) => !token.startsWith('-')) ?? '';
    const isHttp = /^https?:\/\//i.test(target);
    if (!target || (isHttp && !/^https?:\/\/[\w.-]+/i.test(target))) {
      return { ok: false, isError: true, text: 'git clone needs an https:// (or local/loopback) repository URL.' };
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

  if (ctx.webAccess === false) {
    const blockedTarget = isRemoteGitDisallowed(subcommand, rawArgs, cwd.absolute);
    if (blockedTarget) {
      return {
        ok: false,
        isError: true,
        errorCode: 'web_access_off',
        text:
          `Web access is OFF — "git ${subcommand}" targeting external remote "${blockedTarget}" is blocked. ` +
          'Only local paths, file://, or localhost/loopback remotes are permitted while Web Access is disabled.',
      };
    }
  }

  const commandLine = ['git', subcommand, ...rawArgs].join(' ');
  const destructiveGit =
    GIT_ALWAYS_ASK.has(subcommand) ||
    (subcommand === 'branch' && (rawArgs.includes('-D') || (rawArgs.includes('--delete') && rawArgs.includes('--force')))) ||
    (subcommand === 'checkout' && (rawArgs.includes('--') || rawArgs.includes('-f') || rawArgs.includes('--force'))) ||
    (subcommand === 'restore' && !rawArgs.includes('--staged')) ||
    (subcommand === 'stash' && rawArgs.some((a) => a === 'drop' || a === 'clear'));

  const approved = await approveCommand('git', commandLine, cwd.absolute, destructiveGit, ctx);
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


export function isTerminalTool(wireName: string): boolean {
  return wireName === 'agent__run' || wireName === 'agent__git' || toolByName(wireName)?.terminal === true;
}
