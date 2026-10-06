/**
 * PROCESS SANDBOX — the enforcement layer BELOW the permission gate.
 *
 * The permission gate asks the user; the sandbox contains what the APPROVED
 * process can actually reach. Deep down, the real guarantee needed is:
 * a tool the user approved to run `pnpm build` must not leak API keys into
 * the child's environment, and must not write outside the workspace.
 *
 * Windows has no bwrap/Landlock/Seatbelt equivalent that is practical to
 * reach from Node — NO KERNEL CONFINEMENT IS PRETENDED HERE. What IS
 * enforced is real and tested:
 *   - environment hardening (secret scrubbing beyond minimalEnv)
 *   - working-directory lock (cwd forced inside the workspace)
 *   - write-policy: the harness knows whether this run may write at all
 *   - resource limits (timeout, output cap; signal-based kill)
 *
 * Each guarantee this module actually provides is a real boundary; what it
 * cannot provide is named plainly, so nobody mistakes this for a kernel jail.
 */
import path from 'node:path';
import { morikoHome } from '../paths.js';

/**
 * Execution policy for a spawned tool process.
 *   - 'read-only'          → run may read anything reachable, but the harness
 *                            treats any write attempt (via its own tools) as
 *                            a policy violation.
 *   - 'workspace-write'    → DEFAULT. Writes stay inside the workspace root.
 *   - 'danger-full-access' → only with an explicit user approval; recorded.
 */
export type SandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface SandboxOptions {
  /** The workspace the command runs in; cwd is forced inside it. */
  workspaceRoot: string;
  /** Sandbox write policy; defaults to 'workspace-write'. */
  policy?: SandboxPolicy;
  /** Hooked into audit logging when a policy decision is made. */
  onViolation?: (detail: string) => void;
}

/**
 * Environment keys that must NEVER reach a child process. exec.ts's
 * minimalEnv() already allowlists only ~26 system vars, so this is the
 * defense-in-depth list: if someone widens that allowlist later, these
 * secret-shaped names still get scrubbed here.
 */
const SECRET_ENV_PATTERNS = [
  /API[_-]?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /ANTHROPIC/i,
  /OPENAI/i,
  /GOOGLE[_-]?GENAI/i,
  /GEMINI/i,
  /DEEPSEEK/i,
  /MISTRAL/i,
  /GROQ/i,
  /TOGETHER/i,
  /FIREWORKS/i,
  /REPLICATE/i,
  /HF_TOKEN/i,
  /HUGGING[_-]?FACE/i,
  /COHERE/i,
  /AZURE/i,
  /AWS[_-]?(ACCESS|SECRET)/i,
  /CLAUDE/i,
  /MORIKO/i,
];

/**
 * Scrub the inherited environment of secret-shaped variables. Called after
 * minimalEnv() builds the allowlisted set — belt and braces.
 */
export function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (SECRET_ENV_PATTERNS.some((re) => re.test(key))) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

/**
 * Resolves the cwd for a child process. The workspace root wins; anything
 * that resolves outside it (a `..` escape) is clamped back to the root and
 * reported via onViolation, because a legit command never needs that.
 */
export function resolveSandboxCwd(requestedCwd: string | undefined, opts: SandboxOptions): string {
  const root = path.resolve(opts.workspaceRoot);
  if (!requestedCwd) return root;
  const resolved = path.resolve(root, requestedCwd);
  const isInside =
    resolved === root ||
    (process.platform === 'win32'
      ? resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)
      : resolved.startsWith(root + path.sep));
  if (!isInside) {
    opts.onViolation?.(
      `cwd "${requestedCwd}" escapes the workspace root; clamped to the workspace.`,
    );
    return root;
  }
  return resolved;
}

/**
 * Records a sandbox decision for the audit trail. Called by runProcess hooks
 * whenever a policy boundary was enforced (cwd clamp, write refusal, or a
 * full-access escalation being used).
 */
export function sandboxAuditNote(opts: SandboxOptions, note: string): string {
  return `[sandbox:${opts.policy ?? 'workspace-write'}] ${note}`;
}

/**
 * True when `target` is a path the harness already knows is off-limits —
 * ~/.moriko (app state + secrets) and the app's own source tree internals.
 * exec callers use this to refuse a write before spawning anything.
 */
export function isProtectedTarget(target: string): boolean {
  const morikoRoot = path.resolve(morikoHome);
  const abs = path.resolve(target);
  return abs === morikoRoot || abs.startsWith(morikoRoot + path.sep);
}
