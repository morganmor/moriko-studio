

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
  
  file: string;
  
  line: number;
  
  rect: SpatialRect | null;
  constraint: SpatialConstraint;
  
  magicNumbers: string[];
  zIndex: number | null;
  
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
  
  url?: string;
  
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



export function intersectionRect(a: SpatialRect, b: SpatialRect): SpatialRect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}


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
  
  nondet: string[];
  zIndex: number | null;
}


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



function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}


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
  
  target: string;
  
  reference?: string;
  
  scale?: number;
  
  axis?: 'x' | 'y' | 'both';
  
  mode?: 'left' | 'top' | 'center-x' | 'center-y' | 'right' | 'bottom';
  
  gap?: number;
}

export interface LayoutIntentEdit {
  file: string;
  
  oldText: string;
  newText: string;
  
  line: number;
}

export interface LayoutIntentPlan {
  edits: LayoutIntentEdit[];
  
  explanation: string[];
  warnings: string[];
}

interface PositionedTarget {
  region: SpatialRegion;
  
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
  
  changed: Array<{ id: string; file: string; before: SpatialRect | null; after: SpatialRect | null }>;
  newCollisions: SpatialCollision[];
  resolvedCollisions: SpatialCollision[];
}


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


export function invalidateSpatialMapCache(root?: string): void {
  if (root === undefined) mapCache.clear();
  else mapCache.delete(root);
}
