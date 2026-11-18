

import {
  COLS,
  ROWS,
  SPACE,
  childIndex,
  cloneScene,
  findNode,
  findParent,
  formatAt,
  isFrameLike,
  isSpaceToken,
  parseAt,
  pathTo,
  rectHeight,
  rectWidth,
  sameRect,
  slug,
  spacePx,
  walk,
  constraintStatus,
  type FrameLayout,
  type LayoutMode,
  type NodeKind,
  type NodeStyle,
  type Rect,
  type ResponsiveSpec,
  type ConstraintRule,
  type Constraint,
  type Role,
  type Scene,
  type SceneNode,
} from './scene.ts';
import {
  cellsFree,
  firstFree,
  frameCols,
  frameRows,
  gridTarget,
  latticeOf,
  nearestFree,
} from './geometry.ts';

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y';

export interface PlaceOp {
  op: 'place';
  id: string;
  kind?: NodeKind;
  
  in?: string;
  
  at?: string;
  
  before?: string;
  after?: string;
  role?: Role;
  text?: string;
  maxWidth?: string;
  ratio?: string;
  fit?: 'cover' | 'contain';
  layout?: FrameLayout;
  style?: NodeStyle;
  
  force?: boolean;
}

export interface MoveOp {
  op: 'move';
  id: string;
  
  at?: string;
  
  parent?: string;
  
  index?: number;
  before?: string;
  after?: string;
  force?: boolean;
}

export interface ResizeOp {
  op: 'resize';
  id: string;
  
  w?: number;
  h?: number;
  
  at?: string;
  force?: boolean;
}

export interface SpanOp {
  op: 'span';
  id: string;
  c1: number;
  r1: number;
  c2: number;
  r2: number;
  force?: boolean;
}

export interface AlignOp {
  op: 'align';
  ids: string[];
  edge: AlignEdge;
  
  to?: string;
  force?: boolean;
}

export interface DistributeOp {
  op: 'distribute';
  ids: string[];
  axis: 'x' | 'y';
  force?: boolean;
}

export interface SpaceOp {
  op: 'space';
  between: [string, string];
  gap: string;
}

export interface LayoutOp {
  op: 'stack' | 'grid';
  id: string;
  dir?: 'row' | 'col';
  gap?: string;
  pad?: string;
  align?: FrameLayout['align'];
  justify?: FrameLayout['justify'];
  cols?: number;
  rows?: number;
  wrap?: boolean;
}

export interface GroupOp {
  op: 'group';
  ids: string[];
  id?: string;
  
  at?: string;
}

export interface UngroupOp {
  op: 'ungroup';
  id: string;
}

export interface StyleOp {
  op: 'style';
  id: string;
  color?: string;
  bg?: string;
  radius?: number;
  border?: boolean;
  weight?: number;
  role?: Role;
  maxWidth?: string;
  ratio?: string;
  fit?: 'cover' | 'contain';
  gap?: string;
  pad?: string;
  align?: FrameLayout['align'];
  justify?: FrameLayout['justify'];
}

export interface TextOp {
  op: 'text';
  id: string;
  text: string;
}

export interface SwapOp {
  op: 'swap';
  a: string;
  b: string;
}

export interface DeleteOp {
  op: 'delete';
  id: string;
}

export interface ReorderOp {
  op: 'reorder';
  id: string;
  index?: number;
  before?: string;
  after?: string;
}


export interface LockOp {
  op: 'lock' | 'unlock';
  id: string;
}


export interface ResponsiveOp {
  op: 'responsive';
  id: string;
  
  bp?: 'sm' | 'md' | 'lg';
  
  at?: string;
  
  hide?: boolean;
  maxWidth?: string;
  
  layout?: FrameLayout;
  
  clear?: boolean;
}


export interface ConstrainOp {
  op: 'constrain';
  rule: ConstraintRule;
  
  ids?: string[];
  
  clear?: boolean;
}

export type CanvasOp =
  | PlaceOp | MoveOp | ResizeOp | SpanOp | AlignOp | DistributeOp | SpaceOp
  | LayoutOp | GroupOp | UngroupOp | StyleOp | TextOp | SwapOp | DeleteOp | ReorderOp
  | LockOp | ResponsiveOp | ConstrainOp;


export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export interface OpOutcome {
  note: string;
  
  changed: string[];
}

export interface BatchOutcome {
  ok: boolean;
  scene: Scene;
  
  notes: string[];
  changed: string[];
  
  rejected?: { index: number; op: string; note: string };
}

const KIND_SET = new Set<NodeKind>(['frame', 'text', 'image', 'shape', 'slot', 'ref']);
const ROLE_SET = new Set<Role>(['display', 'heading', 'body', 'caption', 'mono']);
const EDGE_SET = new Set<AlignEdge>(['left', 'right', 'top', 'bottom', 'center-x', 'center-y']);
const SPACE_KEYS = Object.keys(SPACE).join(' ');

function fail(message: string): never {
  throw new OpError(message);
}

function allIds(scene: Scene): string[] {
  const ids: string[] = [];
  const visit = (node: SceneNode) => {
    ids.push(node.id);
    (node.children ?? []).forEach(visit);
  };
  visit(scene.root);
  return ids;
}

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[] = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j < cols; j++) {
      const temp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return dp[cols - 1];
}


function suggestions(target: string, pool: string[]): string[] {
  const t = target.toLowerCase();
  return pool
    .filter((id) => id !== target)
    .map((id) => {
      const lower = id.toLowerCase();
      let score: number;
      if (lower === t) score = 100;
      else if (lower.startsWith(t) || t.startsWith(lower)) score = 60;
      else if (lower.includes(t) || t.includes(lower)) score = 40;
      else score = 20 - Math.min(18, distance(lower, t));
      return { id, score };
    })
    .filter((entry) => entry.score > 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.id);
}

function requireNode(scene: Scene, id: string, what = 'node'): SceneNode {
  const node = findNode(scene.root, id);
  if (!node) {
    const near = suggestions(id, allIds(scene));
    fail(`${what} "${id}" does not exist.${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Use the inspect op to list ids.'}`);
  }
  return node;
}

function requireFrame(scene: Scene, id: string): SceneNode {
  const node = requireNode(scene, id);
  if (!isFrameLike(node)) fail(`"${id}" is a ${node.kind}, not a frame — nodes can only go inside frame/page.`);
  return node;
}

function requireSpaceToken(token: string, field: string): string {
  if (!isSpaceToken(token)) fail(`${field} "${token}" is not a spacing token. Options: ${SPACE_KEYS}.`);
  return token;
}

function uniqueId(scene: Scene, id: string): void {
  if (findNode(scene.root, id)) fail(`id "${id}" is already taken. Pick another (e.g. "${id}-2").`);
}

function parseAtIn(at: string, frame: SceneNode): Rect {
  const rect = parseAt(at);
  if (!rect) fail(`address "${at}" is invalid. Format: column A–L + row, e.g. "B2" or "B2:H5".`);
  const cols = frameCols(frame);
  const rows = frameRows(frame);
  if (rect.c1 > cols || rect.c2 > cols) {
    fail(`address "${at}" is outside grid ${frame.id} (${cols} columns A–${String.fromCharCode(64 + cols)}).`);
  }
  if (rect.r1 > rows + 8 || rect.r2 > rows + 8) {
    fail(`address "${at}" is too far: grid ${frame.id} has ${rows} rows. Grow it first: {op:"grid", id:"${frame.id}", rows:${rect.r2}}.`);
  }
  return rect;
}


function growRows(frame: SceneNode, rect: Rect): void {
  if (!frame.layout) frame.layout = { mode: 'grid' };
  const rows = frame.layout.rows ?? 1;
  if (rect.r2 > rows) frame.layout.rows = Math.min(ROWS + 12, rect.r2);
}

function assertFree(frame: SceneNode, rect: Rect, ignoreId: string | undefined, force: boolean | undefined, action: string): void {
  if (force) return;
  if (cellsFree(frame, rect, ignoreId)) return;
  const blockers = latticeOf(frame)
    .placements.filter((p) => p.node.id !== ignoreId)
    .filter((p) => p.rect.c1 <= rect.c2 && rect.c1 <= p.rect.c2 && p.rect.r1 <= rect.r2 && rect.r1 <= p.rect.r2)
    .map((p) => `${p.node.id} (${formatAt(p.rect)})`);
  const near = nearestFree(frame, rect, ignoreId);
  const hint = near.length
    ? ` Nearest free cells: ${near.join(', ')}.`
    : ` Grid full — grow it: {op:"grid", id:"${frame.id}", rows:${frameRows(frame) + 2}}.`;
  fail(
    `${action} failed: cell ${formatAt(rect)} in ${frame.id} is already occupied by ${blockers.join(', ')}.${hint}` +
      ' Or set force:true for intentional layering.',
  );
}

function defaultNode(op: PlaceOp): SceneNode {
  const kind = op.kind ?? 'text';
  const node: SceneNode = { id: op.id, kind };
  if (op.role) node.role = op.role;
  else if (kind === 'text') node.role = 'body';
  if (op.text !== undefined) node.text = op.text;
  else if (kind === 'text') node.text = op.id;
  if (op.maxWidth) node.maxWidth = op.maxWidth;
  if (op.ratio) node.ratio = op.ratio;
  if (op.fit) node.fit = op.fit;
  if (op.layout) node.layout = { ...op.layout };
  if (op.style) node.style = { ...op.style };
  if (kind === 'frame' || kind === 'slot') {
    node.layout = node.layout ?? { mode: 'stack', dir: 'col', gap: '$s4' };
    node.children = [];
  }
  return node;
}

function insertAt(parent: SceneNode, node: SceneNode, index?: number): void {
  if (!parent.children) parent.children = [];
  const at = typeof index === 'number' ? Math.max(0, Math.min(parent.children.length, index)) : parent.children.length;
  parent.children.splice(at, 0, node);
}

function anchorIndex(parent: SceneNode, op: { before?: string; after?: string }): number | undefined {
  const kids = parent.children ?? [];
  if (op.before) {
    const i = kids.findIndex((c) => c.id === op.before);
    if (i < 0) fail(`before "${op.before}" does not exist in ${parent.id}. Children: ${kids.map((c) => c.id).join(', ') || '—'}.`);
    return i;
  }
  if (op.after) {
    const i = kids.findIndex((c) => c.id === op.after);
    if (i < 0) fail(`after "${op.after}" does not exist in ${parent.id}. Children: ${kids.map((c) => c.id).join(', ') || '—'}.`);
    return i + 1;
  }
  return undefined;
}

function detach(parent: SceneNode, node: SceneNode): void {
  if (!parent.children) return;
  parent.children = parent.children.filter((c) => c.id !== node.id);
}


function isLocked(node: SceneNode): boolean {
  return node.style?.locked === true;
}


function assertNotLocked(scene: Scene, op: CanvasOp, isUser: boolean): void {
  if (isUser) return;
  if (op.op === 'lock' || op.op === 'unlock') return;
  const targets: string[] = [];
  if (op.op === 'swap') targets.push((op as { a: string }).a, (op as { b: string }).b);
  else if (op.op === 'space') targets.push(...(op as { between: [string, string] }).between);
  else if ('ids' in op && Array.isArray((op as { ids?: string[] }).ids)) targets.push(...(op as { ids: string[] }).ids);
  else if ('id' in op && typeof (op as { id?: string }).id === 'string') targets.push((op as { id: string }).id);
  for (const id of targets) {
    const node = findNode(scene.root, id);
    if (!node) continue;
    if (isLocked(node)) {
      fail(
        `"${id}" is LOCKED by the user (plan §12) — the op was rejected, not the batch semantics: agents must not touch locked nodes.` +
          ` Skip it or ask the user to unlock via the panel.`,
      );
    }
    walk(node, (child) => {
      if (isLocked(child)) {
        fail(`"${child.id}" inside "${id}" is LOCKED by the user — agents must not touch it. Ask the user to unlock it via the panel.`);
      }
    });
  }
}

function opLock(scene: Scene, op: LockOp): OpOutcome {
  const node = requireNode(scene, op.id);
  node.style = { ...(node.style ?? {}), locked: op.op === 'lock' };
  return {
    note: `${op.op === 'lock' ? 'locked' : 'unlocked'} ${node.id} against agent mutation`,
    changed: [node.id],
  };
}


function gridContext(scene: Scene, id: string): { node: SceneNode; frame: SceneNode; rect: Rect } | null {
  const target = gridTarget(scene.root, id);
  if (!target) return null;
  const rect = parseAt(target.node.at);
  return rect ? { node: target.node, frame: target.frame, rect } : null;
}

function boundingBox(rects: Rect[]): Rect {
  return rects.reduce<Rect>(
    (acc, r) => ({
      c1: Math.min(acc.c1, r.c1),
      r1: Math.min(acc.r1, r.r1),
      c2: Math.max(acc.c2, r.c2),
      r2: Math.max(acc.r2, r.r2),
    }),
    { ...rects[0] },
  );
}


function opPlace(scene: Scene, op: PlaceOp): OpOutcome {
  uniqueId(scene, op.id);
  if (op.kind && !KIND_SET.has(op.kind)) fail(`kind "${op.kind}" unknown. Options: ${[...KIND_SET].join(', ')}.`);
  if (op.role && !ROLE_SET.has(op.role)) fail(`role "${op.role}" unknown. Options: ${[...ROLE_SET].join(', ')}.`);
  const parent = op.in ? requireFrame(scene, op.in) : scene.root;
  const node = defaultNode(op);

  if (parent.layout?.mode === 'grid') {
    let rect: Rect;
    if (op.at) {
      rect = parseAtIn(op.at, parent);
      assertFree(parent, rect, undefined, op.force, `place "${op.id}"`);
    } else {
      const free = firstFree(parent, 1, 1);
      if (!free) {
        fail(`place "${op.id}" failed: grid ${parent.id} is full (${frameCols(parent)}×${frameRows(parent)}). Grow it: {op:"grid", id:"${parent.id}", rows:${frameRows(parent) + 2}}.`);
      }
      rect = parseAt(free)!;
    }
    node.at = formatAt(rect);
    growRows(parent, rect);
    insertAt(parent, node);
    return { note: `placed ${node.id} (${node.kind}) at ${node.at} in ${parent.id}`, changed: [node.id, parent.id] };
  }

  const index = anchorIndex(parent, op);
  insertAt(parent, node, index);
  const where = typeof index === 'number' ? `#${index + 1}` : `#${(parent.children ?? []).length}`;
  return { note: `placed ${node.id} (${node.kind}) in ${parent.id} ${where}`, changed: [node.id, parent.id] };
}

function opMove(scene: Scene, op: MoveOp): OpOutcome {
  const node = requireNode(scene, op.id);
  const parent = findParent(scene.root, node.id);
  if (!parent) fail(`move "${op.id}" failed: the node is the document root.`);

  if (op.parent && op.parent !== parent.id) {
    const nextParent = requireFrame(scene, op.parent);
    if (pathTo(scene.root, nextParent.id).some((n) => n.id === node.id)) {
      fail(`move "${op.id}" failed: cannot move a frame inside itself.`);
    }
    detach(parent, node);
    if (nextParent.layout?.mode === 'grid') {
      let rect: Rect;
      if (op.at) {
        rect = parseAtIn(op.at, nextParent);
        assertFree(nextParent, rect, undefined, op.force, `move "${op.id}"`);
      } else {
        const free = firstFree(nextParent, 1, 1);
        if (!free) fail(`move "${op.id}" failed: grid ${nextParent.id} is full. Grow rows first.`);
        rect = parseAt(free)!;
      }
      node.at = formatAt(rect);
      growRows(nextParent, rect);
      insertAt(nextParent, node);
      return { note: `moved ${node.id} ${parent.id} → ${nextParent.id} at ${node.at}`, changed: [node.id, parent.id, nextParent.id] };
    }
    delete node.at;
    const idx = anchorIndex(nextParent, op);
    insertAt(nextParent, node, typeof op.index === 'number' ? op.index : idx);
    return { note: `moved ${node.id} ${parent.id} → ${nextParent.id}`, changed: [node.id, parent.id, nextParent.id] };
  }

  if (parent.layout?.mode === 'grid') {
    if (!op.at) fail(`move "${op.id}" requires "at" (a cell address), e.g. {op:"move", id:"${op.id}", at:"H1:L6"}.`);
    let rect = parseAtIn(op.at, parent);
    if (!op.at.includes(':')) {
      const current = parseAt(node.at);
      if (current) {
        rect = { c1: rect.c1, r1: rect.r1, c2: rect.c1 + rectWidth(current) - 1, r2: rect.r1 + rectHeight(current) - 1 };
      }
    }
    const before = node.at;
    assertFree(parent, rect, node.id, op.force, `move "${op.id}"`);
    growRows(parent, rect);
    node.at = formatAt(rect);
    if (before === node.at) fail(`no-op: ${node.id} is already at ${node.at}.`);
    return { note: `moved ${node.id} ${before} → ${node.at}`, changed: [node.id] };
  }

  const kids = parent.children ?? [];
  const from = childIndex(parent, node.id);
  let to = op.index ?? anchorIndex(parent, op);
  if (typeof to !== 'number') fail(`move "${op.id}" in stack ${parent.id} requires index/before/after.`);
  to = Math.max(0, Math.min(kids.length - 1, to));
  if (from === to) fail(`no-op: ${node.id} is already at position #${from + 1}.`);
  const [item] = kids.splice(from, 1);
  kids.splice(to, 0, item);
  return { note: `reordered ${node.id} in ${parent.id} #${from + 1} → #${to + 1}`, changed: [node.id, parent.id] };
}

function opResize(scene: Scene, op: ResizeOp): OpOutcome {
  const ctx = gridContext(scene, op.id);
  if (!ctx) fail(`resize "${op.id}" failed: the node is not inside a grid frame.`);
  const { node, frame, rect } = ctx;
  let next: Rect;
  if (op.at) {
    next = parseAtIn(op.at, frame);
  } else {
    const w = op.w ?? rectWidth(rect);
    const h = op.h ?? rectHeight(rect);
    if (w < 1 || h < 1) fail(`resize "${op.id}" failed: minimum span is 1×1 cells.`);
    const cols = frameCols(frame);
    const c2 = rect.c1 + w - 1;
    if (c2 > cols) {
      fail(`resize "${op.id}" failed: ${w} columns from ${String.fromCharCode(64 + rect.c1)} exceed ${cols} columns. Max ${cols - rect.c1 + 1}.`);
    }
    next = { c1: rect.c1, r1: rect.r1, c2, r2: rect.r1 + h - 1 };
  }
  if (sameRect(rect, next)) fail(`no-op: ${node.id} stays at ${formatAt(rect)}.`);
  assertFree(frame, next, node.id, op.force, `resize "${op.id}"`);
  growRows(frame, next);
  node.at = formatAt(next);
  return { note: `resized ${node.id} ${formatAt(rect)} → ${node.at}`, changed: [node.id, frame.id] };
}

function opSpan(scene: Scene, op: SpanOp): OpOutcome {
  const at = formatAt({ c1: op.c1, r1: op.r1, c2: op.c2, r2: op.r2 });
  return opResize(scene, { op: 'resize', id: op.id, at, force: op.force });
}

function opAlign(scene: Scene, op: AlignOp): OpOutcome {
  if (!EDGE_SET.has(op.edge)) fail(`edge "${op.edge}" unknown. Options: ${[...EDGE_SET].join(', ')}.`);
  const ids = [...new Set(op.ids)];
  if (ids.length === 0) fail('align requires at least one id.');
  const contexts = ids.map((id) => {
    const ctx = gridContext(scene, id);
    if (!ctx) fail(`align failed: "${id}" is not inside a grid frame.`);
    return ctx;
  });
  const frame = contexts[0].frame;
  if (contexts.some((c) => c.frame.id !== frame.id)) {
    fail(`align failed: ${ids.join(', ')} live in different frames (${contexts.map((c) => c.frame.id).join(', ')}).`);
  }
  const cols = frameCols(frame);
  const rows = frameRows(frame);

  let ref: Rect;
  if (op.to) {
    const refCtx = gridContext(scene, op.to);
    if (!refCtx || refCtx.frame.id !== frame.id) fail(`align failed: reference "${op.to}" is not in grid frame ${frame.id}.`);
    ref = refCtx.rect;
  } else {
    ref = { c1: 1, r1: 1, c2: cols, r2: rows };
  }

  const moving = new Set(ids);
  const planned: Rect[] = [];

  for (const ctx of contexts) {
    const w = rectWidth(ctx.rect);
    const h = rectHeight(ctx.rect);
    const next = { ...ctx.rect };
    switch (op.edge) {
      case 'left': next.c1 = ref.c1; next.c2 = ref.c1 + w - 1; break;
      case 'right': next.c2 = ref.c2; next.c1 = ref.c2 - w + 1; break;
      case 'top': next.r1 = ref.r1; next.r2 = ref.r1 + h - 1; break;
      case 'bottom': next.r2 = ref.r2; next.r1 = ref.r2 - h + 1; break;
      case 'center-x': {
        const centre = (ref.c1 + ref.c2) / 2;
        next.c1 = Math.round(centre - (w - 1) / 2);
        next.c2 = next.c1 + w - 1;
        break;
      }
      case 'center-y': {
        const centre = (ref.r1 + ref.r2) / 2;
        next.r1 = Math.round(centre - (h - 1) / 2);
        next.r2 = next.r1 + h - 1;
        break;
      }
    }
    if (next.c1 < 1 || next.c2 > cols) fail(`align ${op.edge} "${ctx.node.id}" out of grid: ${formatAt(next)} vs ${cols} columns.`);
    if (next.r1 < 1) fail(`align ${op.edge} "${ctx.node.id}" out of grid: ${formatAt(next)}.`);
    planned.push(next);
  }

  if (!op.force) {
    const lattice = latticeOf(frame);
    for (let i = 0; i < planned.length; i++) {
      for (let j = i + 1; j < planned.length; j++) {
        const a = planned[i];
        const b = planned[j];
        if (a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2) {
          fail(`align ${op.edge} would stack ${contexts[i].node.id} and ${contexts[j].node.id} at ${formatAt(a)} — their spans differ. Change spans first or set force:true.`);
        }
      }
      const blocked = lattice.placements.find(
        (p) => !moving.has(p.node.id) && p.rect.c1 <= planned[i].c2 && planned[i].c1 <= p.rect.c2 && p.rect.r1 <= planned[i].r2 && planned[i].r1 <= p.rect.r2,
      );
      if (blocked) fail(`align ${op.edge} would move ${contexts[i].node.id} to ${formatAt(planned[i])} which is occupied by ${blocked.node.id}.`);
    }
  }

  const notes: string[] = [];
  const changed: string[] = [frame.id];
  contexts.forEach((ctx, i) => {
    const before = formatAt(ctx.rect);
    const after = formatAt(planned[i]);
    if (before === after) return;
    ctx.node.at = after;
    growRows(frame, planned[i]);
    notes.push(`${ctx.node.id} ${before} → ${after}`);
    changed.push(ctx.node.id);
  });

  if (notes.length === 0) fail(`no-op: ${ids.join(', ')} are already aligned ${op.edge}${op.to ? ` with ${op.to}` : ''}.`);
  return { note: `aligned ${op.edge}: ${notes.join(', ')}`, changed };
}

function opDistribute(scene: Scene, op: DistributeOp): OpOutcome {
  const ids = [...new Set(op.ids)];
  if (ids.length < 3) fail('distribute requires at least 3 nodes (two anchors + at least one to move).');
  const contexts = ids.map((id) => {
    const ctx = gridContext(scene, id);
    if (!ctx) fail(`distribute failed: "${id}" is not inside a grid frame.`);
    return ctx;
  });
  const frame = contexts[0].frame;
  if (contexts.some((c) => c.frame.id !== frame.id)) fail('distribute failed: all nodes must be in the same grid frame.');

  const axis = op.axis === 'y' ? 'y' : 'x';
  const sorted = [...contexts].sort((a, b) => (axis === 'x' ? a.rect.c1 - b.rect.c1 : a.rect.r1 - b.rect.r1));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanTotal = axis === 'x' ? last.rect.c1 - first.rect.c1 : last.rect.r1 - first.rect.r1;
  const step = spanTotal / (sorted.length - 1);
  const moving = new Set(ids);
  const planned: Array<{ ctx: (typeof sorted)[number]; rect: Rect }> = [];

  sorted.forEach((ctx, i) => {
    if (i === 0 || i === sorted.length - 1) return;
    const target = Math.round((axis === 'x' ? first.rect.c1 : first.rect.r1) + step * i);
    const next = { ...ctx.rect };
    if (axis === 'x') {
      next.c1 = target;
      next.c2 = target + rectWidth(ctx.rect) - 1;
    } else {
      next.r1 = target;
      next.r2 = target + rectHeight(ctx.rect) - 1;
    }
    planned.push({ ctx, rect: next });
  });

  if (planned.length === 0) fail('distribute: no middle nodes need to move.');
  if (!op.force) {
    const lattice = latticeOf(frame);
    for (const { ctx, rect } of planned) {
      const blocked = lattice.placements.find(
        (p) => !moving.has(p.node.id) && p.rect.c1 <= rect.c2 && rect.c1 <= p.rect.c2 && p.rect.r1 <= rect.r2 && rect.r1 <= p.rect.r2,
      );
      if (blocked) fail(`distribute ${axis} would place ${ctx.node.id} at ${formatAt(rect)} which is occupied by ${blocked.node.id}.`);
    }
  }

  const notes: string[] = [];
  const changed: string[] = [frame.id];
  for (const { ctx, rect } of planned) {
    const before = formatAt(ctx.rect);
    ctx.node.at = formatAt(rect);
    growRows(frame, rect);
    notes.push(`${ctx.node.id} ${before} → ${ctx.node.at}`);
    changed.push(ctx.node.id);
  }
  return { note: `distributed ${axis} (${sorted.map((c) => c.node.id).join(' · ')}): ${notes.join(', ')}`, changed };
}

function opSpace(scene: Scene, op: SpaceOp): OpOutcome {
  const [aId, bId] = op.between;
  const a = requireNode(scene, aId);
  const b = requireNode(scene, bId);
  const gap = requireSpaceToken(op.gap, 'gap');
  const parentA = findParent(scene.root, a.id);
  const parentB = findParent(scene.root, b.id);
  if (!parentA || !parentB || parentA.id !== parentB.id) {
    fail(`space failed: ${a.id} and ${b.id} are not siblings (parent ${parentA?.id ?? '—'} vs ${parentB?.id ?? '—'}).`);
  }
  if (parentA.layout?.mode === 'stack') {
    const before = parentA.layout.gap ?? '—';
    parentA.layout.gap = gap;
    return { note: `space ${parentA.id}: gap ${before} → ${gap} (${spacePx(gap)}px)`, changed: [parentA.id] };
  }
  const ctxA = gridContext(scene, a.id);
  const ctxB = gridContext(scene, b.id);
  if (!ctxA || !ctxB) fail(`space failed: ${a.id}/${b.id} have no grid address.`);
  const next: Rect = { c1: ctxB.rect.c1, r1: ctxA.rect.r2 + 1, c2: ctxB.rect.c2, r2: ctxA.rect.r2 + rectHeight(ctxB.rect) };
  assertFree(ctxB.frame, next, b.id, false, `space ${a.id} → ${b.id}`);
  growRows(ctxB.frame, next);
  b.at = formatAt(next);
  const gapPx = spacePx(ctxB.frame.layout?.gap) ?? 24;
  return {
    note: `space ${a.id} → ${b.id}: b moved down to ${b.at}; px spacing is governed by the frame gap (${ctxB.frame.layout?.gap ?? '—'} = ${gapPx}px)`,
    changed: [b.id, ctxB.frame.id],
  };
}

function opLayout(scene: Scene, op: LayoutOp): OpOutcome {
  const frame = requireFrame(scene, op.id);
  const mode: LayoutMode = op.op === 'grid' ? 'grid' : 'stack';
  if (op.gap) requireSpaceToken(op.gap, 'gap');
  if (op.pad) requireSpaceToken(op.pad, 'pad');
  if (op.cols !== undefined && (op.cols < 1 || op.cols > COLS)) fail(`cols ${op.cols} out of range 1–${COLS}.`);
  if (op.rows !== undefined && (op.rows < 1 || op.rows > ROWS + 12)) fail(`rows ${op.rows} out of range 1–${ROWS + 12}.`);

  if (mode === 'grid' && frame.layout?.mode !== 'grid') {
    const cols = op.cols ?? COLS;
    const kids = frame.children ?? [];
    kids.forEach((child, i) => {
      const r = i + 1;
      child.at = formatAt({ c1: 1, r1: r, c2: cols, r2: r });
    });
    frame.layout = { mode: 'grid', cols, rows: Math.max(op.rows ?? 1, kids.length), gap: op.gap ?? frame.layout?.gap, pad: op.pad ?? frame.layout?.pad };
  } else {
    frame.layout = {
      ...(frame.layout ?? { mode }),
      mode,
      ...(op.dir ? { dir: op.dir } : {}),
      ...(op.gap ? { gap: op.gap } : {}),
      ...(op.pad ? { pad: op.pad } : {}),
      ...(op.align ? { align: op.align } : {}),
      ...(op.justify ? { justify: op.justify } : {}),
      ...(op.cols !== undefined ? { cols: op.cols } : {}),
      ...(op.rows !== undefined ? { rows: op.rows } : {}),
      ...(op.wrap !== undefined ? { wrap: op.wrap } : {}),
    };
  }
  if (mode === 'stack') for (const child of frame.children ?? []) delete child.at;

  const detail = [
    `mode ${mode}`,
    frame.layout?.cols ? `cols ${frame.layout.cols}` : '',
    frame.layout?.rows ? `rows ${frame.layout.rows}` : '',
    frame.layout?.dir ? `dir ${frame.layout.dir}` : '',
    frame.layout?.gap ? `gap ${frame.layout.gap}` : '',
  ].filter(Boolean).join(' · ');
  return { note: `layout ${frame.id}: ${detail}`, changed: [frame.id, ...(frame.children ?? []).map((c) => c.id)] };
}

function opGroup(scene: Scene, op: GroupOp): OpOutcome {
  const ids = [...new Set(op.ids)];
  if (ids.length < 2) fail('group requires at least 2 nodes.');
  const nodes = ids.map((id) => requireNode(scene, id));
  const parent = findParent(scene.root, nodes[0].id);
  if (!parent) fail('group failed: the first node has no parent.');
  if (nodes.some((n) => findParent(scene.root, n.id)?.id !== parent.id)) {
    fail('group failed: all nodes must be siblings (same parent).');
  }
  const groupId = op.id ?? `group-${slug(ids[0])}`;
  uniqueId(scene, groupId);

  if (parent.layout?.mode === 'grid') {
    const rects = nodes.map((n) => parseAt(n.at));
    if (rects.some((r) => !r)) fail('group in a grid requires every node to have an address.');
    const box = parseAt(op.at) ?? boundingBox(rects as Rect[]);
    const members = new Set(ids);
    const blocked = latticeOf(parent).placements.find(
      (p) => !members.has(p.node.id) && p.rect.c1 <= box.c2 && box.c1 <= p.rect.c2 && p.rect.r1 <= box.r2 && box.r1 <= p.rect.r2,
    );
    if (blocked) fail(`group failed: box ${formatAt(box)} swallows ${blocked.node.id}. Pick a tighter "at" or group adjacent nodes.`);
    const group: SceneNode = {
      id: groupId,
      kind: 'frame',
      at: formatAt(box),
      layout: { mode: 'grid', cols: rectWidth(box), rows: rectHeight(box), gap: parent.layout?.gap ?? '$s5' },
      children: [],
    };
    for (const node of nodes) {
      const rect = parseAt(node.at)!;
      detach(parent, node);
      node.at = formatAt({
        c1: rect.c1 - box.c1 + 1,
        r1: rect.r1 - box.r1 + 1,
        c2: rect.c2 - box.c1 + 1,
        r2: rect.r2 - box.r1 + 1,
      });
      group.children!.push(node);
    }
    insertAt(parent, group);
    return { note: `grouped ${ids.join(' + ')} → ${groupId} at ${group.at}`, changed: [groupId, ...ids, parent.id] };
  }

  const group: SceneNode = { id: groupId, kind: 'frame', layout: { mode: 'stack', dir: 'col', gap: '$s4' }, children: [] };
  const order = [...nodes].sort((a, b) => childIndex(parent, a.id) - childIndex(parent, b.id));
  const anchor = childIndex(parent, order[0].id);
  for (const node of order) detach(parent, node);
  group.children = order;
  insertAt(parent, group, anchor);
  return { note: `grouped ${ids.join(' + ')} → ${groupId} in ${parent.id}`, changed: [groupId, ...ids, parent.id] };
}

function opUngroup(scene: Scene, op: UngroupOp): OpOutcome {
  const frame = requireNode(scene, op.id);
  if (!isFrameLike(frame) || frame.kind === 'page') fail(`ungroup "${op.id}" failed: not a frame.`);
  const parent = findParent(scene.root, frame.id);
  if (!parent) fail(`ungroup "${op.id}" failed: the frame is the root.`);
  const kids = [...(frame.children ?? [])];
  const anchor = childIndex(parent, frame.id);
  const frameRect = parseAt(frame.at);

  if (parent.layout?.mode === 'grid') {
    if (!frameRect) fail(`ungroup "${op.id}" failed: the frame in grid ${parent.id} has no address.`);
    const cols = frameCols(parent);
    const rows = frameRows(parent);
    let band = 0;
    kids.forEach((child) => {
      const rect = parseAt(child.at);
      const next: Rect = rect
        ? {
            c1: Math.min(cols, frameRect.c1 + rect.c1 - 1),
            r1: frameRect.r1 + rect.r1 - 1,
            c2: Math.min(cols, frameRect.c1 + rect.c2 - 1),
            r2: frameRect.r1 + rect.r2 - 1,
          }
        : (() => {
            const r = Math.min(rows, frameRect.r2 + band);
            band++;
            return { c1: frameRect.c1, r1: r, c2: frameRect.c2, r2: r };
          })();
      child.at = formatAt(next);
      growRows(parent, next);
    });
    detach(parent, frame);
    kids.forEach((child, i) => insertAt(parent, child, anchor + i));
    return { note: `ungrouped ${frame.id} → ${kids.length} nodes into ${parent.id} (address from ${formatAt(frameRect)})`, changed: [...kids.map((k) => k.id), parent.id] };
  }


  detach(parent, frame);
  kids.forEach((child, i) => {
    delete child.at;
    insertAt(parent, child, anchor + i);
  });
  return { note: `ungrouped ${frame.id} → ${kids.length} node di ${parent.id}`, changed: [...kids.map((k) => k.id), parent.id] };
}

function opStyle(scene: Scene, op: StyleOp): OpOutcome {
  const node = requireNode(scene, op.id);
  const parts: string[] = [];
  const tokenKeys = Object.keys(scene.tokens).join(', ');
  if (op.color !== undefined) {
    if (!(op.color in scene.tokens)) fail(`color token "${op.color}" does not exist. Scene tokens: ${tokenKeys}.`);
    node.style = { ...(node.style ?? {}), color: op.color };
    parts.push(`color $${op.color}`);
  }
  if (op.bg !== undefined) {
    if (!(op.bg in scene.tokens)) fail(`color token "${op.bg}" does not exist. Scene tokens: ${tokenKeys}.`);
    node.style = { ...(node.style ?? {}), bg: op.bg };
    parts.push(`bg $${op.bg}`);
  }
  if (op.radius !== undefined) {
    if (op.radius < 0 || op.radius > 32) fail(`radius ${op.radius} out of range 0–32.`);
    node.style = { ...(node.style ?? {}), radius: op.radius };
    parts.push(`radius ${op.radius}`);
  }
  if (op.border !== undefined) {
    node.style = { ...(node.style ?? {}), border: op.border };
    parts.push(`border ${op.border ? 'on' : 'off'}`);
  }
  if (op.weight !== undefined) {
    if (op.weight < 100 || op.weight > 900) fail(`weight ${op.weight} out of range 100–900.`);
    node.style = { ...(node.style ?? {}), weight: op.weight };
    parts.push(`weight ${op.weight}`);
  }
  if (op.role !== undefined) {
    if (!ROLE_SET.has(op.role)) fail(`role "${op.role}" unknown. Options: ${[...ROLE_SET].join(', ')}.`);
    node.role = op.role;
    parts.push(`role ${op.role}`);
  }
  if (op.maxWidth !== undefined) {
    if (!/^\d{1,3}ch$/.test(op.maxWidth)) fail(`maxWidth "${op.maxWidth}" must be in ch, e.g. "52ch".`);
    node.maxWidth = op.maxWidth;
    parts.push(`maxWidth ${op.maxWidth}`);
  }
  if (op.ratio !== undefined) {
    if (!/^\d{1,2}\/\d{1,2}$/.test(op.ratio)) fail(`ratio "${op.ratio}" must be "w/h", e.g. "4/5".`);
    node.ratio = op.ratio;
    parts.push(`ratio ${op.ratio}`);
  }
  if (op.fit !== undefined) {
    node.fit = op.fit;
    parts.push(`fit ${op.fit}`);
  }
  if (op.gap !== undefined) {
    requireSpaceToken(op.gap, 'gap');
    if (!node.layout) fail(`style gap on "${op.id}" failed: the node is not a frame.`);
    node.layout.gap = op.gap;
    parts.push(`gap ${op.gap}`);
  }
  if (op.pad !== undefined) {
    requireSpaceToken(op.pad, 'pad');
    if (!node.layout) fail(`style pad on "${op.id}" failed: the node is not a frame.`);
    node.layout.pad = op.pad;
    parts.push(`pad ${op.pad}`);
  }
  if (op.align !== undefined) {
    if (!node.layout) fail(`style align on "${op.id}" failed: the node is not a frame.`);
    node.layout.align = op.align;
    parts.push(`align ${op.align}`);
  }
  if (op.justify !== undefined) {
    if (!node.layout) fail(`style justify on "${op.id}" failed: the node is not a frame.`);
    node.layout.justify = op.justify;
    parts.push(`justify ${op.justify}`);
  }
  if (parts.length === 0) fail('style requires at least one property (color/bg/radius/border/weight/role/maxWidth/ratio/fit/gap/pad/align/justify).');
  return { note: `style ${node.id}: ${parts.join(', ')}`, changed: [node.id] };
}

function opText(scene: Scene, op: TextOp): OpOutcome {
  const node = requireNode(scene, op.id);
  if (node.kind !== 'text' && node.kind !== 'shape' && node.kind !== 'slot' && node.kind !== 'ref') {
    fail(`text "${op.id}" failed: the node is a ${node.kind}. Only text/shape/slot/ref carry text.`);
  }
  if (typeof op.text !== 'string') fail('text requires a string "text".');
  if (op.text.length > 400) fail(`text is ${op.text.length} characters — limit is 400. Split into several nodes.`);
  node.text = op.text;
  return { note: `text ${node.id}: "${op.text.slice(0, 48)}${op.text.length > 48 ? '…' : ''}"`, changed: [node.id] };
}

function opSwap(scene: Scene, op: SwapOp): OpOutcome {
  const a = requireNode(scene, op.a);
  const b = requireNode(scene, op.b);
  if (a.id === b.id) fail('swap requires two different nodes.');
  const parentA = findParent(scene.root, a.id);
  const parentB = findParent(scene.root, b.id);
  if (!parentA || !parentB || parentA.id !== parentB.id) fail('swap failed: both nodes must be siblings.');

  if (parentA.layout?.mode === 'grid') {
    const atA = a.at;
    const atB = b.at;
    if (!atA || !atB) fail('swap failed: both grid nodes must have addresses.');
    a.at = atB;
    b.at = atA;
    return { note: `swapped ${a.id} ${atA} ↔ ${b.id} ${atB}`, changed: [a.id, b.id] };
  }

  const kids = parentA.children ?? [];
  const ia = childIndex(parentA, a.id);
  const ib = childIndex(parentA, b.id);
  kids[ia] = b;
  kids[ib] = a;
  return { note: `swapped order ${a.id} #${ia + 1} ↔ ${b.id} #${ib + 1}`, changed: [a.id, b.id] };
}

function opDelete(scene: Scene, op: DeleteOp): OpOutcome {
  const node = requireNode(scene, op.id);
  const parent = findParent(scene.root, node.id);
  if (!parent) fail(`delete "${op.id}" failed: the node is the document root.`);
  let count = 0;
  const visit = (n: SceneNode) => {
    count++;
    (n.children ?? []).forEach(visit);
  };
  visit(node);
  detach(parent, node);
  return { note: `deleted ${node.id}${count > 1 ? ` (+${count - 1} descendants)` : ''} from ${parent.id}`, changed: [parent.id] };
}

function opReorder(scene: Scene, op: ReorderOp): OpOutcome {
  const node = requireNode(scene, op.id);
  const parent = findParent(scene.root, node.id);
  if (!parent) fail(`reorder "${op.id}" failed: the node is the root.`);
  if (parent.layout?.mode === 'grid') fail(`reorder "${op.id}" failed: ${parent.id} uses a grid — order has no effect. Use move.`);
  const kids = parent.children ?? [];
  const from = childIndex(parent, node.id);
  let to = op.index ?? anchorIndex(parent, op);
  if (typeof to !== 'number') fail('reorder requires index/before/after.');
  to = Math.max(0, Math.min(kids.length - 1, to));
  if (from === to) fail(`no-op: ${node.id} is already at position #${from + 1}.`);
  const [item] = kids.splice(from, 1);
  kids.splice(to, 0, item);
  return { note: `reordered ${node.id} in ${parent.id} #${from + 1} → #${to + 1}`, changed: [node.id, parent.id] };
}


function opResponsive(scene: Scene, op: ResponsiveOp): OpOutcome {
  const node = requireNode(scene, op.id);
  if (op.clear) {
    delete node.responsive;
    return { note: `cleared all responsive overrides on ${node.id}`, changed: [node.id] };
  }
  if (!op.bp || !['sm', 'md', 'lg'].includes(op.bp)) {
    fail('responsive requires a breakpoint: bp:"sm" | "md" | "lg" (lg clears that key).');
  }
  const parts: string[] = [];
  if (op.bp === 'lg') {
    if (node.responsive) delete node.responsive.md;
    return { note: `responsive ${node.id}: cleared md (lg is the base)`, changed: [node.id] };
  }
  if (!op.at && op.hide === undefined && op.maxWidth === undefined && !op.layout) {
    fail('responsive requires at least one override (at / hide / maxWidth / layout).');
  }
  const spec: ResponsiveSpec = {};
  if (op.at !== undefined) {
    const parent = findParent(scene.root, node.id);
    if (parent?.layout?.mode === 'grid') parseAtIn(op.at, parent);
    else fail(`responsive at on "${op.id}" failed: ${parent?.id ?? '—'} is not a grid — addresses only apply in grid frames.`);
    spec.at = op.at;
    parts.push(`at ${op.at}`);
  }
  if (op.hide !== undefined) {
    spec.hide = op.hide;
    parts.push(op.hide ? 'hidden' : 'shown');
  }
  if (op.maxWidth !== undefined) {
    spec.maxWidth = op.maxWidth;
    parts.push(`maxWidth ${op.maxWidth}`);
  }
  if (op.layout) {
    if (!isFrameLike(node)) fail(`responsive layout on "${op.id}" failed: the node is a ${node.kind} — layout is frame-only.`);
    spec.layout = {};
    for (const key of ['cols', 'rows', 'dir', 'gap', 'pad', 'align', 'justify', 'wrap'] as const) {
      const value = op.layout[key];
      if (value !== undefined) (spec.layout as Record<string, unknown>)[key] = value;
    }
    if (spec.layout.gap !== undefined) requireSpaceToken(spec.layout.gap, 'gap');
    if (spec.layout.pad !== undefined) requireSpaceToken(spec.layout.pad, 'pad');
    parts.push(`layout {${Object.keys(spec.layout).join(', ')}}`);
  }
  node.responsive = { ...(node.responsive ?? {}), [op.bp]: spec };
  return { note: `responsive ${node.id} @${op.bp}: ${parts.join(', ')}`, changed: [node.id] };
}


function opConstrain(scene: Scene, op: ConstrainOp): OpOutcome {
  const rule = op.rule;
  if (!['same-left', 'same-height', 'same-gap'].includes(rule)) {
    fail(`constrain needs rule: "same-left" | "same-height" | "same-gap" (got "${String(rule)}").`);
  }
  scene.constraints = scene.constraints ?? [];

  if (op.clear) {
    const before = scene.constraints.length;
    scene.constraints = scene.constraints.filter(
      (c) => !(c.rule === rule && (!op.ids || sameIdSet(c.ids, op.ids))),
    );
    if (scene.constraints.length === before) {
      fail(`no ${rule} constraint${op.ids ? ` on [${op.ids.join(', ')}]` : ''} to clear — read inspect first.`);
    }
    if (!scene.constraints.length) delete scene.constraints;
    return { note: `cleared constraint ${rule}${op.ids ? ` [${op.ids.join(', ')}]` : ''}`, changed: [] };
  }

  const ids = op.ids ?? [];
  if (ids.length < 2) fail(`constrain ${rule} needs ≥2 ids (got ${ids.length}) — a relation is between nodes.`);
  if (new Set(ids).size !== ids.length) fail(`constrain ${rule}: ids must be unique — got [${ids.join(', ')}].`);
  for (const id of ids) requireNode(scene, id);

  const candidate: Constraint = { rule, ids };
  const status = constraintStatus(scene, candidate);
  if (!status.ok) {
    fail(
      `constrain ${rule} rejected: the relation does not hold yet — ${status.detail}. ` +
        `There is no solver (plan §7.3): fix the geometry first (e.g. {op:"align", ids:[${ids.join(', ')}], edge:"left"}), then constrain.`,
    );
  }
  const dup = scene.constraints.find((c) => c.rule === rule && sameIdSet(c.ids, ids));
  if (dup) return { note: `constraint ${rule} [${ids.join(', ')}] already stored`, changed: [] };
  scene.constraints.push(candidate);
  return { note: `constrained ${rule} [${ids.join(', ')}] — held across future ops`, changed: ids };
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function applyOne(scene: Scene, op: CanvasOp): OpOutcome {
  switch (op.op) {
    case 'place': return opPlace(scene, op);
    case 'move': return opMove(scene, op);
    case 'resize': return opResize(scene, op);
    case 'span': return opSpan(scene, op);
    case 'align': return opAlign(scene, op);
    case 'distribute': return opDistribute(scene, op);
    case 'space': return opSpace(scene, op);
    case 'stack':
    case 'grid': return opLayout(scene, op);
    case 'group': return opGroup(scene, op);
    case 'ungroup': return opUngroup(scene, op);
    case 'style': return opStyle(scene, op);
    case 'text': return opText(scene, op);
    case 'swap': return opSwap(scene, op);
    case 'delete': return opDelete(scene, op);
    case 'reorder': return opReorder(scene, op);
    case 'lock':
    case 'unlock': return opLock(scene, op as LockOp);
    case 'responsive': return opResponsive(scene, op as ResponsiveOp);
    case 'constrain': return opConstrain(scene, op as ConstrainOp);
    default: return fail(`op "${(op as { op?: string }).op ?? '?'}" is unknown.`);
  }
}


export function applyOp(scene: Scene, op: CanvasOp): { scene: Scene; note: string; ok: boolean; changed: string[] } {
  const outcome = applyBatch(scene, [op]);
  if (!outcome.ok) {
    return { scene, note: outcome.rejected?.note ?? 'rejected', ok: false, changed: [] };
  }
  return { scene: outcome.scene, note: outcome.notes[0] ?? 'ok', ok: true, changed: outcome.changed };
}


export function applyBatch(scene: Scene, ops: CanvasOp[], isUser = false): BatchOutcome {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, scene, notes: [], changed: [], rejected: { index: -1, op: 'batch', note: 'empty batch — send at least one op.' } };
  }
  const next = cloneScene(scene);
  const notes: string[] = [];
  const changed = new Set<string>();
  const held = new Set(
    (scene.constraints ?? [])
      .filter((c) => constraintStatus(scene, c).ok)
      .map((c) => `${c.rule}:${[...c.ids].sort().join(',')}`),
  );

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      assertNotLocked(next, op, isUser);
      const outcome = applyOne(next, op);
      for (const c of next.constraints ?? []) {
        const key = `${c.rule}:${[...c.ids].sort().join(',')}`;
        const status = constraintStatus(next, c);
        if (status.ok) {
          held.add(key);
          continue;
        }
        if (held.has(key)) {
          fail(
            `violates ${c.rule} [${c.ids.join(', ')}] — ${status.detail}. ` +
              `That relation is constrained (plan §7.3): pick a legal move for ALL of them, ` +
              `or drop the relation first: {op:"constrain", rule:"${c.rule}", ids:[${c.ids.join(', ')}], clear:true}.`,
          );
        }
      }
      notes.push(outcome.note);
      outcome.changed.forEach((id) => changed.add(id));
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      const rolledBack = notes.length ? ` — the previous ${notes.length} op(s) were rolled back (atomic batch).` : '';
      return {
        ok: false,
        scene,
        notes: [],
        changed: [],
        rejected: { index: i, op: op?.op ?? '?', note: `op #${i + 1} (${op?.op ?? '?'}) rejected: ${note}${rolledBack}` },
      };
    }
  }

  next.rev = scene.rev + 1;
  return { ok: true, scene: next, notes, changed: [...changed] };
}


export const OP_NAMES: Array<CanvasOp['op']> = [
  'place', 'move', 'resize', 'span', 'align', 'distribute', 'space',
  'stack', 'grid', 'group', 'ungroup', 'style', 'text', 'swap', 'delete', 'reorder',
  'lock', 'unlock', 'responsive', 'constrain',
];
