/**
 * SPATIAL RUNTIME (F4) — ground-truth tier: real browser geometry.
 *
 * Tier ladder (docs/plans/PLAN-SPATIAL-HARNESS.md):
 *   static  — parse CSS/JSX source; parent-relative coords; overlaps are
 *             CANDIDATES (severity "soft"). Ship in F0.
 *   runtime — headless browser (playwright-core, channel msedge on Windows):
 *             real DOM bounding boxes + simplified a11y info + a screenshot
 *             for the user. Overlaps become FACTS (severity "hard").
 *
 * Safety posture:
 *  - playwright-core is an OPTIONAL dev dependency — the module degrades to
 *    a clear "not installed" message instead of ever throwing at import time
 *    (the whole spatial tool surface stays usable without it).
 *  - Only http(s) targets, only localhost/private hostnames by default
 *    (public URLs are allowed via `allowPublic: true` — explicit opt-in),
 *    no code evaluation, no form submission — read-only observation.
 *  - A baseline dir under the MORIKO home stores per-URL screenshots +
 *    JSON so a later run can diff geometry drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type SpatialMap,
  type SpatialRegion,
  type SpatialRect,
  type SpatialConstraint,
} from './spatial.js';
import { getActiveWorkspace } from './workspace.js';

/** Track playwright availability without ever throwing at import time. */
type PlaywrightModule = typeof import('playwright-core');
let cachedPw: PlaywrightModule | null | undefined;

/**
 * Dynamic import of playwright-core, cached. Exported so the built-in browser
 * (agents/browser/manager.ts) shares the SAME cached module instance instead
 * of importing it a second time — one load, both consumers.
 */
export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (cachedPw !== undefined) return cachedPw;
  try {
    const imported = await import('playwright-core');
    cachedPw = (imported as { default?: PlaywrightModule }).default ?? imported;
    return cachedPw;
  } catch {
    cachedPw = null;
    return null;
  }
}


/** Data dir for runtime captures: <workspace>/.moriko-dat/spatial/ — User
 *  decision: screenshot & baseline live INSIDE the workspace so the agent can
 *  read them back (read-policy forbids reading outside the workspace root).
 *  No workspace bound → capture still works, but no screenshot is persisted. */
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

/** Baseline housekeeping: drop baseline JSON older than 30 days (bounded).
 *  Sweep menangani workspace AKTIF — workspace lain disweep saat mereka aktif. */
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
const RUNTIME_TIMEOUT_MS = 20_000;
const MAX_RUNTIME_REGIONS = 400;

/** The in-page extraction script — runs inside the browser, returns plain JSON. */
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

/** Launch → navigate → extract → screenshot → close. Throws with clear text on missing browsers. */
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

  let browser;
  try {
    try {
      browser = await pw.chromium.launch({
        headless: true,
        channel: 'msedge',
      });
    } catch {
      // B9 fallback: no Edge → bundled/installed chromium.
      browser = await pw.chromium.launch({ headless: true });
    }
  } catch (error) {
    throw new Error(
      'Could not launch a headless browser (tried channel "msedge", then "chromium"). Install Microsoft Edge or run ' +
      '"npx playwright install chromium" once (downloads ~150 MB). ' +
      `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const page = await browser.newPage({ viewport });
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: RUNTIME_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: RUNTIME_TIMEOUT_MS });
    try {
      await page.waitForLoadState('networkidle', { timeout: 4_000 });
    } catch {
    }
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
    await browser.close().catch(() => undefined);
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

/**
 * Compare a static map's regions against a runtime capture of the same page.
 * Matching is heuristic (id text ⊆ runtime name, nearest rect within a
 * tolerance) — the POINT is drift detection, not perfect identity.
 */
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

/** Render a runtime capture + optional comparison into agent-readable text. */
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
