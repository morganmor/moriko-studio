

import {
  SPACE,
  constraintStatus,
  effectiveScene,
  formatAt,
  parseAt,
  pathTo,
  rectHeight,
  rectWidth,
  spacePx,
  type Scene,
  type SceneNode,
  type Viewport,
} from './scene.ts';
import {
  frameCols,
  frameRows,
  gridFrames,
  latticeOf,
  nodeIndex,
  stackSlot,
  weightSplit,
  type Placement,
} from './geometry.ts';

export interface IntentLint {
  rule: string;
  severity: 'critical' | 'warn' | 'info';
  node?: string;
  detail: string;
}

export interface Readout {
  header: string;
  charmap: string;
  facts: string[];
  lint: IntentLint[];
  chars: number;
  
  text: string;
}

const GLYPHS = 'ntlcisabdfghjkmpqruvwxyz'.split('');
const MAX_MAP_COLS = 24;
const MAX_MAP_ROWS = 20;

function glyphFor(index: number): string {
  return GLYPHS[index % GLYPHS.length];
}

function legendName(node: SceneNode): string {
  return node.id.length > 14 ? `${node.id.slice(0, 13)}…` : node.id;
}

interface FrameMap {
  lines: string[];
  legend: string;
  overlaps: number;
  empty: number;
  free: number;
}

export function buildCharMap(frame: SceneNode): FrameMap {
  const lattice = latticeOf(frame);
  const cols = Math.min(MAX_MAP_COLS, frameCols(frame));
  const rows = Math.min(MAX_MAP_ROWS, frameRows(frame));
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '.'));
  const glyphs = new Map<string, string>();
  let overlaps = 0;

  lattice.placements.forEach((p, i) => {
    const glyph = glyphFor(i);
    glyphs.set(p.node.id, glyph);
    for (let r = p.rect.r1; r <= Math.min(rows, p.rect.r2); r++) {
      for (let c = p.rect.c1; c <= Math.min(cols, p.rect.c2); c++) {
        if (grid[r - 1][c - 1] !== '.') {
          overlaps++;
          grid[r - 1][c - 1] = '#';
        } else {
          grid[r - 1][c - 1] = glyph;
        }
      }
    }
  });

  const header = ['    ', ...Array.from({ length: cols }, (_, i) => String.fromCharCode(65 + i))].join(' ');
  const lines = grid.map((row, i) => `${String(i + 1).padStart(2, ' ')}  ${row.join(' ')}`);
  const legend = lattice.placements
    .map((p) => `${glyphs.get(p.node.id)}=${legendName(p.node)}`)
    .join('  ');
  const empty = grid.flat().filter((c) => c === '.').length;
  return { lines: [header, ...lines], legend, overlaps, empty, free: lattice.free };
}


function stackMap(frame: SceneNode): string[] {
  const kids = frame.children ?? [];
  const lines = [`  stack ${frame.layout?.dir === 'row' ? 'row' : 'col'} · gap ${frame.layout?.gap ?? '—'} · ${kids.length} item`];
  kids.forEach((child, i) => {
    const text = child.text ? `"${child.text.slice(0, 28)}${child.text.length > 28 ? '…' : ''}"` : child.kind;
    const size = child.role ? ` [${child.role}]` : '';
    lines.push(`  ${String(i + 1).padStart(2, ' ')} ${child.id}${size} ${text}`);
  });
  return lines;
}

function pxOf(token: string | undefined): number | null {
  return spacePx(token);
}


function alignFacts(placements: Placement[]): string[] {
  const out: string[] = [];
  const byLeft = new Map<number, string[]>();
  const byTop = new Map<number, string[]>();
  for (const p of placements) {
    byLeft.set(p.rect.c1, [...(byLeft.get(p.rect.c1) ?? []), p.node.id]);
    byTop.set(p.rect.r1, [...(byTop.get(p.rect.r1) ?? []), p.node.id]);
  }
  for (const [col, ids] of byLeft) {
    if (ids.length > 1) out.push(`ALIGN   ${ids.join(' = ')} .left (column ${String.fromCharCode(64 + col)})  ✓`);
  }
  for (const [row, ids] of byTop) {
    if (ids.length > 1) out.push(`ALIGN   ${ids.join(' = ')} .top (row ${row})  ✓`);
  }
  return out;
}


function flowFacts(placements: Placement[]): string[] {
  if (placements.length < 2) return [];
  const sorted = [...placements].sort((a, b) => a.rect.c1 - b.rect.c1);
  const [a, b] = sorted;
  const spanA = rectWidth(a.rect);
  const spanB = rectWidth(b.rect);
  const total = spanA + spanB;
  const split = `${Math.round((spanA / total) * 100)}/${Math.round((spanB / total) * 100)}`;
  const verdict = Math.abs(spanA - spanB) <= 1 ? '~ symmetric' : '✓ asymmetric';
  return [`FLOW    ${a.node.id} (${formatAt(a.rect)}) | ${b.node.id} (${formatAt(b.rect)}) · width split ${split}  ${verdict}`];
}


function gapFacts(placements: Placement[], frame: SceneNode): string[] {
  const out: string[] = [];
  const frameGap = pxOf(frame.layout?.gap);
  const sorted = [...placements].sort((a, b) => a.rect.r1 - b.rect.r1);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.rect.c1 > prev.rect.c2 || prev.rect.c1 > cur.rect.c2) continue;
    const hole = cur.rect.r1 - prev.rect.r2 - 1;
    if (hole === 0) {
      out.push(`GAP     ${prev.node.id} ↓ ${cur.node.id} 0 empty cells (frame gap ${frame.layout?.gap ?? '—'}${frameGap ? ` = ${frameGap}px` : ''})  ✓`);
    } else if (hole > 0) {
      out.push(`GAP     ${prev.node.id} ↓ ${cur.node.id} ${hole} empty cells  ~ not an intended gap`);
    }
  }
  return out;
}


function textFacts(scene: Scene): string[] {
  const out: string[] = [];
  nodeIndex(scene.root).forEach(({ node }) => {
    if (node.kind !== 'text' || !node.maxWidth) return;
    const ch = Number(node.maxWidth.replace('ch', ''));
    const verdict = ch >= 45 && ch <= 75 ? '✓ (45–75)' : ch > 75 ? '~ too wide' : '~ too narrow';
    out.push(`TEXT    ${node.id} max ${ch}ch  ${verdict}`);
  });
  return out;
}


function typeFact(scene: Scene): string {
  const roles = new Set<string>();
  nodeIndex(scene.root).forEach(({ node }) => {
    if (node.role) roles.add(node.role);
  });
  const verdict = roles.has('display') && roles.has('body') ? '✓ hierarchy' : '~ thin hierarchy';
  return `TYPE    active roles: ${[...roles].join(', ') || '—'}  ${verdict}`;
}


function viewFact(scene: Scene, viewport: Viewport): string {
  const vpPx = scene.breakpoints[viewport];
  const overridden = nodeIndex(scene.root).filter(({ node }) => node.responsive && Object.keys(node.responsive).length > 0);
  const mode = viewport === 'lg' ? 'full grid' : `grid → 1 column ≤${scene.breakpoints.md - 1}px`;
  const p4 = overridden.length ? ` · ${overridden.length} responsive override(s)` : '';
  return `VIEW    @${viewport} · ${vpPx}px · ${mode}${p4}  ✓`;
}


function constraintFacts(scene: Scene): string[] {
  const list = scene.constraints ?? [];
  if (!list.length) return [];
  return list.map((c) => {
    const status = constraintStatus(scene, c);
    return status.ok
      ? `RELATION ${c.rule} [${c.ids.join(', ')}]  ✓ held by structure`
      : `RELATION ${c.rule} [${c.ids.join(', ')}]  ~ broken: ${status.detail}`;
  });
}


function structureFacts(scene: Scene): string[] {
  const out: string[] = [];
  nodeIndex(scene.root).forEach(({ node }) => {
    if (node.kind === 'frame' && node.layout?.mode === 'stack') {
      const placed = (node.children ?? []).filter((c) => c.at);
      if (placed.length > 0) out.push(`STRUCT  ${node.id} is a stack but ${placed.length} children have addresses — the compiler ignores them`);
    }
  });
  return out;
}

function balanceFacts(frame: SceneNode): string[] {
  const split = weightSplit(frame);
  if (!split) return [];
  const verdict = split.left === split.right ? '~ symmetric balance' : '✓ healthy asymmetry';
  return [`BALANCE ${frame.id} left weight ${split.left}% / right ${split.right}%  ${verdict}`];
}


function frameLint(frame: SceneNode): IntentLint[] {
  const out: IntentLint[] = [];
  const lattice = latticeOf(frame);
  const cols = frameCols(frame);

  if (lattice.contested.length > 0) {
    const cells = lattice.contested.slice(0, 4).map((r) => formatAt(r)).join(', ');
    out.push({ rule: 'overlap', severity: 'critical', node: frame.id, detail: `${lattice.contested.length} cells claimed by >1 node in ${frame.id} (${cells}${lattice.contested.length > 4 ? '…' : ''})` });
  }

  for (const p of lattice.placements) {
    const rect = parseAt(p.node.at);
    if (!rect) continue;
    if (rect.c2 > cols) {
      out.push({ rule: 'out-of-bounds', severity: 'critical', node: p.node.id, detail: `${formatAt(rect)} exceeds the ${cols} columns of ${frame.id}` });
    }
    if (p.node.kind === 'text' && p.node.maxWidth) {
      const ch = Number(p.node.maxWidth.replace('ch', ''));
      if (ch > 75) out.push({ rule: 'line-length', severity: 'warn', node: p.node.id, detail: `${ch}ch > 75 (hard to read)` });
    }
    if (p.node.kind === 'frame' && p.node.layout?.mode === 'grid' && (p.node.children ?? []).length === 0) {
      out.push({ rule: 'empty-frame', severity: 'info', node: p.node.id, detail: `grid frame ${p.node.id} is still empty` });
    }
  }

  const gaps = (frame.children ?? []).map((c) => c.layout?.gap).filter(Boolean) as string[];
  for (const gap of gaps) {
    if (!(gap in SPACE)) out.push({ rule: 'off-scale-gap', severity: 'warn', node: frame.id, detail: `gap "${gap}" is off the spacing scale` });
  }

  const bands = lattice.placements.filter((p) => rectHeight(p.rect) >= 1).map((p) => rectWidth(p.rect));
  if (bands.length === 3 && bands.every((b) => b === bands[0])) {
    out.push({ rule: 'symmetry-default', severity: 'warn', node: frame.id, detail: `3 equal-width columns (${bands[0]} cells) — consider asymmetry` });
  }

  return out;
}

function hierarchyLint(scene: Scene): IntentLint[] {
  const roles = new Set<string>();
  nodeIndex(scene.root).forEach(({ node }) => {
    if (node.role) roles.add(node.role);
  });
  if (roles.has('display') && !roles.has('body')) {
    return [{ rule: 'hierarchy-flat', severity: 'warn', detail: 'display without body — the type scale feels flat' }];
  }
  return [];
}

export function buildReadout(scene: Scene, viewport: Viewport = 'lg', focus?: string | null): Readout {
  const projected = effectiveScene(scene, viewport);
  const frames = gridFrames(projected.root);
  const stacks = nodeIndex(projected.root)
    .map(({ node }) => node)
    .filter((node) => node.kind === 'frame' && node.layout?.mode === 'stack' && (node.children ?? []).length > 0);

  const blocks: string[] = [];
  const facts: string[] = [];
  const lint: IntentLint[] = [];
  let overlaps = 0;

  for (const frame of frames) {
    if (focus && focus !== frame.id) continue;
    const map = buildCharMap(frame);
    overlaps += map.overlaps;
    const lattice = latticeOf(frame);
    blocks.push(`▸ ${frame.id} · grid ${frameCols(frame)}×${frameRows(frame)} · ${lattice.placements.length} nodes · ${lattice.free}/${lattice.total} empty cells`);
    blocks.push(...map.lines);
    if (map.legend) blocks.push(`  legend  ${map.legend}`);
    facts.push(...alignFacts(lattice.placements), ...flowFacts(lattice.placements), ...gapFacts(lattice.placements, frame), ...balanceFacts(frame));
    lint.push(...frameLint(frame));
  }

  if (!focus) {
    for (const stack of stacks) blocks.push(`▸ ${stack.id}`, ...stackMap(stack));
    facts.push(...structureFacts(scene));
  }

  facts.push(...textFacts(scene), typeFact(scene), viewFact(scene, viewport), ...constraintFacts(scene));
  lint.push(...hierarchyLint(scene));

  const nodes = nodeIndex(scene.root).length;
  const critical = lint.filter((l) => l.severity === 'critical').length;
  const warn = lint.filter((l) => l.severity === 'warn').length;
  const header = `SCENE ${scene.id} rev ${scene.rev} @${viewport} · dna ${scene.dna} · ${frames.length} grid · ${nodes} node · ${overlaps} overlap · ${critical} critical / ${warn} warn`;

  const charmap = blocks.join('\n');
  const text = [header, '', charmap, '', 'FACTS', ...facts.map((f) => `  ${f}`), '', 'LINT', ...(lint.length ? lint.map((l) => `  [${l.severity}] ${l.rule} — ${l.detail}`) : ['  no intent violations'])]
    .join('\n');
  return { header, charmap, facts, lint, chars: text.length, text };
}

export interface DeltaInput {
  notes: string[];
  changed: string[];
  before: Scene;
  after: Scene;
}

const DELTA_BUDGET = 1500;


export function buildDelta(input: DeltaInput, viewport: Viewport = 'lg'): string {
  const { notes, changed, before, after } = input;
  const beforeLint = buildReadout(before, viewport).lint;
  const afterFull = buildReadout(after, viewport);
  const key = (l: IntentLint) => `${l.rule}|${l.node ?? ''}|${l.detail}`;
  const beforeKeys = new Set(beforeLint.map(key));
  const afterKeys = new Set(afterFull.lint.map(key));
  const added = afterFull.lint.filter((l) => !beforeKeys.has(key(l)));
  const fixed = beforeLint.filter((l) => !afterKeys.has(key(l)));

  const changedSet = new Set(changed);
  const frames = gridFrames(after.root).filter((frame) => {
    if (changedSet.has(frame.id)) return true;
    return (frame.children ?? []).some((child) => changedSet.has(child.id));
  });
  const focusFrame = frames[0] ?? gridFrames(after.root)[0] ?? null;

  const lines: string[] = [];
  lines.push(`DELTA ${after.id} rev ${before.rev}→${after.rev} · ${notes.length} ops · ${changed.length} nodes touched`);
  notes.slice(0, 8).forEach((note) => lines.push(`  · ${note}`));
  if (notes.length > 8) lines.push(`  · (+${notes.length - 8} more ops)`);

  if (focusFrame) {
    const map = buildCharMap(focusFrame);
    lines.push('', `CHAR-MAP ${focusFrame.id} (grid ${frameCols(focusFrame)}×${frameRows(focusFrame)})`);
    lines.push(...map.lines);
    if (map.legend) lines.push(`  legend  ${map.legend}`);
  }

  if (added.length || fixed.length) {
    lines.push('', 'LINT');
    added.slice(0, 6).forEach((l) => lines.push(`  + [${l.severity}] ${l.rule} — ${l.detail}`));
    fixed.slice(0, 6).forEach((l) => lines.push(`  − [${l.severity}] ${l.rule} — ${l.detail}`));
    if (added.length > 6) lines.push(`  + (+${added.length - 6} new)`);
  } else {
    lines.push('', 'LINT  unchanged');
  }

  const facts = afterFull.facts.slice(0, 6);
  if (facts.length) {
    lines.push('', 'FACTS');
    facts.forEach((f) => lines.push(`  ${f}`));
  }

  let text = lines.join('\n');
  if (text.length > DELTA_BUDGET) text = `${text.slice(0, DELTA_BUDGET - 40)}\n… (delta clipped; use the inspect op for the full readout)`;
  return text;
}


export function inspectNode(scene: Scene, id: string): string {
  const chain = pathTo(scene.root, id);
  if (chain.length === 0) return `node "${id}" does not exist. Valid ids: ${nodeIndex(scene.root).map((n) => n.node.id).join(', ')}`;
  const node = chain[chain.length - 1];
  const parent = chain.length > 1 ? chain[chain.length - 2] : null;
  const rect = parseAt(node.at);
  const slot = stackSlot(scene.root, id);
  const lines = [`NODE ${node.id} · ${node.kind}${node.role ? ` · ${node.role}` : ''}`];
  lines.push(`  path    ${chain.map((n) => n.id).join(' › ')}`);
  if (rect) lines.push(`  at      ${formatAt(rect)} (${rectWidth(rect)}×${rectHeight(rect)} cells) in ${parent?.id ?? '—'} (${parent?.layout?.mode ?? '—'})`);
  if (slot) lines.push(`  stack   ${slot.parent.id} order #${slot.index + 1}/${slot.parent.children?.length ?? 1} · gap ${slot.parent.layout?.gap ?? '—'}`);
  if (node.text) lines.push(`  text    "${node.text}"`);
  if (node.maxWidth) lines.push(`  maxWidth ${node.maxWidth}`);
  if (node.ratio) lines.push(`  ratio   ${node.ratio}`);
  if (node.layout) {
    lines.push(`  layout  ${node.layout.mode}${node.layout.dir ? ` ${node.layout.dir}` : ''} · gap ${node.layout.gap ?? '—'} · pad ${node.layout.pad ?? '—'}`);
  }
  if (node.style) lines.push(`  style   ${Object.entries(node.style).filter(([k]) => k !== 'hidden').map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (node.responsive && Object.keys(node.responsive).length) {
    for (const [bp, spec] of Object.entries(node.responsive)) {
      const parts = [
        spec.at ? `at ${spec.at}` : '',
        spec.hide ? 'hidden' : '',
        spec.maxWidth ? `maxWidth ${spec.maxWidth}` : '',
        spec.layout ? `layout{${Object.keys(spec.layout).join(',')}}` : '',
      ].filter(Boolean);
      lines.push(`  resp @${bp}  ${parts.join(' · ')}`);
    }
  }
  if (parent) {
    const siblings = (parent.children ?? []).filter((c) => c.id !== node.id);
    if (siblings.length) lines.push(`  siblings ${siblings.map((s) => `${s.id}${s.at ? `(${s.at})` : ''}`).join(', ')}`);
  }
  return lines.join('\n');
}


export function outline(scene: Scene): string {
  const lines: string[] = [`OUTLINE ${scene.id} rev ${scene.rev} · dna ${scene.dna} · template ${scene.template ?? '—'}`];
  const visit = (node: SceneNode, depth: number) => {
    const pad = '  '.repeat(depth);
    const bits: string[] = [`${node.kind}`];
    if (node.at) bits.push(node.at);
    if (node.role) bits.push(node.role);
    if (node.layout) bits.push(`${node.layout.mode}${node.layout.dir ? `/${node.layout.dir}` : ''}${node.layout.cols ? ` ${node.layout.cols}c` : ''}${node.layout.rows ? `×${node.layout.rows}r` : ''}`);
    if (node.text) bits.push(`"${node.text.slice(0, 32)}${node.text.length > 32 ? '…' : ''}"`);
    lines.push(`${pad}${node.id}  ${bits.join(' · ')}`);
    (node.children ?? []).forEach((child) => visit(child, depth + 1));
  };
  visit(scene.root, 0);
  return lines.join('\n');
}