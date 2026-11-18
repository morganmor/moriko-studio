
import fs from 'node:fs';
import path from 'node:path';
import {
  type SpatialMap,
  type SpatialRegion,
  type SpatialRect,
  type SpatialConstraint,
} from './spatial.js';
import { getActiveWorkspace } from './workspace.js';
import { acquireEphemeralContext, getSharedBrowser, loadPlaywright } from './browser/engine.js';

export { loadPlaywright };

export const SWIFT_SHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const activeProbeContexts = new Set<import('playwright-core').BrowserContext>();

export async function getReusableBrowser(_args: string[] = SWIFT_SHADER_ARGS): Promise<import('playwright-core').Browser> {
  return getSharedBrowser();
}

export async function killProbeBrowser(): Promise<void> {
  const targets = [...activeProbeContexts];
  activeProbeContexts.clear();
  await Promise.all(targets.map((c) => c.close().catch(() => undefined)));
}


function spatialDataDir(): string | null {
  const root = getActiveWorkspace()?.path;
  return root ? path.join(root, '.moriko-dat', 'spatial') : null;
}
const BASELINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function baselineSlug(target: string): string {
  const safe = target
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return safe.slice(0, 120) || 'target';
}

export function baselinePaths(target: string): { json: string; png: string } | null {
  const dir = spatialDataDir();
  if (!dir) return null;
  const base = path.join(dir, `${baselineSlug(target)}`);
  return { json: `${base}.json`, png: `${base}.png` };
}

export function readBaseline(target: string): SpatialMap | null {
  const paths = baselinePaths(target);
  if (!paths) return null;
  try {
    const raw = fs.readFileSync(paths.json, 'utf-8');
    const parsed = JSON.parse(raw) as SpatialMap;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.regions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeBaseline(target: string, map: SpatialMap): void {
  try {
    const paths = baselinePaths(target);
    if (!paths) return;
    fs.mkdirSync(path.dirname(paths.json), { recursive: true });
    fs.writeFileSync(paths.json, JSON.stringify(map, null, 2), 'utf-8');
  } catch {
  }
}


export function sweepBaselines(): number {
  try {
    const dir = spatialDataDir();
    if (!dir || !fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - BASELINE_MAX_AGE_MS;
    let removed = 0;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (!entry.endsWith('.json')) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          const png = full.replace(/\.json$/, '.png');
          if (fs.existsSync(png)) fs.rmSync(png, { force: true });
          removed += 1;
        }
      } catch {
      }
    }
    return removed;
  } catch {
    return 0;
  }
}


const PUBLIC_HOSTNAME_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function isPublicTarget(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return PUBLIC_HOSTNAME_RE.test(host);
}

export function assertAllowedTarget(raw: string, allowPublic: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL. Pass the full origin, e.g. http://localhost:5173/`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) targets are supported (got "${url.protocol}").`);
  }
  if (!allowPublic && isPublicTarget(url)) {
    throw new Error(
      `Refusing to open a PUBLIC host ("${url.hostname}") without allowPublic: true — ` +
      'the gate is designed for local dev servers. Pass allowPublic: true to allow this once.',
    );
  }
  return url;
}


const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const RUNTIME_LOAD_TIMEOUT_MS = 10_000;

const RUNTIME_DEADLINE_MS = 60_000;
const MAX_RUNTIME_REGIONS = 400;


const EXTRACT_SCRIPT = `
(() => {
  const isVisual = (el) => {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  };
  const regionName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const ref = document.getElementById(labelled);
      if (ref && ref.textContent) return ref.textContent.trim().slice(0, 60);
    }
    if (el.id) return el.id.trim();
    const role = el.getAttribute('role');
    if (role) return role.trim();
    return '';
  };
  const overlapFraction = (a, b) => {
    const x1 = Math.max(a.left, b.left);
    const y1 = Math.max(a.top, b.top);
    const x2 = Math.min(a.right, b.right);
    const y2 = Math.min(a.bottom, b.bottom);
    if (x2 <= x1 || y2 <= y1) return 0;
    const inter = (x2 - x1) * (y2 - y1);
    const smaller = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
    return smaller > 0 ? inter / smaller : 0;
  };
  const all = Array.from(document.body.querySelectorAll('*'));
  const cands = [];
  for (const el of all) {
    const st = window.getComputedStyle(el);
    const pos = st.position;
    const interactive = el.matches('button, a, input, select, textarea, [role], [contenteditable]');
    const named = !!(el.getAttribute('aria-label') || el.id || el.getAttribute('role') || el.getAttribute('aria-labelledby'));
    const layoutRelevant = pos === 'absolute' || pos === 'fixed' || pos === 'sticky';
    // The IR is for LAYOUT geometry, not a DOM dump: anonymous in-flow
    // wrappers (scrolling transcripts, spacer divs) are noise. Keep what
    // is positioned, interactive, or carries an accessible name.
    if (!layoutRelevant && !interactive && !named) continue;
    if (!isVisual(el)) continue;
    const r = el.getBoundingClientRect();
    cands.push({
      el,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      pos,
      zIndex: Number.isFinite(Number(st.zIndex)) ? Number(st.zIndex) : null,
      named,
    });
  }
  // rank: named regions first (they are what reports can reference), then by
  // area — so a named control wins a rect-dedupe against an anonymous wrapper
  const byArea = cands.sort((a, b) => (Number(b.named) - Number(a.named)) || (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h));
  const picked = [];
  for (const c of byArea) {
    const dup = picked.some((p) =>
      Math.abs(p.rect.x - c.rect.x) < 2 && Math.abs(p.rect.y - c.rect.y) < 2 &&
      Math.abs(p.rect.w - c.rect.w) < 2 && Math.abs(p.rect.h - c.rect.h) < 2);
    if (!dup) picked.push(c);
    if (picked.length >= ${MAX_RUNTIME_REGIONS}) break;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const regions = picked.map((c) => {
    const el = c.el;
    const r = c.rect;
    const off = r.x < -4 || r.y < -4 || r.x + r.w > vw + 4 || r.y + r.h > vh + 4;
    return {
      id: regionName(el) || el.tagName.toLowerCase(),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      rect: r,
      constraint: c.pos === 'sticky' ? 'flow' : c.pos === 'static' ? 'flow' : c.pos,
      zIndex: Number.isFinite(Number(c.zIndex)) ? Number(c.zIndex) : null,
      overlay: /modal|dialog|tooltip|popover|menu|overlay|toast|drawer/i.test(el.getAttribute('role') || ''),
      offscreen: off,
      interactive: el.matches('button, a, input, select, textarea, [contenteditable]'),
    };
  });
  const hard = [];
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j];
      if (a.id === b.id) continue;
      const f = overlapFraction(a.rect, b.rect);
      if (f >= 0.125) hard.push({ a: a.id, b: b.id });
    }
  }
  const seen = new Set();
  const collisions = [];
  for (const c of hard) {
    const key = c.a + '|' + c.b;
    if (seen.has(key)) continue;
    seen.add(key);
    const aR = regions.find((r) => r.id === c.a);
    const bR = regions.find((r) => r.id === c.b);
    if (!aR || !bR) continue;
    const x1 = Math.max(aR.rect.x, bR.rect.x);
    const y1 = Math.max(aR.rect.y, bR.rect.y);
    const x2 = Math.min(aR.rect.x + aR.rect.w, bR.rect.x + bR.rect.w);
    const y2 = Math.min(aR.rect.y + aR.rect.h, bR.rect.y + bR.rect.h);
    collisions.push({
      a: c.a, b: c.b,
      overlap: { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) },
      severity: 'hard',
    });
  }
  return { viewport: { w: vw, h: vh }, regions, collisions };
})();
`;

export interface RuntimeCaptureResult {
  url: string;
  map: SpatialMap;
  screenshot: string | null;
  notes: string[];
}


export async function captureRuntime(
  rawUrl: string,
  opts: { allowPublic?: boolean; viewport?: { w: number; h: number }; saveScreenshot?: boolean; saveBaseline?: boolean } = {},
): Promise<RuntimeCaptureResult> {
  const url = assertAllowedTarget(rawUrl, opts.allowPublic === true);
  const notes: string[] = [];
  const pw = await loadPlaywright();
  if (!pw) {
    throw new Error(
      'playwright-core is not installed. Run: pnpm add -D playwright-core — ' +
      'then the runtime tier can measure real browser geometry (F4).',
    );
  }

  const viewport = {
    width: Math.min(Math.max(opts.viewport?.w ?? DEFAULT_VIEWPORT.width, 200), 3840),
    height: Math.min(Math.max(opts.viewport?.h ?? DEFAULT_VIEWPORT.height, 200), 2160),
  };

  let context: import('playwright-core').BrowserContext | null = null;
  const deadline = setTimeout(() => { void context?.close().catch(() => undefined); }, RUNTIME_DEADLINE_MS);
  deadline.unref?.();

  try {
    context = await acquireEphemeralContext({ viewport });
    activeProbeContexts.add(context);
  } catch (error) {
    clearTimeout(deadline);
    throw new Error(
      'Could not launch a headless browser (tried channel "msedge", then "chromium"). Install Microsoft Edge or run ' +
      '"npx playwright install chromium" once (downloads ~150 MB). ' +
      `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let page: import('playwright-core').Page | null = null;
  try {
    page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: RUNTIME_LOAD_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: RUNTIME_LOAD_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(150);
    try {
      await page.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- page scripts run in the DOM context, not Node
        (() => ((globalThis as any).document?.body?.innerText.trim().length ?? 0) > 0) as unknown as () => boolean,
        undefined,
        { timeout: 8_000 },
      );
    } catch {
    }
    await page.waitForTimeout(300);

    const extracted = (await page.evaluate(EXTRACT_SCRIPT)) as {
      viewport: { w: number; h: number };
      regions: Array<{
        id: string;
        tag: string;
        role: string;
        rect: SpatialRect;
        constraint: string;
        zIndex: number | null;
        offscreen: boolean;
        interactive: boolean;
      }>;
      collisions: Array<{ a: string; b: string; overlap: SpatialRect; severity: 'hard' | 'soft' }>;
    };

    const regions: SpatialRegion[] = extracted.regions.map((r) => ({
      id: r.id,
      file: url.toString(),
      line: 0,
      rect: r.rect,
      constraint: (r.constraint || 'flow') as SpatialConstraint,
      magicNumbers: [],
      zIndex: r.zIndex,
      overlay: false,
      via: 'runtime' as const,
    }));

    const warnings: string[] = [];
    const offscreen = extracted.regions.filter((r) => r.offscreen);
    if (offscreen.length > 0) {
      warnings.push(
        `${offscreen.length} region(s) extend beyond the ${extracted.viewport.w}×${extracted.viewport.h} viewport: ` +
        offscreen.slice(0, 5).map((r) => `${r.id} ${JSON.stringify(r.rect)}`).join(', ') +
        (offscreen.length > 5 ? ', …' : ''),
      );
    }
    const tiny = extracted.regions.filter((r) => r.interactive && (r.rect.w < 24 || r.rect.h < 24));
    if (tiny.length > 0) {
      warnings.push(
        `${tiny.length} interactive element(s) below the 24px minimum touch size: ` +
        tiny.slice(0, 5).map((r) => `${r.id} (${r.rect.w}×${r.rect.h})`).join(', ') +
        (tiny.length > 5 ? ', …' : ''),
      );
    }

    const map: SpatialMap = {
      tier: 'runtime',
      url: url.toString(),
      viewport: extracted.viewport,
      files: [url.toString()],
      regions,
      collisions: extracted.collisions,
      warnings,
    };

    let screenshot: string | null = null;
    if (opts.saveScreenshot !== false) {
      const paths = baselinePaths(url.toString());
      if (!paths) {
        notes.push('no workspace bound — screenshot not persisted (spatial data lives in <workspace>/.moriko-dat/spatial)');
      } else {
        try {
          fs.mkdirSync(path.dirname(paths.png), { recursive: true });
          await page.screenshot({ path: paths.png, fullPage: false });
          screenshot = paths.png;
        } catch (error) {
          notes.push(`screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (opts.saveBaseline) {
      writeBaseline(url.toString(), map);
      notes.push('baseline saved — future runs can diff geometry drift against it');
    }

    return { url: url.toString(), map, screenshot, notes };
  } finally {
    clearTimeout(deadline);
    await page?.close().catch(() => undefined);
    if (context) {
      activeProbeContexts.delete(context);
      await context.close().catch(() => undefined);
    }
  }
}


const rectDelta = (a: SpatialRect, b: SpatialRect): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h);

export interface RuntimeComparison {
  matched: Array<{ staticId: string; runtimeId: string; delta: number }>;
  staticOnly: string[];
  runtimeOnly: string[];
  notes: string[];
}


export function compareWithRuntime(
  staticMap: SpatialMap,
  runtimeMap: SpatialMap,
  tolerance = 24,
): RuntimeComparison {
  const notes: string[] = [];
  const staticBoxes = staticMap.regions.filter((r) => r.rect !== null && !r.overlay);
  const runtimeBoxes = runtimeMap.regions.filter((r) => r.rect !== null && !r.overlay);
  const matched: RuntimeComparison['matched'] = [];
  const usedRuntime = new Set<number>();

  for (const s of staticBoxes) {
    if (s.rect === null) continue;
    let bestIdx = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runtimeBoxes.length; i++) {
      const r = runtimeBoxes[i];
      if (r.rect === null || usedRuntime.has(i)) continue;
      const nameMatch =
        r.id.toLowerCase().includes(s.id.replace(/^\./, '').toLowerCase()) ||
        s.id.replace(/^\./, '').toLowerCase().includes(r.id.toLowerCase());
      const delta = rectDelta(s.rect, r.rect);
      if (nameMatch && delta < bestDelta && delta <= tolerance * 4) {
        bestIdx = i;
        bestDelta = delta;
      }
    }
    if (bestIdx >= 0) {
      usedRuntime.add(bestIdx);
      matched.push({ staticId: s.id, runtimeId: runtimeBoxes[bestIdx].id, delta: Math.round(bestDelta) });
    } else {
      notes.push(`static region "${s.id}" has no runtime counterpart within tolerance — it may render differently than the source suggests`);
    }
  }

  const runtimeOnly = runtimeBoxes
    .filter((_, i) => !usedRuntime.has(i))
    .map((r) => r.id)
    .slice(0, 12);

  return {
    matched,
    staticOnly: staticBoxes.filter((s) => !matched.some((m) => m.staticId === s.id)).map((s) => s.id),
    runtimeOnly,
    notes,
  };
}


export function renderRuntimeReport(
  result: RuntimeCaptureResult,
  comparison?: RuntimeComparison,
): string {
  const lines: string[] = [];
  lines.push(`RUNTIME SPATIAL MAP (ground truth) — ${result.url}`);
  lines.push(`  viewport ${result.map.viewport?.w}×${result.map.viewport?.h} · ${result.map.regions.length} region(s) · ${result.map.collisions.length} HARD collision(s)`);
  for (const c of result.map.collisions.slice(0, 12)) {
    lines.push(`  ! HARD: ${c.a} ∩ ${c.b} — overlap(${c.overlap.x},${c.overlap.y},${c.overlap.w},${c.overlap.h})`);
  }
  for (const w of result.map.warnings.slice(0, 8)) lines.push(`  ~ ${w}`);
  for (const n of result.notes) lines.push(`  · ${n}`);
  if (comparison) {
    lines.push('');
    lines.push(`static ⇄ runtime — matched: ${comparison.matched.length}, static-only: ${comparison.staticOnly.length}, runtime-only: ${comparison.runtimeOnly.length}`);
    for (const m of comparison.matched.slice(0, 10)) {
      lines.push(`  ≈ ${m.staticId} ⇄ ${m.runtimeId} (Δ${m.delta}px)`);
    }
    for (const n of comparison.notes.slice(0, 6)) lines.push(`  ~ ${n}`);
  }
  return lines.join('\n');
}


export interface MeasuredNode {
  id: string;
  tag: string;
  rect: { x: number; y: number; w: number; h: number };
  text: string;
  lines: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  
  resolvedBg: string;
  fontFamily: string;
  overflow: boolean;
  interactive: boolean;
  hasMcVChildren: boolean;
}

export interface MeasuredViewport {
  name: string;
  width: number;
  height: number;
  docOverflowX: boolean;
  bodyBg: string;
  nodes: MeasuredNode[];
}

export interface MeasureHtmlResult {
  ok: boolean;
  viewports: MeasuredViewport[];
  notes: string[];
  error?: string;
}


const MCV_EXTRACT_SCRIPT = `
(() => {
  const alphaOf = (c) => {
    if (!c || c === 'none' || c === 'transparent') return 0;
    const slash = /\\/\\s*([\\d.]+)\\s*\\)$/.exec(c);
    if (slash) return parseFloat(slash[1]);
    const rgba = /rgba?\\([^)]*[,\\/]\\s*([\\d.]+)\\s*\\)$/.exec(c);
    return rgba ? parseFloat(rgba[1]) : 1;
  };
  const bgOf = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const c = getComputedStyle(cur).backgroundColor;
      if (alphaOf(c) > 0.6) return c;
      cur = cur.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255, 255, 255)';
  };
  const lineCount = (el) => {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
      if (rects.length === 0) return 0;
      const tops = [];
      for (const r of rects) {
        const t = Math.round(r.top);
        if (!tops.some((v) => Math.abs(v - t) <= 2)) tops.push(t);
      }
      return tops.length;
    } catch { return 0; }
  };
  const nodes = [];
  for (const el of document.querySelectorAll('[data-mcv-id]')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    nodes.push({
      id: el.getAttribute('data-mcv-id'),
      tag: el.tagName.toLowerCase(),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
      lines: lineCount(el),
      fontSize: parseFloat(st.fontSize) || 0,
      fontWeight: parseInt(st.fontWeight, 10) || 400,
      color: st.color,
      resolvedBg: bgOf(el),
      fontFamily: st.fontFamily.slice(0, 80),
      overflow: el.scrollWidth > el.clientWidth + 1,
      interactive: el.matches('button, a, input, select, textarea, [role="button"]'),
      hasMcVChildren: el.querySelector('[data-mcv-id]') !== null,
    });
  }
  return {
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    nodes,
  };
})();
`;

export interface MeasureViewportSpec {
  name: string;
  width: number;
  height: number;
}


export async function measureHtml(
  html: string,
  viewports: MeasureViewportSpec[],
): Promise<MeasureHtmlResult> {
  const out: MeasuredViewport[] = [];
  const notes: string[] = [];
  let context: import('playwright-core').BrowserContext | null = null;
  try {
    context = await acquireEphemeralContext();
    activeProbeContexts.add(context);
  } catch (error) {
    return {
      ok: false,
      viewports: [],
      notes: [],
      error: `headless browser unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    for (const vp of viewports) {
      let page: import('playwright-core').Page | null = null;
      try {
        page = await context.newPage();
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.setContent(html, { waitUntil: 'load', timeout: 10_000 });
        await page.waitForTimeout(120);
        const data = (await page.evaluate(MCV_EXTRACT_SCRIPT)) as Omit<MeasuredViewport, 'name' | 'width' | 'height'>;
        out.push({ name: vp.name, width: vp.width, height: vp.height, ...data });
      } catch (error) {
        notes.push(`${vp.name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await page?.close().catch(() => undefined);
      }
    }
  } finally {
    activeProbeContexts.delete(context);
    await context.close().catch(() => undefined);
  }
  return { ok: out.length > 0, viewports: out, notes };
}
