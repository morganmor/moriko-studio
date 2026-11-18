
import path from 'node:path';
import { morikoHome } from '../paths.js';


export type SandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface SandboxOptions {
  
  workspaceRoot: string;
  
  policy?: SandboxPolicy;
  
  onViolation?: (detail: string) => void;
}


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


export function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (SECRET_ENV_PATTERNS.some((re) => re.test(key))) {
      delete cleaned[key];
    }
  }
  return cleaned;
}


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


export function sandboxAuditNote(opts: SandboxOptions, note: string): string {
  return `[sandbox:${opts.policy ?? 'workspace-write'}] ${note}`;
}


export function isProtectedTarget(target: string): boolean {
  const morikoRoot = path.resolve(morikoHome);
  const abs = path.resolve(target);
  return abs === morikoRoot || abs.startsWith(morikoRoot + path.sep);
}
