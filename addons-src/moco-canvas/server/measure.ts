/**
 * Moco Canvas — measured scene + lint 2D (P2).
 *
 * Compiles the scene to HTML, measures it in the harness headless browser
 * (api.harness.measureHtml → spatial-runtime measureHtml → getReusableBrowser)
 * at 3 viewports, then runs the core geometric/typographic/color lint over the
 * MEASURED data — facts, not intent (plan §10).
 *
 * Fallback contract (plan §9): any failure — browser unavailable, permission
 * missing, extraction empty — degrades to tier "intent" with an honest note,
 * never a silent pass.
 */

import { compileScene } from '../client/compile.ts';
import type { IntentLint } from '../client/readout.ts';
import { SPACE, type Scene, type Viewport } from '../client/scene.ts';

/** Mirrors harness MeasuredNode (server/agents/spatial-runtime.ts). */
export interface McvMeasuredNode {
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

export interface McvMeasuredViewport {
  name: string;
  width: number;
  height: number;
  docOverflowX: boolean;
  bodyBg: string;
  nodes: McvMeasuredNode[];
}

export interface MeasureOutcome {
  tier: 'runtime' | 'intent';
  viewports: McvMeasuredViewport[];
  /** lint computed from MEASURED data (empty when tier === intent) */
  lint: IntentLint[];
  notes: string[];
}

const L = (
  rule: string,
  severity: IntentLint['severity'],
  detail: string,
  node?: string,
): IntentLint => ({ rule, severity, node, detail });

// ── color math ───────────────────────────────────────────────────────────────

/** Parse rgb()/rgba()/oklch() into [r,g,b] 0–255 (oklch via CSS matrices —
 *  browsers report oklch() strings verbatim, so we convert them ourselves). */
function parseColor(input: string): [number, number, number] | null {
  const c = input.trim();
  let m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  // oklch(L C H) — OKLab → linear sRGB
  m = /oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.-]+)/.exec(c);
  if (m) {
    let Lc = Number(m[1]);
    if (m[0].includes('%')) Lc /= 100;
    const C = Number(m[2]);
    const Hdeg = Number(m[3]);
    const hr = (Hdeg * Math.PI) / 180;
    const a = C * Math.cos(hr);
    const b = C * Math.sin(hr);
    const l_ = Lc + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = Lc - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = Lc - 0.0894841775 * a - 1.291485548 * b;
    const l3 = l_ * l_ * l_;
    const m3 = m_ * m_ * m_;
    const s3 = s_ * s_ * s_;
    const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
    const gam = (x: number) => Math.max(0, Math.min(255, 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)));
    return [gam(r), gam(g), gam(bl)];
  }
  return null;
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio; null when either side fails to parse. */
export function contrastRatio(fg: string, bg: string): number | null {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  const lf = luminance(f);
  const lb = luminance(b);
  const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

// ── measured lint rules ──────────────────────────────────────────────────────

function overlapFraction(a: McvMeasuredNode, b: McvMeasuredNode): number {
  const x1 = Math.max(a.rect.x, b.rect.x);
  const y1 = Math.max(a.rect.y, b.rect.y);
  const x2 = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w);
  const y2 = Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const smaller = Math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
  return smaller > 0 ? inter / smaller : 0;
}

/** Sibling pair alignment drift: edges within 1–6 px look accidental. */
function driftLint(nodes: McvMeasuredNode[]): IntentLint[] {
  const out: IntentLint[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = Math.abs(a.rect.x - b.rect.x);
      const dy = Math.abs(a.rect.y - b.rect.y);
      if (dx > 0 && dx <= 6) {
        out.push(L('align-drift', 'warn', `left edge ${a.id} vs ${b.id} differs by ${dx}px (snap to equal)`));
      }
      if (dy > 0 && dy <= 6) {
        out.push(L('align-drift', 'warn', `top edge ${a.id} vs ${b.id} differs by ${dy}px (snap to equal)`));
      }
    }
  }
  return out.slice(0, 8);
}

/** Measured gap between consecutive siblings vs the spacing scale. */
function gapLint(nodes: McvMeasuredNode[]): IntentLint[] {
  const scale = Object.values(SPACE);
  const names = Object.keys(SPACE);
  const out: IntentLint[] = [];
  const sorted = [...nodes].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const sameRow = Math.abs(prev.rect.y - cur.rect.y) < 4;
    const gap = sameRow
      ? cur.rect.x - (prev.rect.x + prev.rect.w)
      : cur.rect.y - (prev.rect.y + prev.rect.h);
    if (gap > 2 && !scale.some((s) => Math.abs(s - gap) <= 1)) {
      let nearest = scale[0];
      for (const s of scale) if (Math.abs(s - gap) < Math.abs(nearest - gap)) nearest = s;
      const token = names[scale.indexOf(nearest)];
      out.push(L('off-scale-gap', 'warn', `gap ${prev.id} → ${cur.id} is ${Math.round(gap)}px — nearest scale stop ${token} = ${nearest}px`));
    }
  }
  return out.slice(0, 8);
}

function measuredLint(viewport: McvMeasuredViewport): IntentLint[] {
  const out: IntentLint[] = [];

  // h-scroll (critical)
  if (viewport.docOverflowX) {
    out.push(L('h-scroll', 'critical', `document overflows horizontally at ${viewport.width}px viewport`));
  }

  // node-level: overflow + contrast + line-length
  for (const n of viewport.nodes) {
    if (n.overflow) {
      out.push(L('overflow', 'critical', `${Math.round(n.rect.w)}×${Math.round(n.rect.h)} — scrollWidth exceeds clientWidth`, n.id));
    }
    if (n.text) {
      const ratio = contrastRatio(n.color, n.resolvedBg);
      if (ratio !== null && n.fontSize < 24 && ratio < 4.5) {
        out.push(L('contrast', 'critical', `contrast ${ratio.toFixed(2)}:1 < 4.5:1 on "${n.text.slice(0, 40)}"`, n.id));
      } else if (ratio !== null && n.fontSize >= 24 && ratio < 3) {
        out.push(L('contrast', 'critical', `large-text contrast ${ratio.toFixed(2)}:1 < 3:1 on "${n.text.slice(0, 40)}"`, n.id));
      }
      // line-length: mid-size multi-line text only
      if (n.lines >= 2 && n.fontSize >= 14 && n.fontSize < 24) {
        const chW = n.fontSize * 0.5; // ≈ average glyph width of the body font
        const chPerLine = Math.round(n.rect.w / chW);
        if (chPerLine > 75) {
          out.push(L('line-length', 'warn', `${chPerLine} ch/line > 75 — add maxWidth in ch units`, n.id));
        }
      }
    }
  }

  // sibling-level: overlap + drift + off-scale-gap. Only leaf nodes —
  // container boxes contain their children by construction.
  const leaves = viewport.nodes.filter((n) => !n.hasMcVChildren);
  const byParent = new Map<string, McvMeasuredNode[]>();
  for (const n of leaves) {
    let key = '__root__';
    let bestArea = Number.POSITIVE_INFINITY;
    for (const cand of viewport.nodes) {
      if (cand.id === n.id || !cand.hasMcVChildren) continue;
      const contains =
        cand.rect.x - 1 <= n.rect.x &&
        cand.rect.y - 1 <= n.rect.y &&
        cand.rect.x + cand.rect.w + 1 >= n.rect.x + n.rect.w &&
        cand.rect.y + cand.rect.h + 1 >= n.rect.y + n.rect.h;
      const area = cand.rect.w * cand.rect.h;
      if (contains && area < bestArea) {
        bestArea = area;
        key = cand.id;
      }
    }
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(n);
  }
  for (const group of byParent.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const f = overlapFraction(group[i], group[j]);
        if (f >= 0.125) {
          out.push(L('overlap', 'critical', `${Math.round(f * 100)}% box overlap (measured)`, `${group[i].id} ∩ ${group[j].id}`));
        }
      }
    }
    out.push(...driftLint(group), ...gapLint(group));
  }

  // hierarchy-flat: measured display/body size ratio
  const sizes = viewport.nodes.map((n) => n.fontSize).filter((s) => s > 0);
  if (sizes.length >= 2) {
    const display = Math.max(...sizes);
    const bodySizes = viewport.nodes
      .filter((n) => n.fontSize >= 13 && n.fontSize < 24 && n.text)
      .map((n) => n.fontSize);
    const body = bodySizes.length ? Math.min(...bodySizes) : Math.min(...sizes);
    if (body > 0 && display / body < 1.6) {
      out.push(L('hierarchy-flat', 'warn', `display/body ratio ${display.toFixed(1)}/${body.toFixed(1)} = ${(display / body).toFixed(2)} < 1.6`));
    }
  }

  return out.slice(0, 24);
}

// ── measure orchestration ────────────────────────────────────────────────────

function viewportsFor(scene: Scene, only?: Viewport): Array<{ name: string; width: number; height: number }> {
  const all: Array<{ name: Viewport; width: number; height: number }> = [
    { name: 'sm', width: scene.breakpoints.sm, height: 844 },
    { name: 'md', width: scene.breakpoints.md, height: 1024 },
    { name: 'lg', width: scene.breakpoints.lg, height: 900 },
  ];
  return all.filter((v) => !only || v.name === only);
}

/**
 * Measure the compiled scene at 3 viewports and run the measured lint.
 * Any failure → tier "intent" with a note (never a silent pass).
 */
export async function measureScene(
  scene: Scene,
  api: any,
  opts: { viewport?: Viewport; sessionId?: string } = {},
): Promise<MeasureOutcome> {
  const notes: string[] = [];
  const fallback: MeasureOutcome = { tier: 'intent', viewports: [], lint: [], notes };
  const measureHtml = api?.harness?.measureHtml;
  if (typeof measureHtml !== 'function') {
    notes.push('harness.measureHtml unavailable (addon API too old) — readout stays tier:intent');
    return fallback;
  }
  try {
    const compiled = compileScene(scene);
    // Overlay affordances (resize handles, id badges, grid guide, drop ghost)
    // extend the scroll area and would fake `overflow` lint — hide them for
    // the measurement pass only.
    const suppress = '<style id="mcv-measure-suppress">' +
      '.mcv-rh,.mcv-grid-guide,#mcv-drop-ghost{display:none!important}' +
      '[data-mcv-id]::before{display:none!important}' +
      '</style>';
    const html = compiled.html.includes('</head>')
      ? compiled.html.replace('</head>', `${suppress}</head>`)
      : `${suppress}${compiled.html}`;
    const result = (await measureHtml.call(api.harness, html, viewportsFor(scene, opts.viewport))) as {
      ok: boolean;
      viewports: McvMeasuredViewport[];
      notes?: string[];
      error?: string;
    };
    if (!result?.ok) {
      notes.push(`measure failed: ${result?.error ?? 'no viewport measured'}${result?.notes?.length ? ` — ${result.notes.join('; ')}` : ''}`);
      return { ...fallback, notes };
    }
    if (result.notes?.length) notes.push(...result.notes);
    const viewports = result.viewports;
    if (!viewports.length || viewports.every((v) => v.nodes.length === 0)) {
      notes.push('measured 0 [data-mcv-id] nodes — compiled HTML may be empty; readout stays tier:intent');
      return { ...fallback, notes };
    }
    const lint = viewports.flatMap((vp) => measuredLint(vp));
    return { tier: 'runtime', viewports, lint, notes };
  } catch (error) {
    notes.push(`measure threw: ${error instanceof Error ? error.message : String(error)} — readout stays tier:intent`);
    return fallback;
  }
}

/** Compact measured block for the tool result (delta budget). */
export function measuredLintBlock(outcome: MeasureOutcome): string {
  const lines: string[] = [`tier: ${outcome.tier}`];
  for (const note of outcome.notes) lines.push(`· ${note}`);
  if (outcome.tier === 'runtime') {
    const criticals = outcome.lint.filter((l) => l.severity === 'critical');
    const warns = outcome.lint.filter((l) => l.severity === 'warn');
    lines.push(`measured lint: ${criticals.length} critical, ${warns.length} warn across ${outcome.viewports.length} viewport(s)`);
    for (const l of [...criticals, ...warns].slice(0, 8)) {
      lines.push(`  ${l.severity === 'critical' ? '⛔' : '~'} ${l.rule} (${l.node ?? '—'}): ${l.detail}`);
    }
  }
  return lines.join('\n');
}
