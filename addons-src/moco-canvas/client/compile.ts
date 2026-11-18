

import { COLS, SPACE, parseAt, slug, isFrameLike, type Scene, type SceneNode, type ResponsiveSpec } from './scene.ts';
import { frameCols, frameRows, gridFrames, nodeIndex } from './geometry.ts';

const pxNum = (token: string | undefined, fallback: number): number => {
  if (!token) return fallback;
  return SPACE[token] ?? fallback;
};

const px = (token: string | undefined, fallback: number): string => `${pxNum(token, fallback)}px`;

interface AreaBuild {
  css: string[];
  nodeCss: string[];
  collisions: Array<{ a: string; b: string; cell: string }>;
  empty: number;
  total: number;
}

function buildGridFrame(frame: SceneNode): AreaBuild {
  const cols = frameCols(frame);
  const rows = frameRows(frame);
  const matrix: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '.'));
  const collisions: AreaBuild['collisions'] = [];
  const nodeCss: string[] = [];
  const placed: Array<{ name: string; rect: { c1: number; r1: number; c2: number; r2: number } }> = [];

  for (const child of frame.children ?? []) {
    const rect = parseAt(child.at);
    if (!rect) continue;
    const name = slug(child.id);
    for (let r = rect.r1; r <= Math.min(rows, rect.r2); r++) {
      for (let c = rect.c1; c <= Math.min(cols, rect.c2); c++) {
        const prev = matrix[r - 1][c - 1];
        if (prev !== '.') collisions.push({ a: prev, b: name, cell: `${String.fromCharCode(64 + c)}${r}` });
        matrix[r - 1][c - 1] = name;
      }
    }
    placed.push({ name, rect });
  }

  const total = rows * cols;
  const empty = matrix.flat().filter((c) => c === '.').length;

  if (collisions.length > 0) {
    for (const { name, rect } of placed) {
      nodeCss.push(
        `.mcv-n-${name}{grid-column:${rect.c1} / ${Math.min(cols, rect.c2) + 1};grid-row:${rect.r1} / ${rect.r2 + 1}}`,
      );
    }
    const css = [
      `.mcv-frame-${slug(frame.id)}{`,
      `  display:grid;`,
      `  grid-template-columns:repeat(${cols},minmax(0,1fr));`,
      `  grid-template-rows:repeat(${rows},minmax(44px,auto));`,
      `  gap:${px(frame.layout?.gap, 24)};`,
      `  padding:${px(frame.layout?.pad, 32)};`,
      `}`,
    ];
    return { css, nodeCss, collisions, empty, total };
  }

  for (const { name } of placed) nodeCss.push(`.mcv-n-${name}{grid-area:${name}}`);

  const areaRows = matrix.map((row) => `    "${row.join(' ')}"`).join('\n');
  const css = [
    `.mcv-frame-${slug(frame.id)}{`,
    `  display:grid;`,
    `  grid-template-columns:repeat(${cols},minmax(0,1fr));`,
    `  grid-template-rows:repeat(${rows},minmax(44px,auto));`,
    `  grid-template-areas:\n${areaRows};`,
    `  gap:${px(frame.layout?.gap, 24)};`,
    `  padding:${px(frame.layout?.pad, 32)};`,
    `}`,
  ];
  return { css, nodeCss, collisions, empty, total };
}

function renderResizeHandles(hasAt: boolean): string {
  if (!hasAt) return '';
  return `<span class="mcv-rh mcv-rh-e" data-mcv-rh="e"></span><span class="mcv-rh mcv-rh-s" data-mcv-rh="s"></span><span class="mcv-rh mcv-rh-se" data-mcv-rh="se"></span>`;
}

function renderGridGuide(cols: number, rows: number): string {
  const cells: string[] = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const addr = `${String.fromCharCode(64 + c)}${r}`;
      cells.push(`<div class="mcv-guide-cell" style="grid-column:${c};grid-row:${r}"><span>${addr}</span></div>`);
    }
  }
  return `<div class="mcv-grid-guide" aria-hidden="true">${cells.join('')}</div>`;
}

function nodeHtml(node: SceneNode, scene: Scene): string {
  const name = slug(node.id);
  const atAttr = node.at ? ` data-mcv-at="${node.at}"` : '';
  const styleVars = styleVarsOf(node, scene);
  const common = `data-mcv-id="${node.id}" data-mcv-kind="${node.kind}"${atAttr} class="mcv-n-${name}`;
  const handles = renderResizeHandles(Boolean(node.at));

  if (node.kind === 'frame') {
    const mode = node.layout?.mode ?? 'stack';
    if (mode === 'grid') {
      const cols = frameCols(node);
      const rows = frameRows(node);
      const gap = pxNum(node.layout?.gap, 24);
      const pad = pxNum(node.layout?.pad, 32);
      const guide = renderGridGuide(cols, rows);
      return `<div ${common} mcv-frame mcv-frame-${name}" data-mcv-frame="${node.id}" data-mcv-cols="${cols}" data-mcv-rows="${rows}" data-mcv-gap="${gap}" data-mcv-pad="${pad}">\n${guide}\n${(node.children ?? []).map((c) => nodeHtml(c, scene)).join('\n')}${handles}\n</div>`;
    }
    const dir = node.layout?.dir === 'row' ? 'row' : 'column';
    const align = node.layout?.align ?? 'stretch';
    const justify = node.layout?.justify ?? 'start';
    const wrap = node.layout?.wrap ? 'wrap' : 'nowrap';
    const vars = `--mcv-gap:${px(node.layout?.gap, 16)};--mcv-dir:${dir};--mcv-align:${align};--mcv-justify:${justify};--mcv-wrap:${wrap}`;
    return `<div ${common} mcv-stack" data-mcv-stack="${node.id}" data-mcv-dir="${dir}" style="${vars}">\n${(node.children ?? []).map((c) => nodeHtml(c, scene)).join('\n')}${handles}\n</div>`;
  }

  if (node.kind === 'text') {
    const tag = node.role === 'display' || node.role === 'heading' ? 'h2' : 'p';
    const maxw = node.maxWidth ? `max-width:${node.maxWidth};` : '';
    const styleAttr = maxw || styleVars ? ` style="${maxw}${styleVars}"` : '';
    return `<${tag} ${common} mcv-role-${node.role ?? 'body'}"${styleAttr}>${escapeHtml(node.text ?? '')}${handles}</${tag}>`;
  }

  if (node.kind === 'image') {
    const ratio = node.ratio ?? '4/5';
    return `<div ${common} mcv-img" style="aspect-ratio:${ratio};--mcv-fit:${node.fit ?? 'cover'};${styleVars}">${handles}</div>`;
  }

  if (node.kind === 'shape') {
    return `<div ${common} mcv-cta"${styleVars ? ` style="${styleVars}"` : ''}><span>${escapeHtml(node.text ?? 'Action')}</span>${handles}</div>`;
  }

  if (node.kind === 'slot') {
    return `<div ${common} mcv-slot" data-mcv-slot="${node.id}"${styleVars ? ` style="${styleVars}"` : ''}><span>${escapeHtml(node.text ?? node.id)}</span>${handles}</div>`;
  }

  return `<div ${common}"${styleVars ? ` style="${styleVars}"` : ''}>${handles}</div>`;
}


function styleVarsOf(node: SceneNode, scene: Scene): string {
  const style = node.style;
  if (!style) return '';
  const parts: string[] = [];
  if (style.color && style.color in scene.tokens) parts.push(`--mcv-fg:var(--mcv-${style.color})`);
  if (style.bg && style.bg in scene.tokens) parts.push(`--mcv-bg:var(--mcv-${style.bg})`);
  if (typeof style.radius === 'number') parts.push(`--mcv-radius:${style.radius}px`);
  if (style.weight) parts.push(`--mcv-weight:${style.weight}`);
  if (style.border) parts.push('--mcv-border:1px solid var(--mcv-hairline)');
  return parts.join(';');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface CompileResult {
  html: string;
  css: string;
  bodyHtml: string;
  collisions: Array<{ a: string; b: string; cell: string }>;
}


function baseCss(scene: Scene): string[] {
  const tokens = Object.entries(scene.tokens)
    .map(([k, v]) => `  --mcv-${k}:${v};`)
    .join('\n');
  return [
    `:root{`,
    tokens,
    `  --mcv-s4:${SPACE.$s4}px;--mcv-s5:${SPACE.$s5}px;--mcv-s6:${SPACE.$s6}px;--mcv-s8:${SPACE.$s8}px;--mcv-s10:${SPACE.$s10}px;`,
    `  --mcv-display:${scene.fonts.display};`,
    `  --mcv-body:${scene.fonts.body};`,
    `}`,
    `*{box-sizing:border-box}`,
    `html,body{margin:0;padding:0;min-height:100%;overflow-x:clip}`,
    `body{background:var(--mcv-canvas);color:var(--mcv-ink);font-family:var(--mcv-body);line-height:1.55;user-select:none;-webkit-user-select:none}`,
    `#mcv-scene-root{min-height:100vh;display:flex;flex-direction:column}`,
    `.mcv-frame{position:relative;border-bottom:1px solid color-mix(in oklch,var(--mcv-hairline) 75%,transparent)}`,
    `h2{font-family:var(--mcv-display);font-weight:600;margin:0;line-height:1.05;letter-spacing:-0.01em}`,
    `p{margin:0}`,
    `.mcv-stack{display:flex;flex-direction:var(--mcv-dir,column);gap:var(--mcv-gap,16px);align-items:var(--mcv-align,stretch);justify-content:var(--mcv-justify,start);flex-wrap:var(--mcv-wrap,nowrap)}`,
    `.mcv-role-display{font-family:var(--mcv-display);font-size:clamp(2.4rem,5vw,4rem);line-height:1.02}`,
    `.mcv-role-heading{font-family:var(--mcv-display);font-size:clamp(1.6rem,3vw,2.4rem);font-variant-numeric:tabular-nums}`,
    `.mcv-role-body{font-size:1.0625rem;color:var(--mcv-ink)}`,
    `.mcv-role-caption{font-size:0.75rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--mcv-muted)}`,
    `.mcv-role-mono{font-family:ui-monospace,monospace;font-size:0.8125rem;letter-spacing:0.01em;font-variant-numeric:tabular-nums}`,
    `.mcv-img{background:repeating-linear-gradient(135deg,var(--mcv-hairline) 0 8px,transparent 8px 16px);border:1px solid var(--mcv-hairline);width:100%;min-height:140px}`,
    `.mcv-cta{display:inline-flex;align-items:center;padding:10px 18px;border:1px solid var(--mcv-ink);border-radius:2px;font-size:0.875rem;letter-spacing:0.02em}`,
    `.mcv-slot{display:grid;place-items:center;border:1px dashed var(--mcv-hairline);color:var(--mcv-muted);font:500 0.75rem/1.4 ui-monospace,monospace;letter-spacing:0.06em;text-transform:uppercase;min-height:72px}`,
    `[data-mcv-id]{color:var(--mcv-fg,inherit);font-weight:var(--mcv-weight,inherit)}`,
    `[data-mcv-id][style*="--mcv-bg"]{background:var(--mcv-bg);border-radius:var(--mcv-radius,0)}`,
    `[data-mcv-id][style*="--mcv-radius"]{border-radius:var(--mcv-radius)}`,
    `[data-mcv-id][style*="--mcv-border"]{border:var(--mcv-border)}`,
  ];
}


function responsiveCss(scene: Scene): string[] {
  const md = scene.breakpoints.md;
  const sm = scene.breakpoints.sm;
  const out: string[] = [];

  const nodeOverrides = (spec: ResponsiveSpec, frameName: string, name: string): string[] => {
    const rules: string[] = [];
    if (spec.hide) rules.push(`  .mcv-n-${name}{display:none}`);
    if (spec.at) {
      const rect = parseAt(spec.at);
      if (rect) rules.push(`  .mcv-frame-${frameName} > .mcv-n-${name}{grid-column:${rect.c1} / ${rect.c2 + 1};grid-row:${rect.r1} / ${rect.r2 + 1}}`);
    }
    if (spec.maxWidth) rules.push(`  .mcv-n-${name}{max-width:${spec.maxWidth}}`);
    return rules;
  };

  const frameOverrides = (spec: ResponsiveSpec, name: string): string[] => {
    const rules: string[] = [];
    const l = spec.layout;
    if (!l) return rules;
    if (l.cols) rules.push(`  .mcv-frame-${name}{grid-template-columns:repeat(${l.cols},minmax(0,1fr))}`);
    if (l.rows) rules.push(`  .mcv-frame-${name}{grid-template-rows:repeat(${l.rows},minmax(44px,auto))}`);
    if (l.gap) rules.push(`  .mcv-frame-${name}{gap:${px(l.gap, 16)}}`);
    if (l.pad) rules.push(`  .mcv-frame-${name}{padding:${px(l.pad, 16)}}`);
    if (l.mode || l.dir || l.align || l.justify || l.wrap) {
      rules.push(
        `  .mcv-frame-${name}{display:${l.mode === 'grid' ? 'grid' : 'flex'}` +
          (l.dir ? `;flex-direction:${l.dir === 'row' ? 'row' : 'column'}` : '') +
          (l.align ? `;align-items:${l.align}` : '') +
          (l.justify ? `;justify-content:${l.justify === 'between' ? 'space-between' : l.justify}` : '') +
          (l.wrap ? `;flex-wrap:wrap` : '') +
          `}`,
      );
    }
    return rules;
  };

  const rulesSm: string[] = [];
  for (const f of gridFrames(scene.root)) {
    const name = slug(f.id);
    const hasPlaced = (f.children ?? []).some((c) => parseAt(c.at));
    rulesSm.push(`  .mcv-frame-${name}{grid-template-columns:1fr;grid-template-areas:none}`);
    if (hasPlaced) rulesSm.push(`  .mcv-frame-${name} > *{grid-area:auto}`);
    rulesSm.push(`  .mcv-frame-${name}{gap:${px(f.layout?.gap, 16)}}`);
  }

  for (const { node, parent } of nodeIndex(scene.root)) {
    const spec = node.responsive?.sm;
    if (!spec) continue;
    const name = slug(node.id);
    const frameName = parent && isFrameLike(parent) ? slug(parent.id) : '';
    rulesSm.push(...nodeOverrides(spec, frameName, name));
    if (isFrameLike(node)) rulesSm.push(...frameOverrides(spec, name));
  }
  out.push(`@media (max-width:${md - 1}px){`, ...rulesSm, `}`);

  const rulesMd: string[] = [];
  for (const { node, parent } of nodeIndex(scene.root)) {
    const spec = node.responsive?.md;
    if (!spec) continue;
    const name = slug(node.id);
    const frameName = parent && isFrameLike(parent) ? slug(parent.id) : '';
    rulesMd.push(...nodeOverrides(spec, frameName, name));
    if (isFrameLike(node)) rulesMd.push(...frameOverrides(spec, name));
  }
  if (rulesMd.length) out.push(`@media (min-width:${sm}px) and (max-width:${md - 1}px){`, ...rulesMd, `}`);
  return out;
}


function overlayCss(): string[] {
  return [
    `[data-mcv-id]{outline:1px dashed color-mix(in oklch,var(--mcv-accent) 42%,transparent);outline-offset:2px;cursor:grab;position:relative;z-index:1;transition:outline-color .12s ease,box-shadow .12s ease}`,
    `[data-mcv-id]:hover{outline:1px solid color-mix(in oklch,var(--mcv-accent) 80%,transparent)}`,
    `[data-mcv-id].mcv-selected{outline:2px solid var(--mcv-accent);outline-offset:2px;z-index:3}`,
    `[data-mcv-id].mcv-dragging{opacity:.88;cursor:grabbing !important;z-index:1000 !important;box-shadow:0 14px 34px -6px rgba(20,16,12,.22),0 0 0 2px var(--mcv-accent);outline:2px solid var(--mcv-accent);will-change:transform;transition:none !important;pointer-events:none}`,
    `[data-mcv-id]::before{content:attr(data-mcv-id);position:absolute;left:-2px;top:-17px;z-index:10;
      font:600 9.5px/1.35 ui-monospace,monospace;letter-spacing:.03em;white-space:nowrap;
      background:var(--mcv-ink);color:var(--mcv-canvas);padding:1px 5px;border-radius:2px 2px 0 0;pointer-events:none;
      opacity:0;transition:opacity .1s ease}`,
    `[data-mcv-id][data-mcv-at]::before{content:attr(data-mcv-id) " · " attr(data-mcv-at)}`,
    `[data-mcv-id]:hover::before,[data-mcv-id].mcv-selected::before,[data-mcv-id].mcv-dragging::before{opacity:1}`,
    `[data-mcv-id].mcv-selected::before,[data-mcv-id].mcv-dragging::before{background:var(--mcv-accent);color:var(--mcv-canvas)}`,
    `.mcv-rh{position:absolute;z-index:12;opacity:0;pointer-events:none;transition:opacity .12s ease}`,
    `[data-mcv-id].mcv-selected > .mcv-rh,[data-mcv-id]:hover > .mcv-rh{opacity:1;pointer-events:auto}`,
    `.mcv-rh-e{top:6px;bottom:6px;right:-5px;width:8px;cursor:ew-resize}`,
    `.mcv-rh-e::after{content:"";position:absolute;top:50%;left:2px;transform:translateY(-50%);width:4px;height:18px;border-radius:2px;background:var(--mcv-accent)}`,
    `.mcv-rh-s{left:6px;right:6px;bottom:-5px;height:8px;cursor:ns-resize}`,
    `.mcv-rh-s::after{content:"";position:absolute;left:50%;top:2px;transform:translateX(-50%);width:18px;height:4px;border-radius:2px;background:var(--mcv-accent)}`,
    `.mcv-rh-se{right:-6px;bottom:-6px;width:12px;height:12px;cursor:nwse-resize;border-radius:2px;background:var(--mcv-accent);border:2px solid var(--mcv-canvas)}`,
    `.mcv-grid-guide{position:absolute;inset:0;display:grid;grid-template-columns:inherit;grid-template-rows:inherit;gap:inherit;padding:inherit;pointer-events:none;z-index:0;opacity:0;transition:opacity .15s ease}`,
    `body[data-mcv-grid="1"] .mcv-grid-guide,.mcv-frame.mcv-frame-dragging > .mcv-grid-guide{opacity:1}`,
    `.mcv-guide-cell{border:1px dashed color-mix(in oklch,var(--mcv-accent) 26%,transparent);background:color-mix(in oklch,var(--mcv-accent) 3%,transparent);border-radius:2px;display:flex;align-items:flex-start;justify-content:flex-end;padding:2px 4px}`,
    `.mcv-guide-cell span{font:500 8.5px/1 ui-monospace,monospace;color:color-mix(in oklch,var(--mcv-accent) 62%,transparent);letter-spacing:.03em}`,
    `.mcv-drop-ghost{position:fixed;z-index:999;pointer-events:none;border:2px solid var(--mcv-accent);background:color-mix(in oklch,var(--mcv-accent) 14%,transparent);border-radius:3px;transition:left .05s cubic-bezier(.2,0,0,1),top .05s cubic-bezier(.2,0,0,1),width .05s cubic-bezier(.2,0,0,1),height .05s cubic-bezier(.2,0,0,1)}`,
    `.mcv-drop-ghost[data-mode="stack"]{height:3px !important;border:0;background:var(--mcv-accent);box-shadow:0 0 0 2px color-mix(in oklch,var(--mcv-accent) 28%,transparent)}`,
    `.mcv-drop-label{position:absolute;right:-2px;top:-20px;background:var(--mcv-accent);color:var(--mcv-canvas);font:600 10px/1.3 ui-monospace,monospace;padding:2px 6px;border-radius:2px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.18)}`,
  ];
}

const INTERACTION_SCRIPT = `(function(){
  var state = null;
  var selectedId = null;

  function parseAt(at){
    if(!at) return null;
    var m = /^([A-L])(\\d{1,2})(?::([A-L])(\\d{1,2}))?$/i.exec(at.trim());
    if(!m) return null;
    var c1 = m[1].toUpperCase().charCodeAt(0) - 64;
    var r1 = parseInt(m[2], 10);
    var c2 = m[3] ? m[3].toUpperCase().charCodeAt(0) - 64 : c1;
    var r2 = m[4] ? parseInt(m[4], 10) : r1;
    return { c1: Math.min(c1,c2), r1: Math.min(r1,r2), c2: Math.max(c1,c2), r2: Math.max(r1,r2) };
  }

  function colLetter(c){ return String.fromCharCode(64 + Math.max(1, Math.min(12, c))); }
  function formatAt(c1, r1, c2, r2){
    var s = colLetter(c1) + r1, e = colLetter(c2) + r2;
    return s === e ? s : s + ':' + e;
  }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  function applySelected(id){
    selectedId = id;
    var prev = document.querySelectorAll('.mcv-selected');
    for(var i=0; i<prev.length; i++) prev[i].classList.remove('mcv-selected');
    if(!id) return;
    var target = document.querySelector('[data-mcv-id="' + id + '"]');
    if(target) target.classList.add('mcv-selected');
  }

  window.__mcvSync = function(opts){
    if(!opts) return;
    if(typeof opts.selected === 'string' || opts.selected === null){
      applySelected(opts.selected);
    }
    if(typeof opts.showGrid === 'boolean'){
      document.body.setAttribute('data-mcv-grid', opts.showGrid ? '1' : '0');
    }
  };

  function frameMetrics(fr){
    var box = fr.getBoundingClientRect();
    var cols = parseInt(fr.getAttribute('data-mcv-cols') || '12', 10);
    var rows = Math.max(1, parseInt(fr.getAttribute('data-mcv-rows') || '1', 10));
    var gap = parseFloat(fr.getAttribute('data-mcv-gap') || '24');
    var pad = parseFloat(fr.getAttribute('data-mcv-pad') || '32');
    var innerW = Math.max(120, box.width - pad * 2);
    var innerH = Math.max(60, box.height - pad * 2);
    var colW = (innerW - gap * (cols - 1)) / cols;
    var rowH = (innerH - gap * (rows - 1)) / rows;
    return { box: box, cols: cols, rows: rows, gap: gap, pad: pad, colW: colW, rowH: rowH };
  }

  function cellAtPoint(m, cx, cy){
    var relX = cx - (m.box.left + m.pad);
    var relY = cy - (m.box.top + m.pad);
    var stepX = Math.max(12, m.colW + m.gap);
    var stepY = Math.max(12, m.rowH + m.gap);
    var c = clamp(Math.floor(relX / stepX) + 1, 1, m.cols);
    var r = clamp(Math.floor(relY / stepY) + 1, 1, m.rows);
    return { col: c, row: r };
  }

  function rectPixels(m, c1, r1, c2, r2){
    var left = m.box.left + m.pad + (c1 - 1) * (m.colW + m.gap);
    var top = m.box.top + m.pad + (r1 - 1) * (m.rowH + m.gap);
    var width = (c2 - c1 + 1) * m.colW + (c2 - c1) * m.gap;
    var height = (r2 - r1 + 1) * m.rowH + (r2 - r1) * m.gap;
    return { left: left, top: top, width: Math.max(24, width), height: Math.max(24, height) };
  }

  function showGhost(px, label, mode){
    var ghost = document.getElementById('mcv-drop-ghost');
    var lbl = document.getElementById('mcv-drop-label');
    if(!ghost || !lbl) return;
    ghost.hidden = false;
    ghost.setAttribute('data-mode', mode || 'grid');
    ghost.style.left = Math.round(px.left) + 'px';
    ghost.style.top = Math.round(px.top) + 'px';
    ghost.style.width = Math.round(px.width) + 'px';
    ghost.style.height = Math.round(px.height) + 'px';
    lbl.textContent = label;
  }

  function hideGhost(){
    var ghost = document.getElementById('mcv-drop-ghost');
    if(ghost) ghost.hidden = true;
  }

  document.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    var rh = e.target.closest('[data-mcv-rh]');
    var el = e.target.closest('[data-mcv-id]');
    if(!el) return;

    var id = el.getAttribute('data-mcv-id');
    applySelected(id);
    parent.postMessage({ type: 'mcv-select', id: id }, '*');

    var fr = el.closest('[data-mcv-frame]');
    if(!fr) return;

    var gridNode = el.closest('[data-mcv-at]');
    var stackParent = (el.parentElement && el.parentElement.hasAttribute('data-mcv-stack')) ? el.parentElement : null;
    var atRect = gridNode ? parseAt(gridNode.getAttribute('data-mcv-at')) : null;
    var m = frameMetrics(fr);
    var startCell = cellAtPoint(m, e.clientX, e.clientY);

    state = {
      pointerId: e.pointerId,
      el: el,
      id: id,
      fr: fr,
      gridNode: gridNode,
      gridNodeId: gridNode ? gridNode.getAttribute('data-mcv-id') : id,
      stackParent: stackParent,
      atRect: atRect,
      rhDir: rh ? rh.getAttribute('data-mcv-rh') : null,
      sx: e.clientX,
      sy: e.clientY,
      grabColOffset: atRect ? (startCell.col - atRect.c1) : 0,
      grabRowOffset: atRect ? (startCell.row - atRect.r1) : 0,
      moved: false,
      action: null
    };

    try { el.setPointerCapture(e.pointerId); } catch(_){}
    e.preventDefault();
  });

  document.addEventListener('pointermove', function(e){
    if(!state) return;
    var dx = e.clientX - state.sx;
    var dy = e.clientY - state.sy;

    if(!state.moved && Math.hypot(dx, dy) > 3){
      state.moved = true;
      state.fr.classList.add('mcv-frame-dragging');
    }
    if(!state.moved) return;

    var m = frameMetrics(state.fr);
    var curCell = cellAtPoint(m, e.clientX, e.clientY);

    // 1. Resize Handle Drag
    if(state.rhDir && state.atRect && state.gridNode){
      state.gridNode.classList.add('mcv-dragging');
      var c1 = state.atRect.c1, r1 = state.atRect.r1;
      var c2 = (state.rhDir === 'e' || state.rhDir === 'se') ? clamp(curCell.col, c1, m.cols) : state.atRect.c2;
      var r2 = (state.rhDir === 's' || state.rhDir === 'se') ? clamp(curCell.row, r1, m.rows) : state.atRect.r2;
      var gpx = rectPixels(m, c1, r1, c2, r2);
      var addr = formatAt(c1, r1, c2, r2);
      showGhost(gpx, state.gridNodeId + ' · resize → ' + addr, 'grid');
      state.action = { type: 'mcv-span', id: state.gridNodeId, c1: c1, r1: r1, c2: c2, r2: r2 };
      parent.postMessage({ type: 'mcv-drag-live', id: state.gridNodeId, detail: 'resize → ' + addr }, '*');
      return;
    }

    // 2. Stack child drag: vertical = reorder in stack; strong horizontal = move parent grid block
    var isHorizontalEscape = state.stackParent && state.gridNode && state.atRect && (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.15);

    if(state.stackParent && !isHorizontalEscape){
      if(state.gridNode) {
        state.gridNode.classList.remove('mcv-dragging');
        state.gridNode.style.transform = '';
      }
      state.el.classList.add('mcv-dragging');
      state.el.style.transform = 'translate3d(' + Math.round(dx * 0.25) + 'px,' + Math.round(dy) + 'px,0)';

      var kids = Array.prototype.slice.call(state.stackParent.children).filter(function(k){ return k.hasAttribute('data-mcv-id'); });
      var toIdx = kids.length - 1;
      for(var i = 0; i < kids.length; i++){
        var kb = kids[i].getBoundingClientRect();
        if(e.clientY < kb.top + kb.height / 2){
          toIdx = i;
          break;
        }
      }
      var targetEl = kids[toIdx] || state.el;
      var tb = targetEl.getBoundingClientRect();
      var fromIdx = kids.indexOf(state.el);
      var lineY = (toIdx <= fromIdx) ? (tb.top - 4) : (tb.bottom + 4);
      showGhost({ left: tb.left, top: lineY, width: tb.width, height: 3 }, state.id + ' → order #' + (toIdx + 1), 'stack');
      state.action = { type: 'mcv-reorder', id: state.id, toIndex: toIdx };
      parent.postMessage({ type: 'mcv-drag-live', id: state.id, detail: 'stack → #' + (toIdx + 1) }, '*');
      return;
    }

    // 3. Grid node drag (direct grid node OR horizontal escape of stack frame)
    if(state.gridNode && state.atRect){
      if(state.el !== state.gridNode){
        state.el.classList.remove('mcv-dragging');
        state.el.style.transform = '';
      }
      state.gridNode.classList.add('mcv-dragging');
      state.gridNode.style.transform = 'translate3d(' + Math.round(dx) + 'px,' + Math.round(dy) + 'px,0)';

      var spanW = state.atRect.c2 - state.atRect.c1;
      var spanH = state.atRect.r2 - state.atRect.r1;
      var nc1 = clamp(curCell.col - state.grabColOffset, 1, m.cols - spanW);
      var nr1 = clamp(curCell.row - state.grabRowOffset, 1, Math.max(1, m.rows - spanH));
      var nc2 = Math.min(m.cols, nc1 + spanW);
      var nr2 = nr1 + spanH;

      var pxRect = rectPixels(m, nc1, nr1, nc2, nr2);
      var nextAddr = formatAt(nc1, nr1, nc2, nr2);
      showGhost(pxRect, state.gridNodeId + ' → ' + nextAddr, 'grid');
      state.action = { type: 'mcv-move', id: state.gridNodeId, col: nc1, row: nr1 };
      parent.postMessage({ type: 'mcv-drag-live', id: state.gridNodeId, detail: (state.atRect ? formatAt(state.atRect.c1, state.atRect.r1, state.atRect.c2, state.atRect.r2) : '') + ' → ' + nextAddr }, '*');
    }
  });

  function finishPointer(e){
    if(!state) return;
    var s = state;
    state = null;
    try { s.el.releasePointerCapture(e.pointerId); } catch(_){}
    s.el.classList.remove('mcv-dragging');
    s.el.style.transform = '';
    if(s.gridNode){
      s.gridNode.classList.remove('mcv-dragging');
      s.gridNode.style.transform = '';
    }
    if(s.fr) s.fr.classList.remove('mcv-frame-dragging');
    hideGhost();
    parent.postMessage({ type: 'mcv-drag-end' }, '*');

    if(s.moved && s.action){
      parent.postMessage(s.action, '*');
    }
  }

  document.addEventListener('pointerup', finishPointer);
  document.addEventListener('pointercancel', finishPointer);
})();`;

export function compileScene(scene: Scene): CompileResult {
  const frameBlocks: string[] = [];
  const nodeRules: string[] = [];
  const collisions: CompileResult['collisions'] = [];

  for (const frame of gridFrames(scene.root)) {
    const built = buildGridFrame(frame);
    frameBlocks.push(built.css.join('\n'));
    nodeRules.push(...built.nodeCss);
    collisions.push(...built.collisions);
  }

  const css = [
    ...baseCss(scene),
    ...frameBlocks,
    ...nodeRules,
    ...responsiveCss(scene),
    ...overlayCss(),
  ].join('\n');

  const bodyHtml = (scene.root.children ?? []).map((c) => nodeHtml(c, scene)).join('\n');
  const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><style id="mcv-compiled-css">
${css}
</style></head>
<body data-mcv-doc="${scene.id}" data-mcv-grid="0">
<div id="mcv-scene-root">
${bodyHtml}
</div>
<div id="mcv-drop-ghost" class="mcv-drop-ghost" hidden><span id="mcv-drop-label" class="mcv-drop-label"></span></div>
<script>
${INTERACTION_SCRIPT}
</script>
</body></html>`;

  return { html, css, bodyHtml, collisions };
}
