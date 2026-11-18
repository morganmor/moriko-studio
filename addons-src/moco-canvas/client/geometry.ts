

import {
  COLS,
  ROWS,
  formatAt,
  intersectCells,
  isFrameLike,
  parseAt,
  pathTo,
  rectHeight,
  rectWidth,
  spacePx,
  type Rect,
  type Scene,
  type SceneNode,
} from './scene.ts';


export const ROW_UNIT = 44;

export interface Placement {
  node: SceneNode;
  
  frame: SceneNode;
  rect: Rect;
}

export interface StackSlot {
  node: SceneNode;
  parent: SceneNode;
  index: number;
}

export interface FrameLattice {
  frame: SceneNode;
  cols: number;
  rows: number;
  placements: Placement[];
  
  contested: Rect[];
  free: number;
  total: number;
}

export function frameCols(frame: SceneNode): number {
  return Math.max(1, Math.min(COLS, frame.layout?.cols ?? COLS));
}

export function frameRows(frame: SceneNode): number {
  const explicit = frame.layout?.rows;
  const maxChildRow = (frame.children ?? []).reduce((max, child) => {
    const rect = parseAt(child.at);
    return rect ? Math.max(max, rect.r2) : max;
  }, 1);
  return Math.max(1, Math.min(ROWS, Math.max(explicit ?? 1, maxChildRow)));
}


export function gridTarget(root: SceneNode, id: string): { node: SceneNode; frame: SceneNode } | null {
  const chain = pathTo(root, id);
  for (let i = chain.length - 1; i > 0; i--) {
    const node = chain[i];
    const parent = chain[i - 1];
    if (parent.layout?.mode === 'grid' && parseAt(node.at)) return { node, frame: parent };
  }
  return null;
}

export function latticeOf(frame: SceneNode): FrameLattice {
  const cols = frameCols(frame);
  const rows = frameRows(frame);
  const placements: Placement[] = [];
  const claimed = new Map<string, string[]>();
  let free = 0;

  for (const child of frame.children ?? []) {
    const rect = parseAt(child.at);
    if (!rect) continue;
    const clamped: Rect = {
      c1: Math.max(1, Math.min(cols, rect.c1)),
      r1: Math.max(1, Math.min(rows, rect.r1)),
      c2: Math.max(1, Math.min(cols, rect.c2)),
      r2: Math.max(1, Math.min(rows, rect.r2)),
    };
    placements.push({ node: child, frame, rect: clamped });
    for (let r = clamped.r1; r <= clamped.r2; r++) {
      for (let c = clamped.c1; c <= clamped.c2; c++) {
        const key = `${c}:${r}`;
        const list = claimed.get(key) ?? [];
        list.push(child.id);
        claimed.set(key, list);
      }
    }
  }

  const contested: Rect[] = [];
  let claimedCells = 0;
  for (const [key, ids] of claimed) {
    claimedCells++;
    if (ids.length > 1) {
      const [c, r] = key.split(':').map(Number);
      contested.push({ c1: c, r1: r, c2: c, r2: r });
    }
  }
  const total = cols * rows;
  free = Math.max(0, total - claimedCells);
  return { frame, cols, rows, placements, contested, free, total };
}


export function gridFrames(root: SceneNode): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (node: SceneNode) => {
    for (const child of node.children ?? []) {
      if (child.kind === 'frame' && child.layout?.mode === 'grid') out.push(child);
      if (isFrameLike(child)) visit(child);
    }
  };
  visit(root);
  return out;
}


export function nodeIndex(root: SceneNode): Array<{ node: SceneNode; parent: SceneNode | null }> {
  const out: Array<{ node: SceneNode; parent: SceneNode | null }> = [];
  const visit = (node: SceneNode, parent: SceneNode | null) => {
    if (node.kind !== 'page') out.push({ node, parent });
    for (const child of node.children ?? []) visit(child, node);
  };
  visit(root, null);
  return out;
}

export function stackSlot(root: SceneNode, id: string): StackSlot | null {
  const chain = pathTo(root, id);
  if (chain.length < 2) return null;
  const parent = chain[chain.length - 2];
  const node = chain[chain.length - 1];
  if (parent.layout?.mode !== 'stack') return null;
  const index = (parent.children ?? []).findIndex((c) => c.id === node.id);
  return index < 0 ? null : { node, parent, index };
}


export function cellsFree(frame: SceneNode, rect: Rect, ignoreId?: string): boolean {
  const lattice = latticeOf(frame);
  return lattice.placements.every((p) => p.node.id === ignoreId || !intersectCells(p.rect, rect));
}


export function nearestFree(frame: SceneNode, rect: Rect, ignoreId?: string): string[] {
  const cols = frameCols(frame);
  const rows = frameRows(frame);
  const out: Array<{ at: string; distance: number }> = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const candidate: Rect = {
        c1: c,
        r1: r,
        c2: Math.min(cols, c + rectWidth(rect) - 1),
        r2: Math.min(rows, r + rectHeight(rect) - 1),
      };
      if (!cellsFree(frame, candidate, ignoreId)) continue;
      const distance = Math.abs(c - rect.c1) + Math.abs(r - rect.r1);
      out.push({ at: formatAt(candidate), distance });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return [...new Set(out.map((o) => o.at))].slice(0, 4);
}


export function firstFree(frame: SceneNode, width: number, height: number, ignoreId?: string): string | null {
  const cols = frameCols(frame);
  const rows = frameRows(frame);
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c + width - 1 <= cols; c++) {
      const candidate: Rect = { c1: c, r1: r, c2: c + width - 1, r2: r + height - 1 };
      if (cellsFree(frame, candidate, ignoreId)) return formatAt(candidate);
    }
  }
  return null;
}


export function weightSplit(frame: SceneNode): { left: number; right: number } | null {
  const lattice = latticeOf(frame);
  if (lattice.placements.length < 2) return null;
  const mid = (lattice.cols + 1) / 2;
  let left = 0;
  let right = 0;
  for (const p of lattice.placements) {
    const area = rectWidth(p.rect) * rectHeight(p.rect);
    const centre = (p.rect.c1 + p.rect.c2) / 2;
    if (centre < mid) left += area;
    else right += area;
  }
  const total = left + right;
  if (total === 0) return null;
  return { left: Math.round((left / total) * 100), right: Math.round((right / total) * 100) };
}
