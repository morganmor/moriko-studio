import { spawn, type ChildProcess } from 'node:child_process';
import { scrubSecrets, resolveSandboxCwd, type SandboxOptions } from './sandbox.js';

/**
 * SHELL-BASED PROCESS EXECUTION for the agent harness.
 *
 * Design:
 *  - agent__run / agent__git / agent__task_start run commands through the
 *    NATIVE SYSTEM SHELL (cmd.exe on Windows, /bin/sh on Unix). Shell
 *    metacharacters — pipes, redirects, chaining, substitution — are
 *    interpreted by the shell intentionally. The agent has full shell
 *    access, equivalent to a command prompt.
 *  - NO program allowlist and NO shell-metacharacter rejection. Any
 *    program installed on the system can be invoked.
 *  - The workspace-write sandbox is still enforced: cwd is clamped inside
 *    the workspace root, and secrets are scrubbed from the child env.
 *  - Hard timeout with kill, output capped, minimal environment.
 *  - Internal harness callers (gitbadges, reload, edit, test-run) use
 *    runProcess() — a direct spawn for known programs with vetted args,
 *    NOT exposed to the agent.
 */

const RUN_TIMEOUT_MS = 120_000;
const RUN_MAX_TIMEOUT_MS = 600_000;
const RUN_OUTPUT_CHARS = 48_000;

/**
 * SELF-DESTRUCTION GUARD.
 *
 * The harness runs as a Node process. A command like `taskkill /F /IM
 * node.exe` (Windows) or `pkill node` / `killall node` (Unix) would kill
 * EVERY node process on the machine — including the harness server itself.
 * The agent must never be allowed to issue such a command: it would silently
 * terminate the server, the SSE stream, and every active conversation.
 *
 * This check runs in BOTH the foreground (runShellCommand) and background
 * (spawnBackgroundShell) paths — it is the LAST gate before spawn, so no
 * caller can bypass it.
 */
const SELF_KILL_PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
  { regex: /\btaskkill\b[\s/]*[^]*?\b\/IM\s+node(?:\.exe)?\b/i, reason: 'taskkill /IM node.exe would kill the harness server itself.' },
  { regex: /\btaskkill\b[\s/]*[^]*?\b\/PID\s+\d+/i, reason: 'taskkill /PID targets a process by ID — this can kill the harness server.' },
  { regex: /\bpkill\b[^]*?\bnode\b/i, reason: 'pkill node would kill the harness server itself.' },
  { regex: /\bkillall\b[^]*?\bnode\b/i, reason: 'killall node would kill the harness server itself.' },
  { regex: /\bkill\s+-\d+\s+\d+/i, reason: 'kill with a PID can target the harness server process.' },
];

/** Check a command line for self-destruction attempts. Returns a reason string if blocked. */
export function checkSelfDestruct(commandLine: string): string | null {
  for (const pattern of SELF_KILL_PATTERNS) {
    if (pattern.regex.test(commandLine)) return pattern.reason;
  }
  return null;
}

/**
 * Resolve the native system shell for the current platform.
 * Windows: cmd.exe (always available). Unix: /bin/sh (POSIX standard).
 */
function getSystemShell(): { shell: string; flag: string } {
  if (process.platform === 'win32') {
    return { shell: 'cmd.exe', flag: '/d /s /c' };
  }
  return { shell: '/bin/sh', flag: '-c' };
}

export interface RunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Combined, capped text the model sees. */
  output: string;
}

/**
 * Spawns ONE process directly (NOT via shell) for internal harness callers
 * (gitbadges, reload, edit, test-run). `program`/`args` must already be
 * vetted by the caller. Never throws — failures come back as data.
 *
 * On Windows, .cmd shims (npm, tsc, …) need cmd to resolve; we compose a
 * quoted cmd /d /s /c line with windowsVerbatimArguments to avoid Node's
 * broken default re-quoting.
 */
export function runProcess(
  program: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Sandbox policy: clamps cwd inside the workspace and scrubs secrets. */
    sandbox?: SandboxOptions;
  },
): Promise<RunOutcome> {
  const { sandbox } = options;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? RUN_TIMEOUT_MS, 1_000), RUN_MAX_TIMEOUT_MS);
  const started = Date.now();

  return new Promise<RunOutcome>((resolve) => {
    let child;
    let timedOut = false;
    const isWin = process.platform === 'win32';
    if (isWin) {
      child = spawn('cmd.exe', ['/d', '/s', '/c', [program, ...args].map(quoteForCmd).join(' ')], {
        cwd: sandbox ? resolveSandboxCwd(options.cwd, sandbox) : options.cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: scrubSecrets(minimalEnv()),
      });
    } else {
      child = spawn(program, args, {
        cwd: sandbox ? resolveSandboxCwd(options.cwd, sandbox) : options.cwd,
        shell: false,
        windowsHide: true,
        env: scrubSecrets(minimalEnv()),
      });
    }

    let stdout = '';
    let stderr = '';
    let capped = false;
    const cap = (existing: string, addition: string): string => {
      if (capped) return existing;
      const merged = existing + addition;
      if (merged.length > RUN_OUTPUT_CHARS) {
        capped = true;
        return merged.slice(0, RUN_OUTPUT_CHARS);
      }
      return merged;
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk.toString('utf8'));
      if (capped) child.stdout?.destroy();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk.toString('utf8'));
      if (capped) child.stderr?.destroy();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = (): void => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const tail = capped ? `\n…(output truncated at ${RUN_OUTPUT_CHARS} chars)` : '';
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        output:
          (timedOut ? `[process killed after ${Math.round(timeoutMs / 1000)}s timeout]\n` : '') +
          `${stdout || stderr || '(no output)'}${tail}`,
      });
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      stderr = cap(stderr, `${error.message}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Runs a command line through the NATIVE SYSTEM SHELL (cmd.exe on Windows,
 * /bin/sh on Unix). Shell metacharacters — pipes, redirects, chaining,
 * substitution — are all interpreted by the shell. No program allowlist;
 * any program installed on the system can be invoked. The workspace-write
 * sandbox clamps cwd and scrubs secrets. Never throws — failures come
 * back as data.
 */
export function runShellCommand(
  commandLine: string,
  options: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    sandbox?: SandboxOptions;
  },
): Promise<RunOutcome> {
  const blocked = checkSelfDestruct(commandLine);
  if (blocked) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: `Blocked: ${blocked}`,
      timedOut: false,
      durationMs: 0,
      output: `[BLOCKED — self-destruction guard]\n${blocked}\n\nThe harness server itself is a Node process. This command would kill it.\nTo stop a specific background task, use agent__task_stop with its task ID instead.`,
    });
  }
  const { sandbox } = options;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? RUN_TIMEOUT_MS, 1_000), RUN_MAX_TIMEOUT_MS);
  const started = Date.now();
  const { shell, flag } = getSystemShell();
  const shellArgs = process.platform === 'win32' ? flag.split(' ').concat(commandLine) : [flag, commandLine];

  return new Promise<RunOutcome>((resolve) => {
    let child;
    let timedOut = false;
    child = spawn(shell, shellArgs, {
      cwd: sandbox ? resolveSandboxCwd(options.cwd, sandbox) : options.cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
      env: scrubSecrets(minimalEnv()),
    });

    let stdout = '';
    let stderr = '';
    let capped = false;
    const cap = (existing: string, addition: string): string => {
      if (capped) return existing;
      const merged = existing + addition;
      if (merged.length > RUN_OUTPUT_CHARS) {
        capped = true;
        return merged.slice(0, RUN_OUTPUT_CHARS);
      }
      return merged;
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk.toString('utf8'));
      if (capped) child.stdout?.destroy();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk.toString('utf8'));
      if (capped) child.stderr?.destroy();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = (): void => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const tail = capped ? `\n…(output truncated at ${RUN_OUTPUT_CHARS} chars)` : '';
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        output:
          (timedOut ? `[process killed after ${Math.round(timeoutMs / 1000)}s timeout]\n` : '') +
          `${stdout || stderr || '(no output)'}${tail}`,
      });
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      stderr = cap(stderr, `${error.message}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Spawns a BACKGROUND shell process (non-blocking) for agent__task_start.
 * Runs the command line through the native system shell. Returns the
 * ChildProcess immediately so the caller can poll its output.
 */
export function spawnBackgroundShell(
  commandLine: string,
  options: { cwd: string },
): ChildProcess {
  const blocked = checkSelfDestruct(commandLine);
  if (blocked) {
    const dummy = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', 
      process.platform === 'win32' ? ['/c', 'echo', blocked] : ['-c', `echo "${blocked}"`], 
      { windowsHide: true, shell: false, env: scrubSecrets(minimalEnv()) });
    return dummy;
  }
  const { shell, flag } = getSystemShell();
  const shellArgs = process.platform === 'win32' ? flag.split(' ').concat(commandLine) : [flag, commandLine];
  return spawn(shell, shellArgs, {
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === 'win32',
    env: scrubSecrets(minimalEnv()),
  });
}

/** Minimal child environment: no Moriko/user secrets, just what builds need. */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
    'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME',
    'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'PYTHONIOENCODING', 'PYTHONUTF8',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NODE_NO_WARNINGS = '1';
  return env;
}


/** Quote one token for cmd /d /s /c (internal callers only). */
function quoteForCmd(token: string): string {
  if (token === '') return '""';
  let escaped = token.replace(/"/g, '""');
  if (/[ \t"&|<>^();,]/.test(token) || escaped.endsWith('\\')) {
    escaped = escaped.replace(/\\$/, '\\\\');
    return `"${escaped}"`;
  }
  return token;
}


/** Human framing added by the tools around a RunOutcome. */

export function formatRunOutcome(outcome: RunOutcome, commandLine: string): string {
  const header =
    `> ${commandLine}\n` +
    `exit code: ${outcome.exitCode ?? 'null'}${outcome.timedOut ? ' (timed out)' : ''} · ${Math.round(outcome.durationMs / 100) / 10}s\n\n`;
  return header + outcome.output;
}
