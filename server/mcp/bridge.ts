

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
import { acquireEphemeralContext } from '../agents/browser/engine.js';
import { listStoredConversationSummaries } from '../conversationStore.js';
import { callAgentTool } from '../agents/tools/dispatcher.js';
import { listAgentToolDefs } from '../agents/tools/catalogue.js';
import { compilePattern, globToRegExp } from '../agents/tools/shared.js';
import { bridgeHarnessToolDefs, isBridgeExposedTool } from './bridgePolicy.js';

const TOKEN_FILE = path.join(morikoHome, 'mcp-bridge.json');

interface BridgeConfig {
  version: 1;
  token: string;
  createdAt: string;
  
  sessionId?: string;
  
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


export function bridgeToken(): string {
  return loadConfig().token;
}


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
  
  sessionId: string;
  
  workspaceId: string;
  
  sessions: Array<{ id: string; title: string; councilRole?: string }>;
  
  workspaces: Array<{ id: string; label: string; path: string }>;
  
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


export function resolveWorkspaceRoot(): string | null {
  const config = loadConfig();
  const chosenId = String(config.workspaceId ?? '').trim();
  if (chosenId) {
    try {
      const found = listWorkspaces().find((w) => w.id === chosenId);
      if (found?.path) return found.path;
    } catch {
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


function imageOut(text: string, dataUrl: string): BridgeToolResult {
  const commaIdx = dataUrl.indexOf(',');
  const header = commaIdx >= 0 ? dataUrl.slice(0, commaIdx) : '';
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'image/png';
  const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return { content: [{ type: 'text', text }, { type: 'image', data, mimeType: mime }], isError: false };
}


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

  let context: import('playwright-core').BrowserContext | null = null;
  let page: import('playwright-core').Page | null = null;
  try {
    context = await acquireEphemeralContext({ viewport });
    page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: 20_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(waitMs > 0 ? waitMs : 150);

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
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
  }
}


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

  if (args?.mode === 'outline') {
    const lines = outlineLines(rel, content);
    return textOut(`${rel} — outline (${lines.length} anchors):\n${lines.join('\n') || '(no structural lines found)'}`);
  }

  const showWs = args?.show_whitespace === true;
  const render = (t: string): string =>
    showWs ? t.replace(/\t/g, '⟶').replace(/ +$/, (m) => '·'.repeat(m.length)) : t;

  const one = Math.floor(Number(args?.line ?? 0) || 0);
  if (one >= 1) {
    if (one > total) return textOut(`line ${one} is beyond EOF (${total} lines).`, true);
    return textOut(`${rel}:${one}: ${render(allLines[one - 1])}`);
  }

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


function outlineLines(rel: string, content: string): string[] {
  const lines: string[] = [];
  const isCode = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.css', '.py', '.go', '.rs'].includes(path.extname(rel).toLowerCase());
  content.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (isCode) {
      if (
        /^(export (default |async |const |function |class |interface |type |enum )|(async )?function |class |def |fn |func |interface |type |enum |@media|@keyframes)/.test(trimmed) ||
        /^\.[a-zA-Z][\w-]*\s*[{,]/.test(trimmed) ||
        /^(\/\*\*|\/\/ ={3,}|\/\* ={3,})/.test(trimmed)
      ) {
        lines.push(`${idx + 1}: ${trimmed.slice(0, 150)}`);
      }
    } else if (/^(#{1,6} |[-*] \[|\|)/.test(trimmed)) {
      lines.push(`${idx + 1}: ${trimmed.slice(0, 150)}`);
    }
  });
  return lines;
}


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


function wsGrep(args: Record<string, unknown>): BridgeToolResult {
  const got = activeRoot();
  if ('error' in got) return textOut(got.error, true);

  const rawList: string[] =
    Array.isArray(args?.patterns) && args.patterns.length
      ? (args.patterns as unknown[]).map((p) => String(p).trim()).filter(Boolean)
      : [String(args?.pattern ?? args?.query ?? '').trim()].filter(Boolean);
  if (rawList.length === 0) return textOut('pattern is required — a regular expression, e.g. "export function \\\\w+".', true);

  const caseSensitive = args?.case_sensitive === true;
  const whole = args?.whole_lines === true;
  const patterns: RegExp[] = [];
  for (const raw of rawList) {
    try {
      const re = compilePattern(raw, caseSensitive);
      patterns.push(whole ? new RegExp(`^(?:${re.source})$`, re.flags) : re);
    } catch (err) {
      return textOut(`Invalid pattern /${raw}/: ${err instanceof Error ? err.message : 'compile failed'}.`, true);
    }
  }

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
      } catch {  }
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
  } catch {  }
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
      case 'moriko_ws_search':
        return wsGrep(args);
      case 'moriko_bridge_info': return bridgeInfo();
      default: break;
    }

    const wire = name.startsWith('agent__') ? name : `agent__${name}`;

    if (isBridgeExposedTool(name)) {
      const sessionId = resolveMainSessionId();
      if (!sessionId) {
        return textOut('No Main Session bound — pick one in Settings → MCP → MCP Bridge (or open a council in Moriko).', true);
      }
      const result = await callAgentTool(wire, args ?? {}, {
        sessionId,
        webAccess: false,
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
