

export type NodeKind = 'page' | 'frame' | 'text' | 'image' | 'shape' | 'slot' | 'ref';
export type LayoutMode = 'grid' | 'stack';
export type Role = 'display' | 'heading' | 'body' | 'caption' | 'mono';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'between';


export interface NodeStyle {
  
  color?: string;
  bg?: string;
  radius?: number;
  border?: boolean;
  weight?: number;
  
  locked?: boolean;
  
  hidden?: boolean;
}

export interface FrameLayout {
  mode: LayoutMode;
  
  cols?: number;
  
  rows?: number;
  dir?: 'row' | 'col';
  gap?: string;
  pad?: string;
  align?: Align;
  justify?: Justify;
  wrap?: boolean;
}

export interface SceneNode {
  id: string;
  kind: NodeKind;
  
  at?: string;
  role?: Role;
  text?: string;
  maxWidth?: string;
  ratio?: string;
  fit?: 'cover' | 'contain';
  layout?: FrameLayout;
  style?: NodeStyle;
  children?: SceneNode[];
  
  responsive?: ResponsiveMap;
}


export interface ResponsiveSpec {
  
  at?: string;
  
  hide?: boolean;
  maxWidth?: string;
  
  layout?: Partial<Pick<FrameLayout, 'mode' | 'cols' | 'rows' | 'dir' | 'gap' | 'pad' | 'align' | 'justify' | 'wrap'>>;
}

export type BreakpointKey = 'sm' | 'md';
export type ResponsiveMap = Partial<Record<BreakpointKey, ResponsiveSpec>>;


export type ConstraintRule = 'same-left' | 'same-height' | 'same-gap';

export interface Constraint {
  rule: ConstraintRule;
  ids: string[];
}


export function constraintStatus(scene: Scene, c: Constraint): { ok: boolean; detail: string } {
  const nodes: SceneNode[] = [];
  for (const id of c.ids) {
    const node = findNode(scene.root, id);
    if (!node) return { ok: false, detail: `node "${id}" no longer exists` };
    nodes.push(node);
  }
  const parent = findParent(scene.root, c.ids[0]) ?? scene.root;
  for (const id of c.ids.slice(1)) {
    if ((findParent(scene.root, id) ?? scene.root).id !== parent.id) {
      return { ok: false, detail: `nodes are no longer siblings (different parents)` };
    }
  }
  const mode = parent.layout?.mode ?? 'stack';

  if (c.rule === 'same-left') {
    if (mode === 'grid') {
      const lefts = nodes.map((n) => parseAt(n.at)?.c1);
      if (lefts.some((l) => l === undefined)) return { ok: false, detail: 'a node has no grid address' };
      if (lefts.some((l) => l !== lefts[0])) return { ok: false, detail: `left edges differ (columns ${lefts.join(', ')})` };
      return { ok: true, detail: '' };
    }
    if (parent.layout?.dir === 'row') return { ok: false, detail: 'a row stack places children side by side' };
    const align = parent.layout?.align;
    if (align === 'center' || align === 'end') return { ok: false, detail: `stack align:${align} offsets the left edges` };
    return { ok: true, detail: '' };
  }

  if (c.rule === 'same-height') {
    if (mode === 'grid') {
      const heights = nodes.map((n) => {
        const r = parseAt(n.at);
        return r ? rectHeight(r) : null;
      });
      if (heights.some((h) => h === null)) return { ok: false, detail: 'a node has no grid address' };
      if (heights.some((h) => h !== heights[0])) return { ok: false, detail: `heights differ (${heights.join(', ')} cells)` };
      return { ok: true, detail: '' };
    }
    if (parent.layout?.dir === 'row' && (parent.layout.align ?? 'stretch') === 'stretch') return { ok: true, detail: '' };
    return { ok: false, detail: 'stack heights are content-driven — only a grid or align:stretch guarantees them' };
  }

  if (mode === 'stack') {
    const kids = (parent.children ?? []).map((k) => k.id);
    const idxs = c.ids.map((id) => kids.indexOf(id)).sort((a, b) => a - b);
    const consecutive = idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1);
    if (!consecutive) return { ok: false, detail: 'ids are not consecutive siblings in the stack' };
    return { ok: true, detail: '' };
  }
  const rects = nodes.map((n) => parseAt(n.at));
  if (rects.some((r) => !r)) return { ok: false, detail: 'a node has no grid address' };
  const sorted = [...(rects as Rect[])].sort((a, b) => a.c1 - b.c1 || a.r1 - b.r1);
  const horizontal = sorted.every((r) => r.r1 === sorted[0].r1);
  const holes: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    holes.push(horizontal ? cur.c1 - prev.c2 - 1 : cur.r1 - prev.r2 - 1);
  }
  if (new Set(holes).size > 1) return { ok: false, detail: `gaps differ (${holes.join(', ')} cells)` };
  return { ok: true, detail: '' };
}

export interface Scene {
  version: 1;
  id: string;
  dna: string;
  
  rev: number;
  
  template?: string;
  breakpoints: { sm: number; md: number; lg: number };
  tokens: Record<string, string>;
  fonts: { display: string; body: string };
  root: SceneNode;
  
  constraints?: Constraint[];
}

export interface Rect {
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}


export const SPACE: Record<string, number> = {
  $s1: 4, $s2: 8, $s3: 12, $s4: 16, $s5: 24, $s6: 32,
  $s7: 40, $s8: 48, $s9: 56, $s10: 64, $s11: 80, $s12: 96,
};

export const COLS = 12;
export const ROWS = 12;
export const BREAKPOINTS = { sm: 390, md: 768, lg: 1440 } as const;
export type Viewport = keyof typeof BREAKPOINTS;


export const DNA: Record<string, { tokens: Record<string, string>; fonts: { display: string; body: string } }> = {
  editorial: {
    tokens: {
      canvas: 'oklch(97.5% 0.008 85)',
      ink: 'oklch(24% 0.02 60)',
      accent: 'oklch(52% 0.16 40)',
      hairline: 'oklch(87% 0.01 85)',
      muted: 'oklch(48% 0.02 60)',
    },
    fonts: { display: '"Fraunces", "Playfair Display", serif', body: '"Newsreader", Georgia, serif' },
  },
  neutral: {
    tokens: {
      canvas: 'oklch(98% 0.003 250)',
      ink: 'oklch(22% 0.015 250)',
      accent: 'oklch(55% 0.12 250)',
      hairline: 'oklch(88% 0.006 250)',
      muted: 'oklch(50% 0.01 250)',
    },
    fonts: { display: 'ui-serif, Georgia, serif', body: 'system-ui, sans-serif' },
  },
};

export const DNA_IDS = Object.keys(DNA);

export function dnaOf(id: string) {
  return DNA[id] ?? DNA.editorial;
}


export function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

export function spacePx(token: string | undefined): number | null {
  if (!token) return null;
  const value = SPACE[token];
  return typeof value === 'number' ? value : null;
}

export function isSpaceToken(token: unknown): token is string {
  return typeof token === 'string' && token in SPACE;
}

export function colLetter(c: number): string {
  return String.fromCharCode(64 + Math.max(1, Math.min(COLS, c)));
}

export function colIndex(letter: string): number {
  return letter.toUpperCase().charCodeAt(0) - 64;
}

const AT_RE = /^([A-L])(\d{1,2})(?::([A-L])(\d{1,2}))?$/i;


export function parseAt(at: string | undefined): Rect | null {
  if (!at) return null;
  const m = AT_RE.exec(at.trim());
  if (!m) return null;
  const c1 = colIndex(m[1]);
  const r1 = Number(m[2]);
  const c2 = m[3] ? colIndex(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
}

export function formatAt(rect: Rect): string {
  const start = `${colLetter(rect.c1)}${rect.r1}`;
  const end = `${colLetter(rect.c2)}${rect.r2}`;
  return start === end ? start : `${start}:${end}`;
}

export function rectWidth(rect: Rect): number {
  return rect.c2 - rect.c1 + 1;
}

export function rectHeight(rect: Rect): number {
  return rect.r2 - rect.r1 + 1;
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.c1 === b.c1 && a.r1 === b.r1 && a.c2 === b.c2 && a.r2 === b.r2;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2;
}


export const intersectCells = intersects;

export function clampRect(rect: Rect, cols: number, rows: number): Rect {
  const c1 = Math.max(1, Math.min(cols, rect.c1));
  const c2 = Math.max(c1, Math.min(cols, rect.c2));
  const r1 = Math.max(1, Math.min(rows, rect.r1));
  const r2 = Math.max(r1, rect.r2);
  return { c1, r1, c2, r2 };
}

export function findNode(root: SceneNode, id: string): SceneNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function findParent(root: SceneNode, id: string): SceneNode | null {
  for (const child of root.children ?? []) {
    if (child.id === id) return root;
    const hit = findParent(child, id);
    if (hit) return hit;
  }
  return null;
}


export function pathTo(root: SceneNode, id: string): SceneNode[] {
  const chain: SceneNode[] = [];
  const walkChain = (node: SceneNode): boolean => {
    chain.push(node);
    if (node.id === id) return true;
    for (const child of node.children ?? []) {
      if (walkChain(child)) return true;
    }
    chain.pop();
    return false;
  };
  return walkChain(root) ? chain : [];
}

export function walk(root: SceneNode, fn: (node: SceneNode, parent: SceneNode | null) => void, parent: SceneNode | null = null): void {
  fn(root, parent);
  for (const child of root.children ?? []) walk(child, fn, root);
}

export function collectIds(root: SceneNode): string[] {
  const ids: string[] = [];
  walk(root, (node) => ids.push(node.id));
  return ids;
}

export function cloneScene(scene: Scene): Scene {
  return JSON.parse(JSON.stringify(scene)) as Scene;
}

export function childIndex(parent: SceneNode, id: string): number {
  return (parent.children ?? []).findIndex((c) => c.id === id);
}

export function isFrameLike(node: SceneNode): boolean {
  return node.kind === 'page' || node.kind === 'frame';
}


export function childrenOf(node: SceneNode): SceneNode[] {
  return node.children ?? [];
}


export function effectiveNode(node: SceneNode, viewport: Viewport): SceneNode {
  const specs: ResponsiveSpec[] = [];
  if (node.responsive?.sm) specs.push(node.responsive.sm);
  if (node.responsive?.md && viewport !== 'sm') specs.push(node.responsive.md);
  if (viewport === 'lg' || !specs.length) return node;
  const merged: SceneNode = { ...node };
  for (const spec of specs) {
    if (spec.at) merged.at = spec.at;
    if (spec.maxWidth !== undefined) merged.maxWidth = spec.maxWidth;
    if (spec.layout) merged.layout = { ...(merged.layout ?? { mode: node.layout?.mode ?? 'stack' }), ...spec.layout } as FrameLayout;
    if (spec.hide) merged.style = { ...(merged.style ?? {}), hidden: true } as NodeStyle;
  }
  return merged;
}


export function effectiveScene(scene: Scene, viewport: Viewport): Scene {
  if (viewport === 'lg') return scene;
  const clone = cloneScene(scene);
  walk(clone.root, (node) => {
    const eff = effectiveNode(node, viewport);
    node.at = eff.at;
    node.layout = eff.layout;
    node.maxWidth = eff.maxWidth;
    if ((eff.style as NodeStyle | undefined)?.hidden) node.style = { ...(node.style ?? {}), hidden: true };
  });
  return clone;
}
