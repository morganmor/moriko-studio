

import { parseAt, formatAt, type Scene } from '../client/scene.ts';

interface ForeignNode {
  tag: string;
  id: string | null;
  cls: string | null;
  text: string | null;
  
  style: Record<string, string>;
  children: ForeignNode[];
}


function parseFragment(html: string): ForeignNode {
  const voidTags = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source']);
  const root: ForeignNode = { tag: '#root', id: null, cls: null, text: null, style: {}, children: [] };
  const stack: ForeignNode[] = [root];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\/?>(?:([^<]*)?)/g;
  let lastTextEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const [full, tag, attrs, after] = match;
    const closing = full.startsWith('</');
    const top = stack[stack.length - 1];
    if (closing) {
      if (stack.length > 1) stack.pop();
    } else {
      const node: ForeignNode = { tag: tag.toLowerCase(), id: null, cls: null, text: null, style: {}, children: [] };
      const idAttr = /\bid\s*=\s*["']?([^"'\s>]+)/i.exec(attrs ?? '');
      const clsAttr = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs ?? '');
      const styleAttr = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(attrs ?? '');
      if (idAttr) node.id = idAttr[1];
      if (clsAttr) node.cls = clsAttr[1];
      if (styleAttr) {
        for (const decl of styleAttr[1].split(';')) {
          const [prop, ...rest] = decl.split(':');
          if (prop && rest.length) node.style[prop.trim()] = rest.join(':').trim();
        }
      }
      top.children.push(node);
      if (!voidTags.has(node.tag)) stack.push(node);
    }
    if (after && !closing) {
      const text = after.trim();
      if (text) stack[stack.length - 1].text = text.slice(0, 120);
    }
    lastTextEnd = re.lastIndex;
  }
  void lastTextEnd;
  return root;
}


function pxToCell(px: number, unit: number): number {
  return Math.max(1, Math.round(px / unit));
}

function styleCell(style: Record<string, string>): { at: string | null; source: 'grid' | 'absolute' } {
  const left = parseFloat(style.left ?? '');
  const top = parseFloat(style.top ?? '');
  const width = parseFloat(style.width ?? '');
  const height = parseFloat(style.height ?? '');
  if (!Number.isFinite(left) || !Number.isFinite(top)) return { at: null, source: 'grid' };
  const colW = 1440 / 12;
  const c1 = pxToCell(left, colW);
  const c2 = Number.isFinite(width) ? Math.min(12, c1 + pxToCell(width, colW) - 1) : c1;
  const r1 = pxToCell(top, 44);
  const r2 = Number.isFinite(height) ? r1 + pxToCell(height, 44) - 1 : r1;
  const at = formatAt({ c1, r1, c2: Math.max(c1, c2), r2: Math.max(r1, r2) });
  return { at: parseAt(at) ? at : null, source: 'absolute' };
}

function outlineNode(node: ForeignNode, depth: number, lines: string[], stats: { counted: number; absolute: number }): void {
  if (depth > 4 || lines.length > 60) return;
  const { at, source } = styleCell(node.style);
  const label = node.id ?? node.cls?.split(/\s+/)[0] ?? node.tag;
  const kind = ['h1', 'h2', 'h3', 'h4', 'p', 'span'].includes(node.tag) ? 'text' : node.tag === 'img' ? 'image' : 'frame';
  const atPart = at ? ` ${at}` : '';
  if (at) stats.counted++;
  if (source === 'absolute') stats.absolute++;
  const textPart = node.text ? ` "${node.text.slice(0, 40)}${node.text.length > 40 ? '…' : ''}"` : '';
  lines.push(`${'  '.repeat(depth)}- ${label} (${kind})${atPart}${textPart}`);
  for (const child of node.children) outlineNode(child, depth + 1, lines, stats);
}


export function importHtml(scene: Scene, html: string): string {
  const trimmed = html.slice(0, 200_000);
  const root = parseFragment(trimmed);
  const lines: string[] = [];
  const stats = { counted: 0, absolute: 0 };
  const structural = root.children.filter((c) => !['script', 'style', 'meta', 'link', 'head'].includes(c.tag));
  for (const child of structural) outlineNode(child, 0, lines, stats);

  return [
    `IMPORT ${scene.id} (perceive — READ-ONLY, foreign code is never editable through the canvas; plan §8.4)`,
    `parsed ${stats.counted} positioned element(s)${stats.absolute ? ` · ${stats.absolute} via absolute px (guessed cells, 12-col/1440px + 44px rows)` : ' · no absolute positioning found'}`,
    'outline (guessed cell addresses — verify against the real page with measureHtml before treating as truth):',
    ...lines.slice(0, 60),
    lines.length > 60 ? `… (+${lines.length - 60} more)` : '',
    '',
    'Foreign code stays foreign: to restyle it, edit the source file directly (agent tools / layout_edit), then re-import to re-perceive.',
  ].filter(Boolean).join('\n');
}
