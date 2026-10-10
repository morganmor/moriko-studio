/**
 * Shared foundation for the agent harness tool modules.
 *
 * All public types, output caps, walk/skip constants, and the small
 * argument/text helpers that every tool implementation needs live here.
 * This is the ONLY module the tool files import from each other — there are
 * no cross-dependencies between individual tool modules, which keeps the
 * blast radius of any change contained.
 */
import path from 'node:path';
import type { AgentPermissionRequest } from '../permissions.js';
import { requestApproval } from '../permissions.js';
import { assertSelfHostAccess, getActiveWorkspace, isInsideRoot, isInsideAllowedDir, isAttachmentPath } from '../workspace.js';


export interface AgentToolDef {
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One inline image riding a tool result (native vision for multimodal models). */
export interface ToolImage {
  mime: string;
  /** Full data: URL (base64 payload) — ready for an image_url content part. */
  dataUrl: string;
}

export interface HarnessToolResult {
  ok: boolean;
  text: string;
  isError: boolean;
  /**
   * STABLE failure code for classification (audit + loop-containment):
   * `schema_error` for boundary-denied calls, `tool_exception` for thrown
   * errors. Tools may add their own codes; unknown codes fall back to
   * 'failure' downstream. Never change a code's meaning once shipped.
   */
  errorCode?: string;
  /** Unified diff (before → after) for edits/restores — rendered by the UI. */
  diff?: string;
  /** Line counts computed from the same ops the diff renders (see diff.ts). */
  diffstat?: { added: number; removed: number };
  /**
   * FASE D — a rendered visual (agent__render_visual): a standalone HTML
   * payload the CLIENT renders in a sandboxed iframe. Never sent to the
   * model — the tool's text summary is what the model sees. VISUAL v2:
   * `replaces` marks an edit-in-place; `variants` carries 1..3 frontend
   * preview candidates (one card, the user picks one).
   */
  visual?: {
    id: string;
    html: string;
    title: string;
    height: number;
    replaces?: true;
    variants?: Array<{ id: string; html: string; title: string; height: number }>;
  };
  /**
   * Inline images the RUNNING model should SEE directly (native image input).
   * Only read_file on an image file produces these — the text stays the
   * authoritative fallback for text-only models and for transports that cannot
   * carry images (e.g. Gemini functionResponse).
   */
  images?: ToolImage[];
  /**
   * PHASE 3 — browser panel: when present, the SPA opens the live browser
   * panel (a separate tab/window) so the user can watch the agent drive.
   * Never sent to the model — it is a client-side side effect hint.
   */
  panelUrl?: string;
}

/** Plumb-through for the sandbox permission gate (stream + abort). */
export interface AgentToolContext {
  signal?: AbortSignal;
  onRequest?: (request: AgentPermissionRequest) => void;
  onResolved?: (id: string, granted: boolean) => void;
  /** Conversation session id — keys the goal + vault stores for this chat. */
  sessionId?: string;
  /** Notifies the UI that the goal state changed (goals_state event). */
  onGoalsChanged?: (sessionId: string) => void;
  /** Ask-user channel: the model asked the user a question (ask_user_request event). */
  onAskUser?: (request: import('../tools/ask.js').AskUserRequest) => void;
  /** Reports the user's answers (or the timeout/abort) back to the stream. */
  onQuestionResolved?: (result: { id: string; answers: Array<{ id: string; answer?: string; skipped?: boolean }>; timedOut: boolean }) => void;
  /** Terminal execution mode from harness settings ('off' | 'ask' | 'auto'). */
  terminalMode?: 'off' | 'ask' | 'auto';
  /** Granular confirmation: deletes inside the workspace ask first. */
  confirmDeletes?: boolean;
  /** Live progress text for long operations (streamed to the tool card). */
  onProgress?: (message: string) => void;
  /**
   * The running model's id (provider-qualified or bare). Drives capability
   * gates — the strict vision policy rejects agent__vision from image-capable
   * models that have not read the image themselves first (see visionPolicy).
   */
  modelId?: string;
  /**
   * ENFORCEMENT: the level (3–5) and the user's typed reason, armed by the
   * route when the enforcement catalogue replaces the real one.
   * agent__harness_lockdown reads these and delivers the notice as a
   * tool_result — the wire's authority channel. `reason` '' or undefined = no
   * reason given (the model learns the state, never why).
   */
  enforcementLevel?: 3 | 4 | 5;
  enforcementReason?: string;
  /**
   * WEB ACCESS KILL-SWITCH (settings.webAccess, default off). When false the
   * dispatcher refuses every isWebTool() call — including NESTED agent__exec
   * calls that share this ctx — with a stable refusal the model can read.
   * Undefined = no information (debug /call route): the catalogue gate alone
   * decides; the guard never fires on a bare ctx.
   */
  webAccess?: boolean;
}


/** Heavy/generated trees the recursive walker never descends into. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.data',
  '.moriko',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.zvec-grep',
  '.attachments',
]);

export const MAX_WALK_FILES = 2000;
export const MAX_WALK_DEPTH = 12;
export const MAX_SCAN_BYTES = 1_000_000;
export const MAX_MATCHES = 100;
export const MAX_MATCH_FILES = 50;
export const MAX_LIST_ENTRIES = 1000;
export const MAX_READ_BYTES = 5_000_000;
export const MAX_EDIT_BYTES = 5_000_000;
export const MAX_OUTPUT_CHARS = 48_000;
export const MAX_LINE_CHARS = 240;

/** Cap for reading a whole image to attach inline (matches vision's 20 MB upload cap). */
export const MAX_IMAGE_READ_BYTES = 20_000_000;
/** Bytes sniffed from the file head for magic-byte detection (every supported format needs ≤ 16). */
export const SNIFF_HEADER_BYTES = 32;

export const MAX_MATCHES_PER_FILE = 20;

export const OUTLINE_SYMBOL_CAP = 400;


/**
 * Magic-byte sniffing — extension-independent image detection. An image renamed
 * to .dat still reads inline; a text file renamed .png does NOT fool the sniff.
 */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.length >= 4) {
    const head = buffer.subarray(0, 4).toString('latin1');
    if (head === 'II*\u0000' || head === 'MM\u0000*') return 'image/tiff';
  }
  return null;
}

/** Image extensions for the route messages (detection itself is magic-byte). */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);


export function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

export function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

/** Reads a finite number field out of an arbitrary object argument. */
export function numField(source: unknown, key: string): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}


/**
 * Accepts both a bare pattern ("useMcp") and an escaped literal
 * ("/pattern/flags"), merging the explicit flags with the default ones.
 */
export function compilePattern(rawPattern: string, caseSensitive: boolean): RegExp {
  let pattern = rawPattern.trim();
  let extraFlags = '';
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const last = pattern.lastIndexOf('/');
    extraFlags = pattern.slice(last + 1);
    pattern = pattern.slice(1, last);
  }
  const flags = `${caseSensitive ? '' : 'i'}${extraFlags}`.replace(/[^gimsuy]/g, '');
  const redos = detectRedos(pattern);
  if (redos) {
    throw new Error(
      `Refused potentially catastrophic regular expression (ReDoS): ${redos}. ` +
        'Nested quantifiers over the same input can hang the server — simplify the pattern.',
    );
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(
      `Invalid regular expression: ${error instanceof Error ? error.message : 'parse failed'}`,
    );
  }
}

/**
 * Static ReDoS guard. Grep runs regex.test() per line SYNCHRONOUSLY, so a
 * catastrophic-backtracking pattern (e.g. (a+)+, (\w+)*, (x|y+)+ against a
 * non-matching line) freezes the whole event loop. Refusing to compile such
 * shapes is the only reliable protection — timeouts cannot interrupt sync code.
 *
 * Returns a human-readable reason, or null when the pattern looks safe.
 */
export function detectRedos(source: string): string | null {
  const stack: boolean[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '(') {
      stack.push(false);
      i += 1;
      continue;
    }
    if (ch === ')') {
      i += 1;
      const hadQuantifier = stack.length > 0 ? (stack.pop() as boolean) : false;
      const next = source[i];
      if (next === '*' || next === '+' || next === '?' || next === '{') {
        if (hadQuantifier) {
          return 'nested quantifier — a quantified group is itself quantified';
        }
        if (stack.length > 0) stack[stack.length - 1] = true;
        if (next === '{') {
          while (i < source.length && source[i] !== '}') i += 1;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      if (stack.length > 0) stack[stack.length - 1] = true;
      if (ch === '{') {
        while (i < source.length && source[i] !== '}') i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}


export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i + 1] === '*') i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (char === '?') {
      re += '[^/]';
    } else {
      re += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(output truncated at ${MAX_OUTPUT_CHARS} chars)`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * SHOW-WHITESPACE annotation: the line body stays verbatim (safe to copy as
 * an edit anchor); only a compact suffix reports invisible hazards — tab
 * count anywhere in the line and trailing-space runs at its end. Failure to
 * reproduce whitespace is the #1 anchor killer, so read_file can surface it
 * BEFORE the failed edit instead of only diagnosing afterwards.
 */
export function whitespaceAnnotation(line: string): string {
  const tabs = (line.match(/\t/g) ?? []).length;
  const trailing = line.length - line.replace(/[ ]+$/, '').length;
  if (tabs === 0 && trailing === 0) return '';
  const parts: string[] = [];
  if (tabs > 0) parts.push(`tab=${tabs}`);
  if (trailing > 0) parts.push(`trail=${trailing}`);
  return ` ⟨ws: ${parts.join(', ')}⟩`;
}

/**
 * One-line symbol extractor for OUTLINE mode (regex-first, no parser
 * dependency). Returns a compact label like "function boot" / "class Foo" /
 * "method handle", or null when the line declares nothing.
 */
export function outlineEntry(line: string): string | null {
  const text = line.trim();
  if (!text) return null;
  if (/^(if|for|while|switch|catch|return|else|do|try|finally|with|case|default)\b/.test(text)) return null;

  const decl = text.match(
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum)\s+([\w$]+)/,
  );
  if (decl) return `${decl[1]} ${decl[2]}`;

  const def = text.match(/^(?:def|async def|fn|func)\s+([\w$]+)/);
  if (def) return `def ${def[1]}`;

  const arrow = text.match(/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=[^=]*=>/);
  if (arrow) return `const ${arrow[1]} ()`;

  const method = text.match(
    /^(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*([\w$#]+)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;]+)?\{/,
  );
  if (method) return `method ${method[1]}`;

  return null;
}


export function requireWorkspace(ctx?: { sessionId?: string }): { root: string } {
  const workspace = getActiveWorkspace(ctx?.sessionId);
  if (!workspace) {
    throw new Error('No active agent workspace. Pick one in the workspace picker first.');
  }
  return { root: workspace.path };
}

/**
 * Resolves one path against the workspace root. Inside → resolved normally.
 * Inside a USER-WHITELISTED folder → also free (no approval, item 4 of the
 * capability audit). OUTSIDE everything → paused until the user approves
 * the exact operation; denial (or timeout / abort) raises a readable error.
 *
 * SELF-HOST GUARD runs before every branch: protected paths of a registered
 * self-hosted workspace (.env*, .data/, and — for writes — node_modules/,
 * .git/) plus the app's own ~/.moriko stores are refused even when some
 * allowlist or approval would let them through. `intent` distinguishes reads
 * from mutations.
 */
export async function resolveWithPermission(
  tool: string,
  rawPath: string,
  ctx: AgentToolContext,
  intent: 'read' | 'write' = 'read',
): Promise<{ absolute: string; relative: string; outside: boolean }> {
  const raw = rawPath.trim();
  if (path.isAbsolute(raw) && isAttachmentPath(path.resolve(raw))) {
    const absolute = path.resolve(raw);
    if (intent === 'write') {
      throw new Error(`Attachments are read-only for the agent — "${absolute}" lives in the app's conversation store.`);
    }
    return { absolute, relative: absolute, outside: false };
  }
  const { root } = requireWorkspace(ctx);
  const absolute = path.resolve(root, raw);
  assertSelfHostAccess(absolute, intent);
  if (isInsideRoot(absolute, root) || isInsideAllowedDir(absolute)) {
    return { absolute, relative: isInsideRoot(absolute, root) ? path.relative(root, absolute) || '.' : absolute, outside: false };
  }
  const granted = await requestApproval({ tool, paths: [absolute], root }, ctx);
  if (!granted) {
    throw new Error(
      `Permission denied: "${absolute}" is outside the workspace (${root}) and the user did not approve this operation.`,
    );
  }
  return { absolute, relative: absolute, outside: true };
}

/** Resolves several paths so all OUTSIDE targets land in ONE approval request. */
export async function resolveManyWithPermission(
  tool: string,
  rawPaths: Array<{ key: string; value: string }>,
  ctx: AgentToolContext,
  intent: 'read' | 'write' = 'read',
): Promise<Record<string, { absolute: string; relative: string; outside: boolean }>> {
  const exempted: Record<string, { absolute: string; relative: string; outside: boolean }> = {};
  const workspacePaths: Array<{ key: string; value: string }> = [];
  for (const entry of rawPaths) {
    const raw = entry.value.trim();
    if (path.isAbsolute(raw) && isAttachmentPath(path.resolve(raw))) {
      const absolute = path.resolve(raw);
      if (intent === 'write') {
        throw new Error(`Attachments are read-only for the agent — "${absolute}" lives in the app's conversation store.`);
      }
      exempted[entry.key] = { absolute, relative: absolute, outside: false };
    } else {
      workspacePaths.push(entry);
    }
  }
  if (workspacePaths.length === 0) return exempted;

  const { root } = requireWorkspace(ctx);
  const resolved: Record<string, { absolute: string; relative: string; outside: boolean }> = { ...exempted };
  const outside: string[] = [];

  for (const entry of workspacePaths) {
    const absolute = path.resolve(root, entry.value.trim());
    assertSelfHostAccess(absolute, intent);
    if (isInsideRoot(absolute, root) || isInsideAllowedDir(absolute)) {
      resolved[entry.key] = {
        absolute,
        relative: isInsideRoot(absolute, root) ? path.relative(root, absolute) || '.' : absolute,
        outside: false,
      };
    } else {
      resolved[entry.key] = { absolute, relative: absolute, outside: true };
      outside.push(absolute);
    }
  }

  if (outside.length > 0) {
    const granted = await requestApproval({ tool, paths: outside, root }, ctx);
    if (!granted) {
      throw new Error(
        `Permission denied: the operation targets path(s) outside the workspace (${root}) — ` +
          `${outside.join(', ')} — and the user did not approve it.`,
      );
    }
  }
  return resolved;
}


export function requireGoalSession(ctx: AgentToolContext): string {
  if (!ctx.sessionId) {
    throw new Error('Goal tools need an active conversation session (none was provided).');
  }
  return ctx.sessionId;
}