/**
 * SPATIAL IR — layout map + collision detection, static tier (F0).
 *
 * Part of docs/plans/PLAN-SPATIAL-HARNESS.md. Principle: the agent edits UI in
 * "intent space"; the harness measures the result in "metric space". This
 * module is the deterministic foundation:
 *   - Layout IR types (region, collision, map)
 *   - pure geometry core (rect intersection, severity classification)
 *   - Tier-1 static extractor: absolutely positioned boxes out of CSS rules
 *     and JSX inline styles — zero dependencies, no browser
 *   - compact renderer for agent injection (F1 wires it into a tool)
 *
 * Honesty rules:
 *   - Static absolute coordinates are PARENT-RELATIVE and the parent is
 *     unknown without a runtime, so a static overlap is always a CANDIDATE
 *     (severity "soft"). "hard" is reserved for runtime truth (F4).
 *   - Percent / var() / calc() coordinates are non-deterministic here:
 *     flagged via magicNumbers, excluded from collision math.
 *   - Overlay semantics (modal, tooltip, popover, ...) are exempt from
 *     collision reporting — overlays are SUPPOSED to cover things.
 *
 * Scanner discipline follows deps.ts: string- and comment-aware, bounded,
 * line-anchored so every region reports a jumpable file:line.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';


export interface SpatialRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SpatialConstraint = 'absolute' | 'fixed' | 'flow' | 'unknown';

export interface SpatialRegion {
  id: string;
  /** workspace-relative source file */
  file: string;
  /** 1-based, jumpable */
  line: number;
  /** null = geometry not statically determinable (partial coordinates) */
  rect: SpatialRect | null;
  constraint: SpatialConstraint;
  /** px literals in positioning props — the "guessed pixel" smell (P1) */
  magicNumbers: string[];
  zIndex: number | null;
  /** true when role/id suggests overlay semantics (never a collision source) */
  overlay: boolean;
  via: 'css-rule' | 'inline-style' | 'runtime' | 'mockup';
}

export interface SpatialCollision {
  a: string;
  b: string;
  overlap: SpatialRect;
  severity: 'hard' | 'soft';
}

export interface SpatialMap {
  tier: 'static' | 'runtime' | 'mockup';
  /** runtime tier only — the page the boxes were measured on */
  url?: string;
  /** runtime tier only — the viewport the geometry was measured at */
  viewport?: { w: number; h: number };
  files: string[];
  regions: SpatialRegion[];
  collisions: SpatialCollision[];
  warnings: string[];
}

const OVERLAY_HINTS = [
  'modal', 'dialog', 'tooltip', 'popover', 'dropdown', 'menu',
  'overlay', 'toast', 'snackbar', 'banner', 'drawer', 'lightbox',
];

function looksLikeOverlay(id: string): boolean {
  const lower = id.toLowerCase();
  return OVERLAY_HINTS.some((h) => lower.includes(h));
}


/** Closed-interval-on-both-axes intersection; touching edges is NOT overlap. */
export function intersectionRect(a: SpatialRect, b: SpatialRect): SpatialRect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Pairwise overlap detection over regions with a complete rect.
 * Severity (static tier): every overlap is a CANDIDATE ("soft") because
 * static coords are parent-relative; "hard" is reserved for runtime (F4).
 */
export function detectCollisions(regions: SpatialRegion[]): SpatialCollision[] {
  const solid = regions.filter(
    (r) => r.rect !== null && !r.overlay && !looksLikeOverlay(r.id),
  );
  const out: SpatialCollision[] = [];
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i];
      const b = solid[j];
      if (a.file !== b.file) continue;
      const overlap = intersectionRect(a.rect!, b.rect!);
      if (!overlap) continue;
      out.push({ a: a.id, b: b.id, overlap, severity: 'soft' });
    }
  }
  return out.sort((p, q) => q.overlap.w * q.overlap.h - p.overlap.w * p.overlap.h);
}


/**
 * Parse a CSS/JSX length literal into px. Accepts "260px", 260, and "-10px".
 * Percent ("50%"), var(), calc() → null (non-deterministic in static tier).
 */
export function parsePx(value: string): number | null {
  const v = value.trim().replace(/^['"]|['"]$/g, '');
  if (v.endsWith('px')) {
    const n = Number.parseFloat(v.slice(0, -2));
    return Number.isFinite(n) ? n : null;
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    return Number.parseFloat(v);
  }
  return null;
}

const BOX_PROPS = ['top', 'left', 'right', 'bottom', 'width', 'height'] as const;
type BoxProp = (typeof BOX_PROPS)[number];

interface BoxProps {
  position?: 'absolute' | 'fixed' | 'relative' | 'static' | 'sticky';
  values: Partial<Record<BoxProp, number>>;
  /** raw literals of non-deterministic values (%, var, calc) — for warnings */
  nondet: string[];
  zIndex: number | null;
}

/** Parse `key: value` pairs from a CSS declaration body or JSX style object. */
function parseBoxProps(body: string): BoxProps {
  const out: BoxProps = { values: {}, nondet: [], zIndex: null };
  const pairRe = /([A-Za-z-]+)\s*:\s*("[^"]*"|'[^']*'|[^,;}\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(body)) !== null) {
    const key = m[1].replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    const raw = m[2].trim();
    if (key === 'position') {
      const p = raw.replace(/^['"]|['"]$/g, '').toLowerCase();
      if (p === 'absolute' || p === 'fixed' || p === 'relative' || p === 'sticky') {
        out.position = p;
      } else if (p === 'static') {
        out.position = 'static';
      }
      continue;
    }
    if (key === 'zIndex') {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) out.zIndex = n;
      continue;
    }
    if ((BOX_PROPS as readonly string[]).includes(key)) {
      const px = parsePx(raw);
      if (px !== null) {
        out.values[key as BoxProp] = px;
      } else if (raw !== 'auto' && raw !== '0') {
        out.nondet.push(`${key}: ${raw}`);
      }
    }
  }
  return out;
}

/**
 * Resolve positioning props into a rect. Static tier needs ALL of:
 * top + left + width + height (parent-relative, canvas unknown → right/
 * bottom-only or % sizes stay partial). Returns null rect when partial.
 */
function resolveRect(p: BoxProps): { rect: SpatialRect | null; magic: string[] } {
  const magic: string[] = [];
  for (const [k, v] of Object.entries(p.values)) {
    magic.push(`${k}: ${v}px`);
  }
  const v = p.values;
  const complete =
    v.top !== undefined && v.left !== undefined && v.width !== undefined && v.height !== undefined;
  const rect: SpatialRect | null = complete
    ? { x: v.left!, y: v.top!, w: v.width!, h: v.height! }
    : null;
  return { rect, magic };
}


/** Blank out comments (keep newlines so line math stays honest). */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

/**
 * Extract absolutely-positioned regions from CSS source.
 * One region per declaration block that sets position:absolute|fixed with
 * px coordinates. Nested @media blocks are handled (their rules inherit the
 * "media context unknown" caveat via warnings, counted once per file).
 */
export function extractCssRegions(src: string, file: string): { regions: SpatialRegion[]; mediaBlocks: number } {
  const clean = stripCssComments(src);
  const regions: SpatialRegion[] = [];
  const mediaBlocks = (clean.match(/@media\b/g) ?? []).length;

  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(clean)) !== null) {
    const selectorRaw = m[1].replace(/@media[^{]*/g, ' ').trim();
    const body = m[2];
    if (!selectorRaw || selectorRaw.includes('@')) continue;
    const props = parseBoxProps(body);
    if (props.position !== 'absolute' && props.position !== 'fixed') continue;
    const { rect, magic } = resolveRect(props);
    const id = selectorRaw.split(',').map((s) => s.trim()).filter(Boolean)[0] ?? selectorRaw.trim();
    const line = clean.slice(0, m.index + m[1].length).split('\n').length;
    regions.push({
      id,
      file,
      line,
      rect,
      constraint: props.position,
      magicNumbers: [...magic, ...props.nondet],
      zIndex: props.zIndex,
      overlay: looksLikeOverlay(id),
      via: 'css-rule',
    });
  }
  return { regions, mediaBlocks };
}


/** Find `style={{ ... }}` objects in JSX and return [start, end) spans. */
function findStyleSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === 's' && src.startsWith('style={{', i)) {
      let depth = 0;
      let j = i + 'style='.length;
      const start = j + 1;
      while (j < n) {
        const c = src[j];
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      if (j < n) spans.push([start, j]);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

/** Nearest JSX tag name before an offset: `<FilterPanel` → "FilterPanel". */
function nearestTagBefore(src: string, offset: number): string | null {
  for (let i = offset - 1; i >= 0; i--) {
    if (src[i] === '>') return null;
    if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
      let j = i + 1;
      let name = '';
      while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) {
        name += src[j];
        j += 1;
      }
      if (name) return name.split('.').pop() ?? name;
    }
  }
  return null;
}

/**
 * Extract absolutely-positioned regions from JSX/TSX inline styles.
 * A string containing style={{...}}-shaped text is inert because
 * findStyleSpans skips string bodies — that is the whole point.
 */
export function extractJsxRegions(src: string, file: string): SpatialRegion[] {
  const regions: SpatialRegion[] = [];
  for (const [start, end] of findStyleSpans(src)) {
    const body = src.slice(start, end);
    const props = parseBoxProps(body);
    if (props.position !== 'absolute' && props.position !== 'fixed') continue;
    const { rect, magic } = resolveRect(props);
    const line = src.slice(0, start).split('\n').length;
    const tag = nearestTagBefore(src, start);
    const id = tag ?? `style@${file}:${line}`;
    regions.push({
      id,
      file,
      line,
      rect,
      constraint: props.position,
      magicNumbers: [...magic, ...props.nondet],
      zIndex: props.zIndex,
      overlay: looksLikeOverlay(id),
      via: 'inline-style',
    });
  }
  return regions;
}


/**
 * Build a static SpatialMap from file contents (pure core — the fs walker
 * and future runtime feeder both land here).
 */
export function buildSpatialMap(sources: Array<{ path: string; content: string }>): SpatialMap {
  const regions: SpatialRegion[] = [];
  const warnings: string[] = [];
  const files: string[] = [];
  let mediaBlocks = 0;

  for (const { path: file, content } of sources) {
    files.push(file);
    if (file.endsWith('.css')) {
      const r = extractCssRegions(content, file);
      mediaBlocks += r.mediaBlocks;
      regions.push(...r.regions);
    } else if (/\.(tsx|jsx)$/.test(file)) {
      regions.push(...extractJsxRegions(content, file));
    }
  }

  for (const r of regions) {
    if (r.rect === null && r.magicNumbers.length > 0) {
      warnings.push(`${r.id} (${r.file}:${r.line}): absolute positioning with partial/non-deterministic coords — ${r.magicNumbers.join(', ')}`);
    }
  }
  if (mediaBlocks > 0) {
    warnings.push(`${mediaBlocks} @media block(s) found — absolute boxes inside them are context-conditional (static tier caveat)`);
  }

  return {
    tier: 'static',
    files,
    regions,
    collisions: detectCollisions(regions),
    warnings,
  };
}

/**
 * Compact agent-injectable rendering of a map. Kept deliberately terse:
 * pre-edit context (F1 "map" mode) must cost few tokens.
 */
export function renderSpatialMap(map: SpatialMap): string {
  const lines: string[] = [];
  const label =
    map.tier === 'runtime'
      ? `RUNTIME MAP (ground truth${map.url ? ` · ${map.url}` : ''})`
      : map.tier === 'mockup'
        ? 'MOCKUP MAP (design target — from a vision-model segmentation, approximate)'
        : 'SPATIAL MAP (static tier)';
  const view = map.viewport ? ` · viewport ${map.viewport.w}×${map.viewport.h}` : '';
  lines.push(`${label} — ${map.files.length} source(s), ${map.regions.length} region(s), ${map.collisions.length} collision(s)${view}`);
  for (const r of map.regions) {
    const rect = r.rect ? `rect(${r.rect.x},${r.rect.y},${r.rect.w},${r.rect.h})` : 'rect(partial)';
    const flags = [
      r.overlay ? 'overlay' : null,
      r.zIndex !== null ? `z:${r.zIndex}` : null,
      r.magicNumbers.length > 0 ? `magic[${r.magicNumbers.length}]` : null,
    ].filter(Boolean).join(' ');
    lines.push(`  ${r.id} ${rect} ${r.constraint} ${r.via} ${r.file}:${r.line}${flags ? ' ' + flags : ''}`);
  }
  for (const c of map.collisions) {
    const sev = map.tier === 'runtime' ? 'HARD fact' : 'candidate';
    lines.push(`  ! ${sev} ${c.severity}: ${c.a} ∩ ${c.b} — overlap(${c.overlap.x},${c.overlap.y},${c.overlap.w},${c.overlap.h})`);
  }
  for (const w of map.warnings) lines.push(`  ~ ${w}`);
  return lines.join('\n');
}


export type LayoutIntentType =
  | 'move-right-of'
  | 'move-below'
  | 'swap'
  | 'resize-relative'
  | 'align';

export interface LayoutIntent {
  type: LayoutIntentType;
  /** target region id (region.id from the spatial map) */
  target: string;
  /** reference region id — required for all intents except resize-relative/align */
  reference?: string;
  /** resize-relative and align only — negative grows left/up for resize */
  scale?: number;
  /** resize-relative only — which dimension to scale; default both */
  axis?: 'x' | 'y' | 'both';
  /** align only — which edge/axis to align the target onto the reference */
  mode?: 'left' | 'top' | 'center-x' | 'center-y' | 'right' | 'bottom';
  /** gap in px between the moved box and the reference box (default 0) */
  gap?: number;
}

export interface LayoutIntentEdit {
  file: string;
  /** exact old text of the positioning declaration to replace */
  oldText: string;
  newText: string;
  /** 1-based line of the declaration (for reporting) */
  line: number;
}

export interface LayoutIntentPlan {
  edits: LayoutIntentEdit[];
  /** human-readable explanation of the computed geometry */
  explanation: string[];
  warnings: string[];
}

interface PositionedTarget {
  region: SpatialRegion;
  /** character span of the positioning declaration inside the file */
  span: [number, number];
  props: Record<BoxProp, number | undefined> & { position?: string };
}

const INTENT_PROPS: BoxProp[] = ['top', 'left', 'width', 'height'];

function parseIntentPositioned(src: string, file: string, id: string): PositionedTarget | null {
  const isCss = file.endsWith('.css');
  const findSpan = isCss
    ? (source: string): Array<{ start: number; end: number; body: string; line: number; head: string }> => {
        const clean = stripCssComments(source);
        const out: Array<{ start: number; end: number; body: string; line: number; head: string }> = [];
        const blockRe = /([^{}]+)\{([^{}]*)\}/g;
        let m: RegExpExecArray | null;
        while ((m = blockRe.exec(clean)) !== null) {
          const head = m[1].replace(/@media[^{]*/g, ' ').trim();
          if (!head || head.includes('@')) continue;
          out.push({
            start: m.index,
            end: m.index + m[0].length,
            body: m[2],
            line: clean.slice(0, m.index + m[1].length).split('\n').length,
            head,
          });
        }
        return out;
      }
    : null;

  if (findSpan && isCss) {
    for (const block of findSpan(src)) {
      const sels = block.head.split(',').map((s) => s.trim());
      if (!sels.includes(id)) continue;
      const props: Record<string, number | undefined> = {};
      const box = parseBoxProps(block.body);
      for (const p of INTENT_PROPS) props[p] = box.values[p];
      if (Object.values(props).every((v) => v === undefined)) continue;
      return {
        region: {
          id, file, line: block.line,
          rect: null, constraint: 'absolute',
          magicNumbers: [], zIndex: null, overlay: false, via: 'css-rule',
        },
        span: [block.start, block.end],
        props: props as PositionedTarget['props'],
      };
    }
    return null;
  }

  for (const [start, end] of findStyleSpans(src)) {
    const body = src.slice(start, end);
    const box = parseBoxProps(body);
    if (box.position !== 'absolute' && box.position !== 'fixed') continue;
    const tag = nearestTagBefore(src, start);
    if (tag !== id && !id.startsWith(`${tag}@`)) continue;
    const props: Record<string, number | undefined> = {};
    for (const p of INTENT_PROPS) props[p] = box.values[p];
    const line = src.slice(0, start).split('\n').length;
    return {
      region: {
        id, file, line,
        rect: null, constraint: 'absolute',
        magicNumbers: [], zIndex: null, overlay: false, via: 'inline-style',
      },
      span: [start, end],
      props: props as PositionedTarget['props'],
    };
  }
  return null;
}

/** Rebuild a full CSS rule body with updated numeric props (px only). */
function rewriteCssBody(body: string, updates: Partial<Record<BoxProp, number>>): string {
  let out = body;
  for (const [prop, value] of Object.entries(updates) as Array<[BoxProp, number]>) {
    const re = new RegExp(`(${prop}\\s*:\\s*)(-?\\d+(?:\\.\\d+)?(?:px)?)`, 'g');
    if (re.test(out)) {
      out = out.replace(re, `$1${value}px`);
    } else {
      out = out.replace(/(position\s*:\s*(?:absolute|fixed)\s*;?)/i, `$1 ${prop}: ${value}px;`);
    }
  }
  return out;
}

/** Rebuild a JSX inline style object with updated numeric props (px only). */
function rewriteJsxBody(body: string, updates: Partial<Record<BoxProp, number>>): string {
  let out = body;
  for (const [prop, value] of Object.entries(updates) as Array<[BoxProp, number]>) {
    const re = new RegExp(`(${prop}\\s*:\\s*)(-?\\d+(?:\\.\\d+)?)`, 'g');
    if (re.test(out)) {
      out = out.replace(re, `$1${value}`);
    } else {
      out = out.replace(/^{\s*/, `{ ${prop}: ${value}, `);
    }
  }
  return out;
}

/**
 * Compile a layout intent into concrete text edits against ONE file's source.
 * Pure function — no fs, no terminal. The MODEL expresses relations
 * ("right of the canvas with a 16px gap"); this compiler computes every
 * coordinate, so no hallucinated pixels ever reach the code.
 *
 * Supported today (static tier): both target and reference must be
 * absolutely positioned with complete rects (top/left/width/height px),
 * declared in the SAME file (CSS rule or JSX inline style).
 */
export function applyLayoutIntent(
  src: string,
  file: string,
  intent: LayoutIntent,
): { plan: LayoutIntentPlan } | { error: string } {
  const target = parseIntentPositioned(src, file, intent.target);
  if (!target) {
    return {
      error:
        `Target region "${intent.target}" not found as an absolutely-positioned, statically-resolvable ` +
        `box in ${file}. Run agent__spatial {mode:"map"} and use a region id with a complete rect.`,
    };
  }
  const t = target.props;
  const warnings: string[] = [];
  const explanation: string[] = [];

  const requireRef = (): { x: number; y: number; w: number; h: number } | { error: string } => {
    if (!intent.reference) {
      return { error: `Intent "${intent.type}" needs a "reference" region id.` };
    }
    const ref = parseIntentPositioned(src, file, intent.reference);
    if (!ref) {
      return {
        error:
          `Reference region "${intent.reference}" not found (or has no complete static rect) in ${file}. ` +
          `Both boxes must be absolutely positioned with top/left/width/height in the same file for the static tier.`,
      };
    }
    const r = ref.props;
    if (
      r.top === undefined || r.left === undefined || r.width === undefined || r.height === undefined ||
      t.top === undefined || t.left === undefined || t.width === undefined || t.height === undefined
    ) {
      return {
        error:
          'Static-tier intents need COMPLETE boxes (top+left+width+height, px) for both target and reference. ' +
          'Partial boxes (% sizes, right/bottom-only) are reported by the map but cannot be compiled deterministically.',
      };
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  const gap = intent.gap ?? 0;
  let rewrite: Partial<Record<BoxProp, number>> | null = null;

  switch (intent.type) {
    case 'move-right-of': {
      const ref = requireRef();
      if ('error' in ref) return { error: ref.error };
      if (t.width === undefined || t.height === undefined) return { error: 'target needs width+height' };
      const dx = ref.x + ref.w + gap;
      rewrite = { left: dx, top: ref.y };
      explanation.push(
        `move ${intent.target} right of ${intent.reference}: left ${t.left}→${dx} (ref.x ${ref.x} + ref.w ${ref.w} + gap ${gap}), top → ${ref.y} (aligned to reference top)`,
      );
      break;
    }
    case 'move-below': {
      const ref = requireRef();
      if ('error' in ref) return { error: ref.error };
      if (t.width === undefined || t.height === undefined) return { error: 'target needs width+height' };
      const dy = ref.y + ref.h + gap;
      rewrite = { top: dy, left: ref.x };
      explanation.push(
        `move ${intent.target} below ${intent.reference}: top ${t.top}→${dy} (ref.y ${ref.y} + ref.h ${ref.h} + gap ${gap}), left → ${ref.x} (aligned to reference left)`,
      );
      break;
    }
    case 'swap': {
      const ref = requireRef();
      if ('error' in ref) return { error: ref.error };
      rewrite = { left: ref.x, top: ref.y };
      explanation.push(
        `swap ${intent.target} ↔ ${intent.reference}: target takes the reference rect origin (${ref.x},${ref.y}); ` +
        `NOTE the reference must be moved to (${t.left},${t.top}) in a second call — static tier edits one region per call`,
      );
      warnings.push(
        `swap edits ONE side per call — after this edit, run a SECOND call with target ${intent.reference} and reference ${intent.target} (gap 0) to complete the exchange.`,
      );
      break;
    }
    case 'resize-relative': {
      const scale = intent.scale ?? 1;
      if (!Number.isFinite(scale) || scale <= 0) {
        return { error: 'resize-relative needs a positive finite "scale" (e.g. 0.5 shrinks, 2 doubles).' };
      }
      if (t.width === undefined || t.height === undefined) {
        return { error: 'resize-relative needs a complete target box (width+height px).' };
      }
      const axis = intent.axis ?? 'both';
      const upd: Partial<Record<BoxProp, number>> = {};
      if (axis === 'x' || axis === 'both') upd.width = Math.round(t.width * scale);
      if (axis === 'y' || axis === 'both') upd.height = Math.round(t.height * scale);
      rewrite = upd;
      explanation.push(
        `resize ${intent.target} ×${scale} (${axis}): width ${t.width}→${upd.width ?? t.width}, height ${t.height}→${upd.height ?? t.height}`,
      );
      break;
    }
    case 'align': {
      const ref = requireRef();
      if ('error' in ref) return { error: ref.error };
      const m = intent.mode ?? 'left';
      const upd: Partial<Record<BoxProp, number>> = {};
      if (m === 'left') upd.left = ref.x;
      else if (m === 'top') upd.top = ref.y;
      else if (m === 'right' && t.width !== undefined) upd.left = ref.x + ref.w - t.width;
      else if (m === 'bottom' && t.height !== undefined) upd.top = ref.y + ref.h - t.height;
      else if (m === 'center-x' && t.width !== undefined) upd.left = ref.x + Math.round((ref.w - t.width) / 2);
      else if (m === 'center-y' && t.height !== undefined) upd.top = ref.y + Math.round((ref.h - t.height) / 2);
      else return { error: `align mode "${m}" needs the target ${m.includes('center') || m === 'right' ? 'width' : 'height'} to be statically known.` };
      rewrite = upd;
      explanation.push(`align ${intent.target} ${m} onto ${intent.reference}`);
      break;
    }
  }

  if (!rewrite) return { error: 'no rewrite produced — unsupported intent shape.' };

  const isCss = file.endsWith('.css');
  const rawOld = src.slice(target.span[0], target.span[1]);
  const newBody = isCss
    ? rewriteCssBody(rawOld.slice(rawOld.indexOf('{') + 1, rawOld.lastIndexOf('}')), rewrite)
    : rewriteJsxBody(rawOld, rewrite);
  const rawNew = isCss
    ? rawOld.slice(0, rawOld.indexOf('{') + 1) + newBody + rawOld.slice(rawOld.lastIndexOf('}'))
    : newBody;

  return {
    plan: {
      edits: [
        {
          file,
          oldText: rawOld,
          newText: rawNew,
          line: target.region.line,
        },
      ],
      explanation,
      warnings,
    },
  };
}


const SPATIAL_SKIP_DIRS = new Set([
  'node_modules', '.git', '.data', '.moriko', '.pnpm-store', 'dist', 'build', 'out',
  'coverage', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.zvec-grep',
  '.attachments', 'scripts', 'tests',
]);

const SPATIAL_EXTENSIONS = new Set(['.css', '.tsx', '.jsx']);
const MAX_SPATIAL_FILES = 1200;
const MAX_SPATIAL_BYTES = 1_500_000;
const SPATIAL_CACHE_TTL_MS = 5_000;

interface CachedMap { map: SpatialMap; builtAt: number }
const mapCache = new Map<string, CachedMap>();

function walkSpatialFiles(root: string, acc: string[] = []): string[] {
  if (acc.length >= MAX_SPATIAL_FILES) return acc;
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
    }));
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_SPATIAL_FILES) break;
    if (e.isDir) {
      if (!SPATIAL_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        walkSpatialFiles(path.join(root, e.name), acc);
      }
    } else if (SPATIAL_EXTENSIONS.has(path.extname(e.name))) {
      acc.push(path.join(root, e.name));
    }
  }
  return acc;
}

/**
 * Build a static SpatialMap for a workspace root. Cached 5 s per root so
 * repeated queries inside one tool loop stay instant (deps.ts pattern).
 */
export function spatialMapForRoot(root: string, opts?: { refresh?: boolean }): SpatialMap {
  const cached = mapCache.get(root);
  if (!opts?.refresh && cached && Date.now() - cached.builtAt < SPATIAL_CACHE_TTL_MS) {
    return cached.map;
  }
  const files = walkSpatialFiles(root).slice(0, MAX_SPATIAL_FILES);
  const sources: Array<{ path: string; content: string }> = [];
  for (const abs of files) {
    try {
      const st = statSync(abs);
      if (st.size > MAX_SPATIAL_BYTES) continue;
      sources.push({ path: path.relative(root, abs).replace(/\\/g, '/'), content: readFileSync(abs, 'utf-8') });
    } catch {
    }
  }
  const map = buildSpatialMap(sources);
  mapCache.set(root, { map, builtAt: Date.now() });
  return map;
}


const regionKey = (r: SpatialRegion): string => `${r.file}::${r.id}`;
const collisionKey = (c: SpatialCollision): string => `${c.a}::${c.b}`;

export interface SpatialDiff {
  added: SpatialRegion[];
  removed: SpatialRegion[];
  /** same region id, different rect (line drift alone is NOT a change) */
  changed: Array<{ id: string; file: string; before: SpatialRect | null; after: SpatialRect | null }>;
  newCollisions: SpatialCollision[];
  resolvedCollisions: SpatialCollision[];
}

/** Semantic region/collision diff — "requested change ✔ vs wild change ✘". */
export function diffSpatialMaps(before: SpatialMap, after: SpatialMap): SpatialDiff {
  const beforeById = new Map(before.regions.map((r) => [regionKey(r), r]));
  const afterById = new Map(after.regions.map((r) => [regionKey(r), r]));

  const added: SpatialRegion[] = [];
  const removed: SpatialRegion[] = [];
  const changed: SpatialDiff['changed'] = [];

  for (const [k, r] of afterById) {
    const prev = beforeById.get(k);
    if (!prev) {
      added.push(r);
    } else if (JSON.stringify(prev.rect) !== JSON.stringify(r.rect)) {
      changed.push({ id: r.id, file: r.file, before: prev.rect, after: r.rect });
    }
  }
  for (const [k, r] of beforeById) {
    if (!afterById.has(k)) removed.push(r);
  }

  const beforePairs = new Set(before.collisions.map(collisionKey));
  const afterPairs = new Set(after.collisions.map(collisionKey));
  const newCollisions = after.collisions.filter((c) => !beforePairs.has(collisionKey(c)));
  const resolvedCollisions = before.collisions.filter((c) => !afterPairs.has(collisionKey(c)));

  return { added, removed, changed, newCollisions, resolvedCollisions };
}

const fmtRect = (r: SpatialRect | null): string =>
  r ? `rect(${r.x},${r.y},${r.w},${r.h})` : 'rect(partial)';

/** Compact agent-injectable rendering of a spatial diff. */
export function renderSpatialDiff(diff: SpatialDiff): string {
  const lines: string[] = [];
  lines.push(
    `SPATIAL DIFF (static tier) — ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed · collisions: +${diff.newCollisions.length} new, -${diff.resolvedCollisions.length} resolved`,
  );
  for (const c of diff.changed) {
    lines.push(`  ~ ${c.id} (${c.file}) ${fmtRect(c.before)} → ${fmtRect(c.after)}`);
  }
  for (const r of diff.added) lines.push(`  + ${r.id} (${r.file}:${r.line}) ${fmtRect(r.rect)}`);
  for (const r of diff.removed) lines.push(`  - ${r.id} (${r.file}:${r.line})`);
  for (const c of diff.newCollisions) {
    lines.push(`  ! NEW candidate ${c.severity}: ${c.a} ∩ ${c.b} — overlap(${c.overlap.x},${c.overlap.y},${c.overlap.w},${c.overlap.h})`);
  }
  for (const c of diff.resolvedCollisions) {
    lines.push(`  ✓ resolved: ${c.a} ∩ ${c.b}`);
  }
  return lines.join('\n');
}


export interface SpatialGateVerdict {
  blocked: boolean;
  report: string;
}

/**
 * The F3 gate verdict: compare the before/after maps of one edit. Blocked =
 * the edit CREATED new collision candidates (the requested move itself is
 * fine — only NEW pairs block; a resolved pair is celebrated). Null =
 * nothing spatial-relevant changed, so no report is appended at all.
 */
export function evaluateSpatialGate(before: SpatialMap, after: SpatialMap): SpatialGateVerdict | null {
  const diff = diffSpatialMaps(before, after);
  const spatiallyQuiet =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.newCollisions.length === 0 &&
    diff.resolvedCollisions.length === 0;
  if (spatiallyQuiet) return null;

  if (diff.newCollisions.length === 0) {
    return {
      blocked: false,
      report: `SPATIAL GATE (auto, post-edit) — 0 new collision candidates.\n${renderSpatialDiff(diff)}`,
    };
  }
  return {
    blocked: true,
    report: [
      `SPATIAL GATE (auto, post-edit) — BLOCKED: this edit created ${diff.newCollisions.length} new collision candidate(s).`,
      renderSpatialDiff(diff),
      'Fix the overlapping boxes (agent__layout_edit computes the geometry for you) and re-apply before reporting done. Overlays (modal/tooltip/popover) are exempt.',
    ].join('\n'),
  };
}

/**
 * Drop the cached map for a workspace root (or ALL roots) — every direct
 * file write (edit_file, layout_edit, patch, restore) must invalidate so a
 * subsequent agent__spatial check never serves a stale field map.
 */
export function invalidateSpatialMapCache(root?: string): void {
  if (root === undefined) mapCache.clear();
  else mapCache.delete(root);
}
