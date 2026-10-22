/**
 * MCP Bridge — exposes Council + RSAT addon tools and read-only workspace
 * tools to EXTERNAL MCP clients (claude.ai custom connectors, Gemini web
 * custom apps) over Streamable HTTP.
 *
 * Actor binding: every addon tool call runs AS a council Main Session
 * (orchestrator) — external orchestrators command the same sub sessions.
 * Workspace tools are strictly READ-ONLY, jail-resolved to the bound
 * workspace root: external clients can look and read, never edit.
 *
 * The Main Session and Workspace are user-configurable (Settings → MCP →
 * MCP Bridge); "auto" falls back to the first stored main conversation and
 * the app-active workspace respectively.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { morikoHome } from '../paths.js';
import { atomicWriteJson } from '../atomicWrite.js';
import {
  listAddonToolDefs,
  getAddonToolHandler,
  addonToolReadOnly,
} from '../addons/registry.js';
import { getActiveWorkspace, listWorkspaces } from '../agents/workspace.js';
import { assertAllowedTarget, loadPlaywright } from '../agents/spatial-runtime.js';
import { listStoredConversationSummaries } from '../conversationStore.js';
import { callAgentTool } from '../agents/tools/dispatcher.js';
import { listAgentToolDefs } from '../agents/tools/catalogue.js';
import { bridgeHarnessToolDefs, isBridgeExposedTool } from './bridgePolicy.js';

const TOKEN_FILE = path.join(morikoHome, 'mcp-bridge.json');

interface BridgeConfig {
  version: 1;
  token: string;
  createdAt: string;
  /** Explicit Main Session (conversation id) chosen in Settings; '' = auto. */
  sessionId?: string;
  /** Explicit workspace id chosen in Settings; '' = auto (active workspace). */
  workspaceId?: string;
}

let configCache: BridgeConfig | null = null;

function loadConfig(): BridgeConfig {
  if (configCache) return configCache;
  try {
    if (existsSync(TOKEN_FILE)) {
      const parsed = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as BridgeConfig;
      if (parsed?.token) {
        configCache = parsed;
        return parsed;
      }
    }
  } catch {
    // fall through and regenerate
  }
  const created: BridgeConfig = {
    version: 1,
    token: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  atomicWriteJson(TOKEN_FILE, created);
  configCache = created;
  return created;
}

function saveConfig(next: BridgeConfig): void {
  configCache = next;
  atomicWriteJson(TOKEN_FILE, next);
}

/** The bridge credential — persisted in morikoHome, generated on first use. */
export function bridgeToken(): string {
  return loadConfig().token;
}

/** Patches user choices (Settings). Unknown fields are preserved. */
export function patchBridgeConfig(patch: { sessionId?: string; workspaceId?: string }): void {
  const current = loadConfig();
  saveConfig({
    ...current,
    sessionId: typeof patch.sessionId === 'string' ? patch.sessionId : current.sessionId,
    workspaceId: typeof patch.workspaceId === 'string' ? patch.workspaceId : current.workspaceId,
  });
}

export interface BridgeSettingsView {
  token: string;
  /** '' = auto (first stored main conversation). */
  sessionId: string;
  /** '' = auto (app-active workspace). */
  workspaceId: string;
  /** Candidate Main Sessions (council mains first) for the Settings dropdown. */
  sessions: Array<{ id: string; title: string; councilRole?: string }>;
  /** Registered workspaces for the Settings dropdown. */
  workspaces: Array<{ id: string; label: string; path: string }>;
  /** Effective binding actually used by tool calls right now. */
  effective: { sessionId: string | null; workspacePath: string | null };
}

export function bridgeSettings(): BridgeSettingsView {
  const config = loadConfig();
  let sessions: BridgeSettingsView['sessions'] = [];
  try {
    sessions = (listStoredConversationSummaries() as Array<{
      id?: string;
      title?: string;
      councilRole?: string;
    }>)
      .filter((c) => c.id)
      .map((c) => ({ id: c.id as string, title: c.title ?? c.id as string, councilRole: c.councilRole }));
  } catch {
    sessions = [];
  }
  let workspaces: BridgeSettingsView['workspaces'] = [];
  try {
    workspaces = listWorkspaces().map((w) => ({ id: w.id, label: w.label, path: w.path }));
  } catch {
    workspaces = [];
  }
  const effectiveSession = resolveMainSessionId();
  let effectivePath: string | null = null;
  try {
    effectivePath = resolveWorkspaceRoot();
  } catch {
    effectivePath = null;
  }
  return {
    token: config.token,
    sessionId: config.sessionId ?? '',
    workspaceId: config.workspaceId ?? '',
    sessions,
    workspaces,
    effective: { sessionId: effectiveSession, workspacePath: effectivePath },
  };
}

/**
 * The session the bridge acts as: the user's chosen Main Session (Settings),
 * else the first stored council main conversation. Tools run with this
 * sessionId, so the orchestrator gate and RSAT actor resolution behave
 * exactly as in-chat.
 */
export function resolveMainSessionId(): string | null {
  const config = loadConfig();
  const chosen = String(config.sessionId ?? '').trim();
  if (chosen) return chosen;
  try {
    const summaries = listStoredConversationSummaries() as Array<{
      id?: string;
      councilRole?: string;
    }>;
    const main = summaries.find((c) => c.councilRole === 'main' && c.id);
    return main?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The workspace root external clients may read: the user's chosen workspace
 * (Settings), else the app-active workspace. Read tools are jailed here.
 */
export function resolveWorkspaceRoot(): string | null {
  const config = loadConfig();
  const chosenId = String(config.workspaceId ?? '').trim();
  if (chosenId) {
    try {
      const found = listWorkspaces().find((w) => w.id === chosenId);
      if (found?.path) return found.path;
    } catch {
      // fall through to active workspace
    }
  }
  try {
    const sessionId = resolveMainSessionId() ?? undefined;
    return (getActiveWorkspace(sessionId) ?? getActiveWorkspace())?.path ?? null;
  } catch {
    return null;
  }
}

export type BridgeContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface BridgeToolResult {
  content: BridgeContent[];
  isError: boolean;
}

function textOut(text: string, isError = false): BridgeToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/** Text + inline PNG — MCP image blocks let Claude/Gemini actually SEE the capture. */
function imageOut(text: string, dataUrl: string): BridgeToolResult {
  const commaIdx = dataUrl.indexOf(',');
  const header = commaIdx >= 0 ? dataUrl.slice(0, commaIdx) : '';
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'image/png';
  const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return { content: [{ type: 'text', text }, { type: 'image', data, mimeType: mime }], isError: false };
}

/**
 * ws_screenshot — headless-browser capture of a LOCAL dev server (the UI a
 * sub agent is building). Launch → navigate → wait → screenshot → close.
 * Targets are gated to localhost/private hosts (same rule as the spatial
 * runtime tier); public hosts are refused unless allow_public is passed.
 */
async function wsScreenshot(args: Record<string, unknown>): Promise<BridgeToolResult> {
  const rawUrl = String(args?.url ?? '').trim();
  if (!rawUrl) {
    return textOut('url is required — the full origin of the local dev server, e.g. "http://localhost:5173/".', true);
  }
  let url: URL;
  try {
    url = assertAllowedTarget(rawUrl, args?.allow_public === true);
  } catch (error) {
    return textOut(error instanceof Error ? error.message : String(error), true);
  }

  const pw = await loadPlaywright().catch(() => null);
  if (!pw) {
    return textOut('playwright-core is not installed — run: pnpm add -D playwright-core (the headless browser needs it).', true);
  }

  const viewport = {
    width: Math.min(Math.max(Number(args?.viewport_w ?? 1440) || 1440, 200), 3840),
    height: Math.min(Math.max(Number(args?.viewport_h ?? 900) || 900, 200), 2160),
  };
  const fullPage = args?.full_page === true;
  const selector = typeof args?.selector === 'string' ? args.selector.trim() : '';
  const waitMs = Math.min(Math.max(Number(args?.wait_ms ?? 1200) || 1200, 0), 15_000);

  let browser: import('playwright-core').Browser | null = null;
  try {
    try {
      browser = await pw.chromium.launch({ headless: true, channel: 'msedge' });
    } catch {
      browser = await pw.chromium.launch({ headless: true });
    }
    const page = await browser.newPage({ viewport });
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: 20_000 });
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 4_000 });
    } catch { /* best effort */ }
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    const buffer = selector
      ? await page.locator(selector).screenshot({ type: 'png', timeout: 10_000 })
      : await page.screenshot({ fullPage, type: 'png' });
    const label = selector ? `element "${selector}"` : fullPage ? 'full page' : 'viewport';
    return imageOut(
      `Screenshot captured — ${label} of ${url.toString()} (${viewport.width}×${viewport.height}${fullPage ? ', full page' : ''}). The PNG rides inline — inspect the rendered UI.`,
      `data:image/png;base64,${buffer.toString('base64')}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textOut(
      `ws_screenshot failed for ${url.toString()}: ${message}. Is the dev server running on that port?`,
      true,
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Read-only workspace tools                                           */
/* ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  'coverage', '.venv', '__pycache__', '.turbo',
]);
const MAX_TREE_ENTRIES = 500;
const MAX_READ_CHARS = 200_000;
const MAX_SEARCH_FILE_BYTES = 512_000;
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
  '.gz', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.exe', '.dll',
]);

function insideRoot(absolute: string, root: string): boolean {
  const rel = path.relative(root, absolute);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function activeRoot(): { root: string } | { error: string } {
  try {
    const root = resolveWorkspaceRoot();
    if (!root) {
      return { error: 'No workspace bound to the MCP bridge — pick one in Settings → MCP → MCP Bridge (or set Moriko\'s active workspace).' };
    }
    return { root };
  } catch {
    return { error: 'No workspace bound to the MCP bridge.' };
  }
}

function wsTree(args: Record<string, unknown>): BridgeToolResult {
  const got = activeRoot();
  if ('error' in got) return textOut(got.error, true);
  const maxDepth = Math.min(Math.max(Number(args?.depth ?? 3) || 3, 1), 6);

  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
        .map((e) => e.name)
        .sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (count >= MAX_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      lines.push(`${'  '.repeat(depth)}${isDir ? name + '/' : name}`);
      count++;
      if (isDir) walk(abs, depth + 1);
    }
  };

  walk(got.root, 0);
  const head = `Workspace tree (${got.root}) — depth ${maxDepth}:`;
  return textOut(truncated
    ? `${head}\n${lines.join('\n')}\n…(truncated at ${MAX_TREE_ENTRIES} entries)`
    : `${head}\n${lines.join('\n')}`);
}

function wsRead(args: Record<string, unknown>): BridgeToolResult {
  const got = activeRoot();
  if ('error' in got) return textOut(got.error, true);
  const rel = String(args?.path ?? '').trim();
  if (!rel) return textOut('path is required.', true);
  const abs = path.resolve(got.root, rel);
  if (!insideRoot(abs, got.root)) {
    return textOut(`Path "${rel}" escapes the active workspace — read-only access is jailed to it.`, true);
  }
  try {
    if (!statSync(abs).isFile()) return textOut(`"${rel}" is not a file.`, true);
  } catch {
    return textOut(`File not found: ${rel}`, true);
  }
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return textOut(`Cannot read "${rel}" as text (binary or unreadable).`, true);
  }
  if (content.length > MAX_READ_CHARS) content = `${content.slice(0, MAX_READ_CHARS)}\n…(truncated at ${MAX_READ_CHARS} chars)`;
  const allLines = content.split('\n');
  const total = allLines.length;

  // mode: "outline" — line-numbered symbol map (same engine as ws_outline).
  if (args?.mode === 'outline') {
    const lines = outlineLines(rel, content);
    return textOut(`${rel} — outline (${lines.length} anchors):\n${lines.join('\n') || '(no structural lines found)'}`);
  }

  const showWs = args?.show_whitespace === true;
  const render = (t: string): string =>
    showWs ? t.replace(/\t/g, '⟶').replace(/ +$/, (m) => '·'.repeat(m.length)) : t;

  // line: N — read one full line by number.
  const one = Math.floor(Number(args?.line ?? 0) || 0);
  if (one >= 1) {
    if (one > total) return textOut(`line ${one} is beyond EOF (${total} lines).`, true);
    return textOut(`${rel}:${one}: ${render(allLines[one - 1])}`);
  }

  // ranges: [[from,to],…] — disjoint regions, max 6, 2000 lines total.
  if (Array.isArray(args?.ranges)) {
    const list = (args.ranges as unknown[]).slice(0, 6);
    let budget = 2000;
    const blocks: string[] = [];
    for (const r of list) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const from = Math.max(Math.floor(Number(r[0]) || 1), 1);
      const to = Math.min(Math.floor(Number(r[1]) || from), total);
      const span = Math.min(to - from + 1, budget);
      if (span <= 0) continue;
      budget -= span;
      blocks.push(
        `# ${rel} — lines ${from}–${from + span - 1} of ${total}\n${allLines
          .slice(from - 1, from - 1 + span)
          .map((l, i) => `${from + i}| ${render(l)}`)
          .join('\n')}`,
      );
      if (budget <= 0) break;
    }
    if (blocks.length === 0) return textOut('No valid ranges — expected [[from,to],…] (max 6, 2000 lines total).', true);
    return textOut(blocks.join('\n\n'));
  }

  const offset = Math.max(Number(args?.offset_line ?? 1) || 1, 1);
  const maxLines = Math.min(Math.max(Number(args?.max_lines ?? 400) || 400, 1), 1000);
  const slice = allLines.slice(offset - 1, offset - 1 + maxLines);
  const header = `${rel} — lines ${offset}–${offset - 1 + slice.length} of ${total}`;
  return textOut(`${header}\n${slice.map((l, i) => `${offset + i}| ${render(l)}`).join('\n')}`);
}

/** Line-numbered structural anchors of one file — shared by ws_outline and read mode "outline". */
function outlineLines(rel: string, content: string): string[] {
  const lines: string[] = [];
  const isCode = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.css', '.py', '.go', '.rs'].includes(path.extname(rel).toLowerCase());
  content.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (isCode) {
      // Declarations/exports + CSS selectors + comment banners with line numbers.
      if (
        /^(export (default |async |const |function |class |interface |type |enum )|(async )?function |class |def |fn |func |interface |type |enum |@media|@keyframes)/.test(trimmed) ||
        /^\.[a-zA-Z][\w-]*\s*[{,]/.test(trimmed) ||
        /^(\/\*\*|\/\/ ={3,}|\/\* ={3,})/.test(trimmed)
      ) {
        lines.push(`${idx + 1}: ${trimmed.slice(0, 150)}`);
      }
    } else if (/^(#{1,6} |[-*] \[|\|)/.test(trimmed)) {
      // Prose/markup: markdown headings + doc keys.
      lines.push(`${idx + 1}: ${trimmed.slice(0, 150)}`);
    }
  });
  return lines;
}

/** Resolve a subpath scope inside the workspace root (harness parity). */
function scopeRoot(root: string, subpath: unknown): { dir: string; error?: string } {
  const rel = typeof subpath === 'string' ? subpath.trim().replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '') : '';
  if (!rel) return { dir: root };
  const abs = path.resolve(root, rel);
  if (abs !== root && !insideRoot(abs, root)) return { dir: root, error: `subpath "${rel}" escapes the bound workspace.` };
  return { dir: abs };
}

interface GrepHit {
  rel: string;
  lineNo: number;
  text: string;
  before: string[];
  after: string[];
}

/**
 * ws_grep — harness grep parity: pattern/patterns (OR), subpath scope,
 * glob/globs filename filter, case_sensitive, whole_lines, context lines,
 * sort path|density. Output: "path:line: text".
 */
function wsGrep(args: Record<string, unknown>): BridgeToolResult {
  const got = activeRoot();
  if ('error' in got) return textOut(got.error, true);

  const rawList: string[] =
    Array.isArray(args?.patterns) && args.patterns.length
      ? (args.patterns as unknown[]).map((p) => String(p).trim()).filter(Boolean)
      : [String(args?.pattern ?? args?.query ?? '').trim()].filter(Boolean);
  if (rawList.length === 0) return textOut('pattern is required (regex; falls back to literal when invalid).', true);

  const flags = args?.case_sensitive === true ? '' : 'i';
  const whole = args?.whole_lines === true;
  const patterns: RegExp[] = rawList.map((raw) => {
    let re: RegExp;
    try {
      re = new RegExp(raw, flags);
    } catch {
      re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
    return whole ? new RegExp(`^(?:${re.source})$`, re.flags) : re;
  });

  const scope = scopeRoot(got.root, args?.subpath);
  if (scope.error) return textOut(scope.error, true);

  const globs = [
    ...(typeof args?.glob === 'string' && args.glob.trim() ? [args.glob.trim()] : []),
    ...(Array.isArray(args?.globs) ? (args.globs as unknown[]).map((g) => String(g).trim()).filter(Boolean) : []),
  ];
  const globRes = globs.map((g) => globToRegExp(g));

  const maxResults = Math.min(Math.max(Number(args?.max_results ?? 100) || 100, 1), 100);
  const context = Math.min(Math.max(Number(args?.context ?? 0) || 0, 0), 10);
  const sort = args?.sort === 'density' ? 'density' : 'path';

  const hits: GrepHit[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > 8) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
        .map((e) => e.name)
        .sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (truncated) return;
      const abs = path.join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(abs, depth + 1);
        continue;
      }
      if (BINARY_EXT.has(path.extname(name).toLowerCase())) continue;
      if (globRes.length > 0) {
        const relPath = path.relative(got.root, abs).replace(/\\/g, '/');
        if (!globRes.some((re) => re.test(name) || re.test(relPath))) continue;
      }
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
      scanned++;
      let content: string;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(got.root, abs).replace(/\\/g, '/');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!patterns.some((re) => re.test(lines[i]))) continue;
        hits.push({
          rel,
          lineNo: i + 1,
          text: lines[i].slice(0, 300),
          before: context > 0 ? lines.slice(Math.max(0, i - context), i).map((l) => l.slice(0, 300)) : [],
          after: context > 0 ? lines.slice(i + 1, i + 1 + context).map((l) => l.slice(0, 300)) : [],
        });
        if (hits.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    }
  };

  walk(scope.dir, 0);
  if (hits.length === 0) {
    return textOut(`No matches for ${rawList.map((p) => `/${p}/`).join(' or ')} (${scanned} files scanned).`);
  }

  let ordered = hits;
  if (sort === 'density') {
    const perFile = new Map<string, number>();
    for (const h of hits) perFile.set(h.rel, (perFile.get(h.rel) ?? 0) + 1);
    ordered = [...hits].sort((a, b) => (perFile.get(b.rel) ?? 0) - (perFile.get(a.rel) ?? 0));
  }

  const blocks = ordered.map((h) =>
    [
      ...h.before.map((l, i) => `  ${h.lineNo - h.before.length + i}| ${l.trim()}`),
      `${h.rel}:${h.lineNo}: ${h.text.trim()}`,
      ...h.after.map((l, i) => `  ${h.lineNo + 1 + i}| ${l.trim()}`),
    ].join('\n'),
  );
  const scopeLabel = scope.dir === got.root ? 'workspace root' : path.relative(got.root, scope.dir).replace(/\\/g, '/');
  const body = truncated ? `${blocks.join('\n')}\n…(truncated at ${maxResults} results)` : blocks.join('\n');
  return textOut(`${hits.length} match(es) for ${rawList.map((p) => `/${p}/`).join(' | ')} in ${scopeLabel}:\n${body}`);
}

/**
 * Mini-glob → RegExp: ** crosses directories, * stays in one segment,
 * ? matches one char, {a,b} alternates. Everything else is escaped.
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // **/ also swallows its slash
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
    } else if (c === '}') {
      re += ')';
    } else if (c === ',') {
      re += '|';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function wsGlob(args: Record<string, unknown>): BridgeToolResult {
  const got = activeRoot();
  if ('error' in got) return textOut(got.error, true);
  const patternList: string[] =
    Array.isArray(args?.patterns) && args.patterns.length
      ? (args.patterns as unknown[]).map((p) => String(p).trim()).filter(Boolean)
      : [String(args?.pattern ?? '').trim()].filter(Boolean);
  if (patternList.length === 0) {
    return textOut('pattern is required, e.g. "src/**/*.ts" or "**/*routes*.{ts,tsx}".', true);
  }
  const regexes = patternList.map((p) => globToRegExp(p));
  const scope = scopeRoot(got.root, args?.subpath);
  if (scope.error) return textOut(scope.error, true);
  const sort = args?.sort === 'modified' ? 'modified' : 'name';
  const maxResults = Math.min(Math.max(Number(args?.max_results ?? 200) || 200, 1), 1000);

  const matches: Array<{ rel: string; mtime: number }> = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > 12) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
        .map((e) => e.name)
        .sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = path.join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(abs, depth + 1);
        continue;
      }
      const rel = path.relative(got.root, abs).replace(/\\/g, '/');
      scanned++;
      if (!regexes.some((re) => re.test(rel))) continue;
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
      let mtime = 0;
      try {
        mtime = statSync(abs).mtimeMs;
      } catch { /* keep 0 */ }
      matches.push({ rel, mtime });
    }
  };

  walk(scope.dir, 0);
  if (matches.length === 0) {
    return textOut(`No files match ${patternList.map((p) => `"${p}"`).join(' or ')} (${scanned} files scanned).`);
  }
  const ordered = sort === 'modified'
    ? [...matches].sort((a, b) => b.mtime - a.mtime)
    : matches;
  const body = truncated
    ? `${ordered.map((m) => m.rel).join('\n')}\n…(truncated at ${maxResults} results)`
    : ordered.map((m) => m.rel).join('\n');
  return textOut(`${matches.length} file(s) match ${patternList.map((p) => `"${p}"`).join(' | ')}:\n${body}`);
}

/**
 * ws_outline — symbol map of ONE file so external orchestrators can jump to
 * exact line numbers before calling ws_read_file. TS/JS: heading/def line scan;
 * other text files: headings + declarations.
 */
function wsOutline(args: Record<string, unknown>): BridgeToolResult {
  const got = activeRoot();
  if ('error' in got) return textOut(got.error, true);
  const rel = String(args?.path ?? '').trim();
  if (!rel) return textOut('path is required.', true);
  const abs = path.resolve(got.root, rel);
  if (!insideRoot(abs, got.root)) {
    return textOut(`Path "${rel}" escapes the bound workspace — read-only access is jailed to it.`, true);
  }
  let content: string;
  try {
    if (!statSync(abs).isFile()) return textOut(`"${rel}" is not a file.`, true);
    content = readFileSync(abs, 'utf8');
  } catch {
    return textOut(`File not found: ${rel}`, true);
  }
  if (content.length > MAX_READ_CHARS) content = content.slice(0, MAX_READ_CHARS);

  const lines = outlineLines(rel, content);
  const header = `${rel} — outline (${lines.length} anchors, line-numbered):`;
  return textOut(`${header}\n${lines.join('\n') || '(no structural lines found — file may be plain prose)'}`);
}

function bridgeInfo(): BridgeToolResult {
  const sessionId = resolveMainSessionId();
  let root = '(none)';
  try {
    root = resolveWorkspaceRoot() ?? root;
  } catch { /* keep default */ }
  const tools = bridgeToolDefs();
  const council = tools.filter((t) => t.name.startsWith('council_')).map((t) => t.name);
  const rsat = tools.filter((t) => t.name.startsWith('rsat_')).map((t) => t.name);
  return textOut([
    `Moriko MCP bridge — external orchestrator access.`,
    `Actor binding: council Main Session (orchestrator) = ${sessionId ?? 'NOT FOUND — open a council first'}`,
    `Active workspace: ${root}`,
    `Council tools (${council.length}): ${council.join(', ')}`,
    `RSAT tools (${rsat.length}): ${rsat.join(', ')}`,
    `Workspace tools (read-only): moriko_ws_tree, moriko_ws_glob, moriko_ws_outline, moriko_ws_read_file, moriko_ws_grep, moriko_ws_screenshot, moriko_bridge_info`,
  ].join('\n'));
}

/* ------------------------------------------------------------------ */
/* Tool catalogue + dispatch                                           */
/* ------------------------------------------------------------------ */

export interface BridgeToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export function bridgeToolDefs(): BridgeToolDef[] {
  const tools: BridgeToolDef[] = listAddonToolDefs().map((d) => ({
    name: d.wireName.replace(/^agent__/, ''),
    description: d.description,
    inputSchema: d.inputSchema,
    annotations: { readOnlyHint: addonToolReadOnly(d.wireName) === true },
  }));
  // HARNESS-NATIVE read + edit tools — projected straight from the harness
  // catalogue (single source of truth) so schemas never drift. External calls
  // execute through the REAL dispatcher with the bound Main Session context:
  // read-before-edit receipts, vault snapshots, spatial gates all apply.
  tools.push(...bridgeHarnessToolDefs(listAgentToolDefs()));
  tools.push(
    {
      name: 'moriko_ws_tree',
      description:
        'Moriko workspace: list files/dirs under the ACTIVE workspace root (read-only). Heavy dirs (node_modules, .git, dist, …) are skipped.',
      inputSchema: {
        type: 'object',
        properties: { depth: { type: 'number', description: 'Recursion depth (default 3, max 6).' } },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'moriko_ws_read_file',
      description:
        'Moriko workspace: read a text file from the BOUND workspace root (read-only, path-jailed). Harness read_file parity: offset_line/max_lines, one full line, disjoint ranges, mode "outline", show_whitespace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          offset_line: { type: 'number', description: '1-based first line (default 1).' },
          max_lines: { type: 'number', description: 'Max lines to return (default 400, max 1000).' },
          line: { type: 'number', description: 'Read ONE full line by number.' },
          ranges: {
            type: 'array',
            description: 'Disjoint regions [[from,to],…] (max 6, 2000 lines total).',
            items: { type: 'array', items: { type: 'number' } },
          },
          mode: { type: 'string', enum: ['window', 'outline'], description: 'window (default) or outline — line-numbered symbol map.' },
          show_whitespace: { type: 'boolean', description: 'Expose tabs (⟶) and trailing spaces (·).' },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'moriko_ws_glob',
      description:
        'Moriko workspace: find FILES by glob pattern(s) — harness glob parity: patterns[] (OR), subpath scope, sort name|modified (read-only). Use before ws_read_file/ws_outline to locate exact paths.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob: ** crosses dirs, * one segment, ? one char, {a,b} alternation.' },
          patterns: { type: 'array', items: { type: 'string' }, description: 'Multiple patterns (OR).' },
          subpath: { type: 'string', description: 'Scope directory (default workspace root).' },
          sort: { type: 'string', enum: ['name', 'modified'], description: 'Sort key (default name).' },
          max_results: { type: 'number', description: 'Max paths (default 200, max 1000).' },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'moriko_ws_outline',
      description:
        'Moriko workspace: structural outline of ONE file — declarations/headings with LINE NUMBERS (read-only). Use it to target ws_read_file offset_line instead of reading blindly.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'moriko_ws_grep',
      description:
        'Moriko workspace: regex content search — harness grep parity: pattern/patterns (OR), subpath scope, glob/globs filename filter, case_sensitive, whole_lines, context lines, sort path|density. Output "path:line: text".',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex (falls back to literal when invalid).' },
          patterns: { type: 'array', items: { type: 'string' }, description: 'Multiple patterns in one walk (OR).' },
          subpath: { type: 'string', description: 'Scope directory (default workspace root).' },
          glob: { type: 'string', description: 'Filename filter, e.g. "*.ts".' },
          globs: { type: 'array', items: { type: 'string' }, description: 'Multiple filename globs (OR).' },
          case_sensitive: { type: 'boolean', description: 'Default false.' },
          context: { type: 'number', description: 'Context lines 0-10 around each hit (default 0).' },
          whole_lines: { type: 'boolean', description: 'Match only lines whose full content matches.' },
          sort: { type: 'string', enum: ['path', 'density'], description: 'path (default) or density — files with most hits first.' },
          max_results: { type: 'number', description: 'Cap (default 100, max 100).' },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'moriko_ws_screenshot',
      description:
        'Moriko workspace: SCREENSHOT a local dev server (e.g. the UI a sub agent is building on localhost) — returns an INLINE PNG you can SEE. Targets are gated to localhost/private hosts; full-page or element capture, custom viewport. Read-only observation.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full origin of the local server, e.g. "http://localhost:5173/".' },
          selector: { type: 'string', description: 'Optional CSS selector — capture just that element.' },
          full_page: { type: 'boolean', description: 'Capture the whole scrollable page (default viewport only).' },
          viewport_w: { type: 'number', description: 'Viewport width px (default 1440).' },
          viewport_h: { type: 'number', description: 'Viewport height px (default 900).' },
          wait_ms: { type: 'number', description: 'Extra settle wait after load (default 1200, max 15000).' },
          allow_public: { type: 'boolean', description: 'Allow PUBLIC hosts — off by default; bridge is meant for local dev servers.' },
        },
        required: ['url'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'moriko_bridge_info',
      description:
        'Moriko bridge status: the bound Main Session (orchestrator actor), active workspace path, and every exposed tool.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  );
  return tools;
}

/** Executes one bridge tool call as the council Main Session orchestrator. */
export async function callBridgeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<BridgeToolResult> {
  try {
    switch (name) {
      case 'moriko_ws_tree': return wsTree(args);
      case 'moriko_ws_screenshot': return wsScreenshot(args);
      case 'moriko_ws_glob': return wsGlob(args);
      case 'moriko_ws_outline': return wsOutline(args);
      case 'moriko_ws_read_file': return wsRead(args);
      case 'moriko_ws_grep':
      case 'moriko_ws_search': // legacy alias — renamed to ws_grep
        return wsGrep(args);
      case 'moriko_bridge_info': return bridgeInfo();
      default: break;
    }

    const wire = name.startsWith('agent__') ? name : `agent__${name}`;

    // HARNESS-NATIVE read + edit tools — run through the REAL dispatcher with
    // a synthetic context bound to the Main Session, so every enforcement
    // layer (read-before-edit receipts, vault, spatial gates, workspace jail)
    // applies to external callers exactly as it does in-chat. Web access is
    // forced OFF: the bridge never grants browser/fetch capabilities.
    if (isBridgeExposedTool(name)) {
      const sessionId = resolveMainSessionId();
      if (!sessionId) {
        return textOut('No Main Session bound — pick one in Settings → MCP → MCP Bridge (or open a council in Moriko).', true);
      }
      const result = await callAgentTool(wire, args ?? {}, {
        sessionId,
        // Handlers resolve the workspace from the session itself
        // (getActiveWorkspace(sessionId)) — no separate field needed.
        webAccess: false,
        // Terminal mode off + delete confirmation on: external clients have
        // no approval UI, so risky ops stay disabled regardless of settings.
        terminalMode: 'off',
        confirmDeletes: true,
      });
      if (result.images && result.images.length > 0) {
        return imageOut(result.text, result.images[0].dataUrl);
      }
      return textOut(result.text, result.isError);
    }

    let handler = getAddonToolHandler(wire);
    if (!handler) {
      const suffix = `_${name}`;
      const def = listAddonToolDefs().find((d) => d.wireName.endsWith(suffix) || d.wireName === name);
      handler = def ? getAddonToolHandler(def.wireName) : undefined;
    }
    if (!handler) {
      return textOut(`Unknown tool "${name}" — use tools/list to see the catalogue.`, true);
    }

    const sessionId = resolveMainSessionId();
    if (!sessionId) {
      return textOut('No Main Session bound — pick one in Settings → MCP → MCP Bridge (or open a council in Moriko).', true);
    }
    let workspacePath: string | undefined;
    try {
      workspacePath = resolveWorkspaceRoot() ?? undefined;
    } catch {
      workspacePath = undefined;
    }

    const result = (await handler(args ?? {}, { sessionId, workspacePath })) as
      | { text?: string; isError?: boolean }
      | null;
    return textOut(result?.text ?? '(empty result)', result?.isError === true);
  } catch (error) {
    return textOut(error instanceof Error ? error.message : String(error), true);
  }
}
