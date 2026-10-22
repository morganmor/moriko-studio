/**
 * Moco Canvas — React export (P3, plan §8.2).
 *
 * One component per top-level frame, in JSX, mirroring the HTML compiler's
 * class hooks. Managed-region markers (`mcv:begin/end`, §8.3) wrap every
 * region so the agent can paste each one into a project file between them —
 * the agent does the actual file writing via agent__write (adopted decision
 * §19.4-3), keeping the vault, diagnostics, and the slop gate in force.
 */

import { type Scene, type SceneNode } from '../client/scene.ts';

export const regionBegin = (doc: string, region: string, rev: number) =>
  `{/* mcv:begin ${doc}/${region} rev=${rev} */}`;
export const regionEnd = (doc: string, region: string) => `{/* mcv:end ${doc}/${region} */}`;

// ── React compile (mirror of compile.ts's HTML structure) ────────────────────

const kebab = (id: string) => id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

function esc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function jsxProps(node: SceneNode): string {
  const parts: string[] = [];
  if (node.at) parts.push(`at="${node.at}"`);
  if (node.role) parts.push(`role="${node.role}"`);
  if (node.maxWidth) parts.push(`maxWidth="${node.maxWidth}"`);
  if (node.ratio) parts.push(`ratio="${node.ratio}"`);
  if (node.fit) parts.push(`fit="${node.fit}"`);
  if (node.text !== undefined) parts.push(`text="${esc(node.text)}"`);
  if (node.style?.color) parts.push(`color="${node.style.color}"`);
  if (node.style?.bg) parts.push(`bg="${node.style.bg}"`);
  if (typeof node.style?.radius === 'number') parts.push(`radius={${node.style.radius}}`);
  if (node.style?.border) parts.push('border');
  if (node.style?.weight) parts.push(`weight={${node.style.weight}}`);
  return parts.length ? ' ' + parts.join(' ') : '';
}

function jsxNode(node: SceneNode, indent: string): string {
  const props = jsxProps(node);
  const cls = `mcv-node mcvn-${kebab(node.id)}`;
  if (node.layout) {
    const l = node.layout;
    const lProps = [
      l.mode ? `mode="${l.mode}"` : '',
      l.dir ? `dir="${l.dir}"` : '',
      l.gap ? `gap="${l.gap}"` : '',
      l.pad ? `pad="${l.pad}"` : '',
      l.align ? `align="${l.align}"` : '',
      l.justify ? `justify="${l.justify}"` : '',
      l.cols ? `cols={${l.cols}}` : '',
      l.rows ? `rows={${l.rows}}` : '',
    ].filter(Boolean).join(' ');
    const kids = (node.children ?? []).map((c) => jsxNode(c, indent + '  ')).join('\n');
    if (node.kind === 'page') {
      return `${indent}<McPage${props}${lProps ? ' ' + lProps : ''}>\n${kids}\n${indent}</McPage>`;
    }
    return `${indent}<McFrame id="${node.id}"${props}${lProps ? ' ' + lProps : ''}>\n${kids}\n${indent}</McFrame>`;
  }
  if (node.kind === 'text') return `${indent}<McText id="${node.id}"${props} />`;
  if (node.kind === 'image') return `${indent}<McImage id="${node.id}"${props} />`;
  if (node.kind === 'shape') return `${indent}<McShape id="${node.id}"${props} />`;
  if (node.kind === 'slot') return `${indent}<McSlot id="${node.id}"${props} />`;
  return `${indent}<McNode id="${node.id}"${props} />`;
}

export interface ReactExport {
  regions: Array<{ region: string; code: string }>;
  css: string;
  /** runtime glue — a minimal renderer for the Mc* primitives */
  runtime: string;
}

/** Compile a scene into per-frame React region code (no layout math here —
 *  layout lives in the CSS, ids drive the class hooks, mirroring compile.ts). */
export function compileReact(scene: Scene, css: string): ReactExport {
  const list = scene.root.children ?? [];
  const regions = list.map((child) => ({
    region: child.id,
    // The frame IS the region — render the node itself, no extra wrapper.
    code: jsxNode(child, ''),
  }));
  return { regions, css, runtime: MCV_RUNTIME };
}

// ── managed-region markers only (the agent writes files via agent__write) ────

const MCV_RUNTIME = `// Moco Canvas runtime primitives — render the scene graph's compiled layout.
// These are thin div wrappers; all geometry lives in the mcv stylesheet.
export function McFrame(p: React.PropsWithChildren<Record<string, unknown>>) {
  const { children, ...rest } = p;
  return <div {...rest} className={\`mcv-frame \${rest.className ?? ''}\`}>{children}</div>;
}
export function McText({ text, children, ...rest }: any) {
  const Tag: any = rest.role === 'display' || rest.role === 'heading' ? 'h2' : 'p';
  return <Tag {...rest}>{text ?? children}</Tag>;
}
export function McImage(p: any) { return <div {...p} className={\`mcv-img \${p.className ?? ''}\`} />; }
export function McShape({ text, children, ...rest }: any) {
  return <div {...rest} className={\`mcv-cta \${rest.className ?? ''}\`}><span>{text ?? children}</span></div>;
}
export function McSlot({ text, children, ...rest }: any) {
  return <div {...rest} className={\`mcv-slot \${rest.className ?? ''}\`}><span>{text ?? children}</span></div>;
}
export function McNode(p: any) { return <div {...p} />; }
export function McPage(p: React.PropsWithChildren<Record<string, unknown>>) {
  const { children, ...rest } = p;
  return <div {...rest} className={\`mcv-page \${rest.className ?? ''}\`}>{children}</div>;
}`;

// ── P4: Tailwind export (plan §8.2, "opsional, hanya bila proyek user
// memakai Tailwind") — the scene's px spacing scale (4..96, multiples of 4)
// maps cleanly onto Tailwind spacing; responsive overrides become arbitrary
// variants (max-[767px]:, min-[390px]:max-[767px]:). Colours stay token
// references: the agent maps --mcv-* in the project's own CSS variables.

const TAILWIND_SPACE: Record<string, string> = {
  $s1: '1', $s2: '2', $s3: '3', $s4: '4', $s5: '6', $s6: '8',
  $s7: '10', $s8: '12', $s9: '14', $s10: '16', $s11: '20', $s12: '24',
};

const twSpace = (token: string | undefined, fallback: string): string =>
  (token && TAILWIND_SPACE[token]) || fallback;

const bpVariant = {
  sm: 'max-[767px]:',
  md: 'min-[390px]:max-[767px]:',
} as const;

function twClass(node: SceneNode): string {
  const cls: string[] = ['mcv-node', `mcvn-${kebab(node.id)}`];
  if (node.role) {
    const roleCls: Record<string, string> = {
      display: 'font-display text-4xl md:text-6xl leading-[1.02]',
      heading: 'font-display text-2xl md:text-3xl tabular-nums',
      body: 'text-[1.0625rem]',
      caption: 'text-xs tracking-[0.12em] uppercase',
      mono: 'font-mono text-[0.8125rem] tabular-nums',
    };
    cls.push(roleCls[node.role] ?? '');
  }
  if (node.style?.color) cls.push(`text-(--mcv-${node.style.color})`);
  if (node.style?.bg) cls.push(`bg-(--mcv-${node.style.bg})`);
  if (typeof node.style?.radius === 'number') cls.push(`rounded-[${node.style.radius}px]`);
  if (node.style?.border) cls.push('border border-(--mcv-hairline)');
  if (node.style?.weight) cls.push(`font-[${node.style.weight}]`);
  if (node.maxWidth) cls.push(`max-w-[${node.maxWidth}]`);
  // responsive overrides → arbitrary variants
  for (const [bp, spec] of Object.entries(node.responsive ?? {})) {
    const v = bpVariant[bp as keyof typeof bpVariant];
    if (!v) continue;
    if (spec.hide) cls.push(`${v}hidden`);
    if (spec.maxWidth) cls.push(`${v}max-w-[${spec.maxWidth}]`);
  }
  return cls.filter(Boolean).join(' ');
}

function twLayout(node: SceneNode): string {
  const l = node.layout;
  if (!l) return '';
  const cls: string[] = [];
  if (l.mode === 'grid') {
    cls.push('grid', `grid-cols-${l.cols ?? 12}`, 'auto-rows-[minmax(44px,auto)]');
    if (l.gap) cls.push(`gap-${twSpace(l.gap, '6')}`);
    if (l.pad) cls.push(`p-${twSpace(l.pad, '8')}`);
  } else {
    cls.push('flex', l.dir === 'row' ? 'flex-row' : 'flex-col');
    if (l.gap) cls.push(`gap-${twSpace(l.gap, '4')}`);
    if (l.align) cls.push(`items-${l.align === 'start' ? 'start' : l.align === 'end' ? 'end' : l.align}`);
    if (l.justify) cls.push(`justify-${l.justify === 'between' ? 'between' : l.justify}`);
    if (l.wrap) cls.push('flex-wrap');
    if (l.pad) cls.push(`p-${twSpace(l.pad, '4')}`);
  }
  // responsive frame layout overrides
  for (const [bp, spec] of Object.entries(node.responsive ?? {})) {
    const v = bpVariant[bp as keyof typeof bpVariant];
    const rl = spec.layout;
    if (!v || !rl) continue;
    if (rl.dir) cls.push(`${v}${rl.dir === 'row' ? 'flex-row' : 'flex-col'}`);
    if (rl.gap) cls.push(`${v}gap-${twSpace(rl.gap, '4')}`);
    if (rl.pad) cls.push(`${v}p-${twSpace(rl.pad, '4')}`);
    if (rl.cols) cls.push(`${v}grid-cols-${rl.cols}`);
  }
  return cls.join(' ');
}

function escapeJsxText(text: string): string {
  return text.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/{/g, '&#123;').replace(/}/g, '&#125;');
}

function twNode(node: SceneNode, indent: string): string {
  const layout = twLayout(node);
  const cls = twClass(node) + (layout ? ` ${layout}` : '');
  const open = `data-mcv-id="${node.id}" className="${cls}"`;
  const tag = node.kind === 'text' && (node.role === 'display' || node.role === 'heading') ? 'h2' : node.kind === 'text' ? 'p' : 'div';
  const kids = (node.children ?? []).map((c) => twNode(c, indent + '  ')).join('\n');
  if (kids) return `${indent}<${tag} ${open}>\n${kids}\n${indent}</${tag}>`;
  if (node.text !== undefined) return `${indent}<${tag} ${open}>${escapeJsxText(node.text)}</${tag}>`;
  return `${indent}<${tag} ${open} />`;
}

export interface TailwindExport {
  regions: Array<{ region: string; code: string }>;
  /** setup notes the agent must apply in the project (font/colour tokens) */
  notes: string[];
}

/** P4: Tailwind-flavoured JSX per top-level frame (plan §8.2). */
export function compileTailwind(scene: Scene): TailwindExport {
  const regions = (scene.root.children ?? []).map((child) => ({ region: child.id, code: twNode(child, '') }));
  const notes = [
    'font-display → map the scene display font in your @theme (Tailwind v4) or fontFamily config.',
    'Colours reference CSS variables — define --mcv-ink/--mcv-canvas/--mcv-hairline/--mcv-muted/--mcv-accent from the scene tokens.',
    'Spacing maps $s1..$s12 → Tailwind 1..24 (multiples of 4px, see TAILWIND_SPACE).',
  ];
  return { regions, notes };
}
