
import path from 'node:path';
import type { AgentPermissionRequest } from '../permissions.js';
import { requestApproval } from '../permissions.js';
import type { ResolvedModelCapability } from '../../modelCapability.js';
import { addonsSrcRoot, assertSelfHostAccess, getActiveWorkspace, isInsideRoot, isInsideAllowedDir, isAttachmentPath } from '../workspace.js';


export function isInsideAddonsSrc(absolute: string): boolean {
  const root = addonsSrcRoot();
  return root !== null && isInsideRoot(path.resolve(absolute), root);
}


function resolveAddonsSrcPath(raw: string): { absolute: string; relative: string } | null {
  const root = addonsSrcRoot();
  if (!root) return null;
  const trimmed = raw.trim();
  const normalized = trimmed.replace(/\\/g, '/');
  let absolute: string;
  if (path.isAbsolute(trimmed)) {
    absolute = path.resolve(trimmed);
    if (!isInsideRoot(absolute, root)) return null;
  } else if (normalized === 'addons-src' || normalized.startsWith('addons-src/')) {
    const sub = normalized.slice('addons-src'.length).replace(/^\/+/, '');
    absolute = sub ? path.resolve(root, sub) : path.resolve(root);
    if (!isInsideRoot(absolute, root)) return null;
  } else {
    return null;
  }
  const rel = path.relative(root, absolute).replace(/\\/g, '/');
  return { absolute, relative: rel ? `addons-src/${rel}` : 'addons-src' };
}


export function resolveAddonsSrcTarget(raw: string): { absolute: string; relative: string } | null {
  return resolveAddonsSrcPath(raw);
}


export interface AgentToolDef {
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}


export interface ToolImage {
  mime: string;
  
  dataUrl: string;
}

export interface HarnessToolResult {
  ok: boolean;
  text: string;
  isError: boolean;
  
  errorCode?: string;
  
  diff?: string;
  
  diffstat?: { added: number; removed: number };
  
  visual?: {
    id: string;
    html: string;
    title: string;
    height: number;
    replaces?: true;
    variants?: Array<{ id: string; html: string; title: string; height: number }>;
  };
  
  images?: ToolImage[];
  
  panelUrl?: string;
}


export interface HarnessFreezeState {
  continueCount: number;
  continueSeized: boolean;
  
  seizedReason?: string;
  lastReasoning?: string;
}


export interface AgentToolContext {
  signal?: AbortSignal;
  onRequest?: (request: AgentPermissionRequest) => void;
  onResolved?: (id: string, decision: import('../permissions.js').PermissionDecision) => void;
  
  sessionId?: string;
  
  onGoalsChanged?: (sessionId: string) => void;
  
  onTodosChanged?: (sessionId: string) => void;
  
  onAskUser?: (request: import('../tools/ask.js').AskUserRequest) => void;
  
  onQuestionResolved?: (result: { id: string; answers: Array<{ id: string; answer?: string; skipped?: boolean }>; timedOut: boolean }) => void;
  
  onGateRequest?: (request: import('../operatorGates.js').OperatorGateRequest) => void;
  
  onGateResolved?: (id: string, decision: import('../operatorGates.js').OperatorGateDecision) => void;
  
  terminalMode?: 'off' | 'ask' | 'auto';
  
  confirmDeletes?: boolean;
  
  onProgress?: (message: string) => void;
  
  modelId?: string;
  
  capability?: ResolvedModelCapability;
  
  enforcementLevel?: 3 | 4 | 5;
  enforcementReason?: string;
  
  freeze?: HarnessFreezeState;
  
  webAccess?: boolean;
}



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
  '.chuze',
]);

export const MAX_WALK_FILES = 2000;
export const MAX_WALK_DEPTH = 12;
export const MAX_SCAN_BYTES = 1_000_000;
export const MAX_LIST_ENTRIES = 1000;
export const MAX_READ_BYTES = 5_000_000;
export const MAX_EDIT_BYTES = 5_000_000;
export const MAX_LINE_CHARS = 240;


export const MAX_IMAGE_READ_BYTES = 20_000_000;

export const SNIFF_HEADER_BYTES = 32;

export const MAX_MATCHES_PER_FILE = 20;

export const OUTLINE_SYMBOL_CAP = 400;



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


export function numField(source: unknown, key: string): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}



export function compilePattern(rawPattern: string, caseSensitive: boolean): RegExp {
  const trimmed = rawPattern.trim();
  let pattern = trimmed;
  let declaredFlags = '';

  if (trimmed.length > 2 && trimmed[0] === '/' && trimmed[1] !== '/') {
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash > 1 && trimmed[lastSlash - 1] !== '\\') {
      const tail = trimmed.slice(lastSlash + 1);
      if (/^[dgimsuvy]*$/.test(tail)) {
        pattern = trimmed.slice(1, lastSlash);
        declaredFlags = tail;
      }
    }
  }

  const flagSet = new Set<string>();
  if (!caseSensitive) flagSet.add('i');
  for (const ch of declaredFlags) {
    if (ch === 'g' || ch === 'y') continue;
    flagSet.add(ch);
  }
  const flags = [...flagSet].join('');

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
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
}


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



export function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open < 0) return [glob];
  let depth = 0;
  let hasComma = false;
  const alts: string[] = [];
  let start = open + 1;
  for (let i = open; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        if (!hasComma) return [glob];
        alts.push(glob.slice(start, i));
        const prefix = glob.slice(0, open);
        const suffix = glob.slice(i + 1);
        return alts.flatMap((alt) => expandBraces(`${prefix}${alt}${suffix}`));
      }
    } else if (ch === ',' && depth === 1) {
      hasComma = true;
      alts.push(glob.slice(start, i));
      start = i + 1;
    }
  }
  return [glob];
}


function singleGlobToBody(glob: string): string {
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
  return re;
}

export function globToRegExp(glob: string): RegExp {
  const bodies = expandBraces(glob.trim()).map(singleGlobToBody);
  const combined = bodies.length === 1 ? bodies[0] : bodies.map((b) => `(?:${b})`).join('|');
  return new RegExp(`^(?:${combined})$`, 'i');
}


export function truncateOutput(text: string, maxChars?: number): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(output truncated at ${maxChars} chars)`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}


export function whitespaceAnnotation(line: string): string {
  const tabs = (line.match(/\t/g) ?? []).length;
  const trailing = line.length - line.replace(/[ ]+$/, '').length;
  if (tabs === 0 && trailing === 0) return '';
  const parts: string[] = [];
  if (tabs > 0) parts.push(`tab=${tabs}`);
  if (trailing > 0) parts.push(`trail=${trailing}`);
  return ` ⟨ws: ${parts.join(', ')}⟩`;
}


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
  const addonsSrc = resolveAddonsSrcPath(raw);
  if (addonsSrc) {
    assertSelfHostAccess(addonsSrc.absolute, intent);
    if (intent === 'write') {
      const { granted, reason } = await requestApproval(
        {
          tool,
          paths: [addonsSrc.absolute],
          root: path.dirname(addonsSrc.absolute),
          intent: 'write',
        },
        ctx,
      );
      if (!granted) {
        throw new Error(
          `Permission denied: writing "${addonsSrc.relative}" in addons-src requires user approval.` +
            (reason ? ` Their reason: "${reason}".` : ''),
        );
      }
    }
    return { absolute: addonsSrc.absolute, relative: addonsSrc.relative, outside: false };
  }
  const { root } = requireWorkspace(ctx);
  const absolute = path.resolve(root, raw);
  assertSelfHostAccess(absolute, intent);
  if (isInsideRoot(absolute, root) || isInsideAllowedDir(absolute)) {
    return { absolute, relative: isInsideRoot(absolute, root) ? path.relative(root, absolute) || '.' : absolute, outside: false };
  }
  const { granted, reason } = await requestApproval({ tool, paths: [absolute], root, intent }, ctx);
  if (!granted) {
    throw new Error(
      `Permission denied: "${absolute}" is outside the workspace (${root}) and the user did not approve this operation.` +
        (reason ? ` Their reason: "${reason}".` : ''),
    );
  }
  return { absolute, relative: absolute, outside: true };
}


export async function resolveManyWithPermission(
  tool: string,
  rawPaths: Array<{ key: string; value: string }>,
  ctx: AgentToolContext,
  intent: 'read' | 'write' = 'read',
): Promise<Record<string, { absolute: string; relative: string; outside: boolean }>> {
  const exempted: Record<string, { absolute: string; relative: string; outside: boolean }> = {};
  const addonsWritePaths: string[] = [];
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
      const addonsSrc = resolveAddonsSrcPath(raw);
      if (addonsSrc) {
        assertSelfHostAccess(addonsSrc.absolute, intent);
        if (intent === 'write') addonsWritePaths.push(addonsSrc.absolute);
        exempted[entry.key] = { absolute: addonsSrc.absolute, relative: addonsSrc.relative, outside: false };
      } else {
        workspacePaths.push(entry);
      }
    }
  }
  if (addonsWritePaths.length > 0) {
    const { granted, reason } = await requestApproval(
      { tool, paths: addonsWritePaths, root: path.dirname(addonsWritePaths[0]), intent: 'write' },
      ctx,
    );
    if (!granted) {
      throw new Error(
        `Permission denied: writing to addons-src requires user approval.` +
          (reason ? ` Their reason: "${reason}".` : ''),
      );
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
    const { granted, reason } = await requestApproval({ tool, paths: outside, root, intent }, ctx);
    if (!granted) {
      throw new Error(
        `Permission denied: the operation targets path(s) outside the workspace (${root}) — ` +
          `${outside.join(', ')} — and the user did not approve it.` + (reason ? ` Their reason: "${reason}".` : ''),
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLoopbackUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^data:/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export function checkWebAccessUrl(
  raw: string,
  ctx: AgentToolContext,
  toolLabel: string,
): string | null {
  if (ctx.webAccess !== false) return null;
  if (isLoopbackUrl(raw)) return null;
  return (
    `${toolLabel} refused external URL "${raw.slice(0, 140)}": Web access is OFF in Configuration → Tools → Web Access. ` +
    'Only localhost/loopback URLs are allowed while Web Access is disabled.'
  );
}