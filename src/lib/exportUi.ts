/**
 * exportUi — serializes the LIVE Moriko UI into ONE self-contained HTML file
 * that stays INTERACTIVE for redesign work by humans or other agents:
 *   • every <style> + <link rel=stylesheet> is consolidated into one block
 *   • same-origin fonts/images (CSS url() + <img>) become data: URIs
 *   • app <script>s are stripped — a static, fully editable snapshot
 *   • panels/pages are HARVESTED at export time: every opener is clicked once,
 *     its open-state DOM is stored as <template data-demo-panel|view>, then
 *     closed again — a small vanilla shim re-opens them on click in the file
 *   • HTML/CSS are pretty-printed for hand editing
 * Saved to ui-exports/ on the server AND downloaded by the browser.
 */
import { useStore } from '../store/useStore';

export interface UiExportStats {
  bytes: number;
  styles: number;
  inlined: number;
  external: string[];
  /** Harvested panels (popovers, menus, sheets, drawers). */
  panels: number;
  /** Harvested pages (sidebar views swapped into #workspace). */
  views: number;
}

/** Overlay surfaces that can be harvested (conditional or hidden-until-open). */
const OVERLAY_SEL =
  '[role="menu"],[role="dialog"],[role="listbox"],[data-sheet],div.fixed.inset-0,[data-demo-dock]';
/** Composer wrappers whose FIRST button is the popover trigger. */
const PANEL_WRAPPERS =
  '[data-plus-popover],[data-tools-popover],[data-model-popover],[data-context-popover]';

/* ------------------------------------------------------------ predicates -- */

function isOpener(el: Element): boolean {
  if (el.tagName !== 'BUTTON') return false;
  const b = el as HTMLButtonElement;
  if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
  if (b.hasAttribute('aria-haspopup') || b.hasAttribute('aria-controls')) return true;
  const label = b.getAttribute('aria-label');
  if (label === 'Open navigation' || label === 'Show configuration' || label === 'Mobile Watching') {
    return true;
  }
  const wrap = b.parentElement;
  return !!wrap && wrap.matches(PANEL_WRAPPERS) && wrap.querySelector('button') === b;
}

function collectOpeners(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('button')).filter(isOpener);
}

function nameKey(el: Element): string {
  return ((el.getAttribute('aria-label') || el.textContent) || '').replace(/\s+/g, ' ').trim();
}

/** One host can serve several panels — accumulate space-separated keys. */
function markHost(host: Element | null, key: string): void {
  if (!host) return;
  const keys = (host.getAttribute('data-demo-host') ?? '').split(/\s+/).filter(Boolean);
  if (!keys.includes(key)) host.setAttribute('data-demo-host', [...keys, key].join(' '));
}

/**
 * Page = sidebar nav button that switches #workspace content. Excludes groups
 * (aria-expanded), "New Chat/New Session" (side effects), and everything after
 * the Workspace / Recent Chat sections (those switch workspace or the active
 * conversation — never clicked). Dashboard (footer) is always allowed.
 */
function viewAnchor(root: ParentNode): Element | null {
  for (const b of Array.from(root.querySelectorAll('nav[aria-label="Main"] button'))) {
    if (/^(workspace|recent chat)\b/i.test((b.textContent || '').trim())) return b;
  }
  return null;
}

function collectViewButtons(root: ParentNode): HTMLButtonElement[] {
  const anchor = viewAnchor(root);
  const all = Array.from(
    root.querySelectorAll('nav[aria-label="Main"] button, button[aria-label="Dashboard"]'),
  );
  return all.filter((b): b is HTMLButtonElement => {
    if (b.hasAttribute('aria-expanded') || b.hasAttribute('aria-haspopup')) return false;
    const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
    if (!name || /\bnew\b/i.test(name)) return false;
    if (b.getAttribute('aria-label') === 'Dashboard') return true;
    if (
      anchor &&
      b !== anchor &&
      (anchor.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    ) {
      return false; // sits under Workspace / Recent Chat — off limits
    }
    return true;
  });
}

/* --------------------------------------------------------------- overlays -- */

function overlayNodes(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(OVERLAY_SEL));
}

function outermost(nodes: Element[]): Element[] {
  return nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
}

function isOpenOverlay(n: Element): boolean {
  if (n.getAttribute('aria-hidden') === 'true') return false;
  const c = typeof n.className === 'string' ? n.className : '';
  return !/(^|\s)(invisible|opacity-0)(\s|$)/.test(c);
}

function overlaySig(n: Element): string {
  return `${typeof n.className === 'string' ? n.className : ''}|${n.getAttribute('style') ?? ''}`;
}

/* ----------------------------------------------------------------- timing -- */

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, ms)));
  });
}

function escapeClose(): void {
  for (const target of [window, document]) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
}

async function waitWorkspaceStable(host: Element, ms = 2600): Promise<void> {
  const sig = () =>
    Array.from(host.children)
      .map((c) => `${c.tagName}:${typeof c.className === 'string' ? c.className.slice(0, 40) : ''}`)
      .join('|');
  const start = Date.now();
  let last = sig();
  let stable = 0;
  while (Date.now() - start < ms && stable < 2) {
    await settle(220);
    const s = sig();
    stable = s === last ? stable + 1 : 0;
    last = s;
  }
}

/* -------------------------------------------------------------- harvesting -- */

/** Close anything open + expand collapsed nav sections (baseline = rich, neutral). */
async function prepareLiveState(): Promise<void> {
  for (const el of collectOpeners(document)) {
    if (el.getAttribute('aria-expanded') === 'true') el.click();
  }
  escapeClose();
  await settle(150);

  let clicks = 0;
  for (const el of Array.from(document.querySelectorAll('button'))) {
    if (clicks > 15) break;
    if (el.getAttribute('aria-expanded') !== 'false') continue;
    if (el.hasAttribute('aria-haspopup')) continue;
    const wrap = el.parentElement;
    if (wrap && wrap.matches(PANEL_WRAPPERS)) continue;
    if (el.closest('[data-mw-anchor]')) continue;
    if (!el.closest('nav, aside')) continue;
    clicks += 1;
    el.click();
    await settle(80);
  }
  await settle(400); // CollapseSection content mounts on open
}

/** Click one opener, return outerHTML of overlays it made visible (open state). */
async function harvestPanel(el: HTMLElement): Promise<Element[]> {
  const before = new Map<Element, string>();
  for (const n of overlayNodes(document)) before.set(n, overlaySig(n));
  el.click();
  await settle(180);
  const made: Element[] = [];
  for (const n of overlayNodes(document)) {
    if (!isOpenOverlay(n)) continue;
    const sig = overlaySig(n);
    if (!before.has(n) || before.get(n) !== sig) made.push(n);
  }
  return outermost(made);
}

/** Escape → aria-expanded re-click → last-resort toggle, so nothing stays open. */
async function closePanel(el: HTMLElement): Promise<void> {
  escapeClose();
  await settle(90);
  if (overlayNodes(document).some(isOpenOverlay)) {
    for (const n of overlayNodes(document).filter(isOpenOverlay)) {
      const bd = n.querySelector('[class*="bg-black"]');
      if (bd instanceof HTMLElement) bd.click();
    }
    await settle(90);
  }
  if (el.getAttribute('aria-expanded') === 'true') {
    el.click();
    await settle(90);
  }
  if (overlayNodes(document).some(isOpenOverlay)) {
    try {
      el.click();
    } catch {
      /* already closed */
    }
    await settle(90);
  }
}

/* -------------------------------------------------------------- shim script -- */

/**
 * Vanilla interactivity for the exported file. NO backticks / ${ / </script
 * sequences allowed inside this string (it is inlined into a <script>).
 */
const DEMO_SHIM = `(function () {
  var live = {};
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function q(s, r) { return (r || document).querySelector(s); }
  function openers(k) { return qa('[data-demo="' + k + '"]'); }
  function removeLive(k) {
    var arr = live[k] || [];
    for (var i = 0; i < arr.length; i++) { if (arr[i].parentNode) arr[i].parentNode.removeChild(arr[i]); }
    delete live[k];
    var ops = openers(k);
    for (var j = 0; j < ops.length; j++) ops[j].setAttribute('aria-expanded', 'false');
  }
  function hostFor(k, from) {
    var n = from;
    while (n && n.getAttribute) {
      var a = n.getAttribute('data-demo-host');
      if (a && (' ' + a + ' ').indexOf(' ' + k + ' ') !== -1) return n;
      n = n.parentElement;
    }
    return document.body;
  }
  function openPanel(k, from) {
    var tpls = qa('template[data-demo-panel="' + k + '"]');
    if (!tpls.length) return;
    var target = hostFor(k, from);
    var made = [];
    for (var i = 0; i < tpls.length; i++) {
      var frag = tpls[i].content.cloneNode(true);
      while (frag.firstChild) {
        var n = frag.firstChild;
        frag.removeChild(n);
        if (n.nodeType !== 1) continue;
        n.setAttribute('data-demo-live', k);
        target.appendChild(n);
        made.push(n);
      }
    }
    live[k] = made;
    var ops = openers(k);
    for (var j = 0; j < ops.length; j++) ops[j].setAttribute('aria-expanded', 'true');
  }
  function closeAll() { for (var k in live) removeLive(k); }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var host = t.closest('[data-demo-live]');
    if (host) {
      var k = host.getAttribute('data-demo-live');
      var closeBtn = t.closest('[aria-label="Close"],[aria-label="Back"]');
      var isBackdrop = t.getAttribute && t.getAttribute('aria-hidden') === 'true' &&
        typeof t.className === 'string' && t.className.indexOf('bg-black') !== -1;
      if (closeBtn || isBackdrop) { removeLive(k); return; }
    }
    var tog = t.closest('[data-demo-toggle]');
    if (tog) {
      e.preventDefault(); e.stopPropagation();
      var rail = document.querySelector('[data-demo-rail]');
      if (rail) rail.classList.toggle('demo-collapsed');
      tog.setAttribute('aria-pressed', tog.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      return;
    }
    var opener = t.closest('[data-demo]');
    if (opener) {
      e.preventDefault(); e.stopPropagation();
      var key = opener.getAttribute('data-demo');
      if (live[key]) removeLive(key); else openPanel(key, opener);
      return;
    }
    var vb = t.closest('[data-demo-view]');
    if (vb) {
      e.preventDefault(); e.stopPropagation();
      var id = vb.getAttribute('data-demo-view');
      var tpl = q('template[data-demo-view="' + id + '"]');
      var ws = q('#workspace');
      if (!tpl || !ws) return;
      closeAll();
      var tb = ws.querySelector('[data-demo-topbar]');
      var kids = Array.prototype.slice.call(ws.children);
      var start = tb ? kids.indexOf(tb) + 1 : 1;
      for (var i2 = kids.length - 1; i2 >= start; i2--) ws.removeChild(kids[i2]);
      ws.appendChild(tpl.content.cloneNode(true));
      var all = qa('[data-demo-view]');
      for (var a = 0; a < all.length; a++) all[a].removeAttribute('aria-current');
      vb.setAttribute('aria-current', 'page');
    }
    // Outside click closes any open panel (popover-like).
    for (var kk in live) {
      var arr = live[kk] || [];
      var keep = false;
      if (opener && opener.getAttribute('data-demo') === kk) keep = true;
      for (var a2 = 0; a2 < arr.length; a2++) if (arr[a2].contains(t)) keep = true;
      if (!keep) removeLive(kk);
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
})();`;

/* ------------------------------------------------------------ css / images -- */

async function dataUri(url: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const uri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
  cache.set(url, uri);
  return uri;
}

export async function inlineCssUrls(
  css: string,
  baseUrl: string,
  cache: Map<string, string>,
  stats: UiExportStats,
): Promise<string> {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const raw = m[2].trim();
    out += css.slice(last, m.index);
    last = m.index + m[0].length;
    if (!raw || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('blob:')) {
      out += m[0];
      continue;
    }
    try {
      const abs = new URL(raw, baseUrl).href;
      if (abs.startsWith(location.origin)) {
        out += `url("${await dataUri(abs, cache)}")`;
        stats.inlined += 1;
      } else {
        out += m[0];
        stats.external.push(raw);
      }
    } catch {
      out += m[0];
    }
  }
  return out + css.slice(last);
}

export async function inlineImagesIn(
  root: ParentNode,
  cache: Map<string, string>,
  stats: UiExportStats,
): Promise<void> {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    img.removeAttribute('srcset');
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;
    try {
      const abs = new URL(src, location.href).href;
      if (abs.startsWith(location.origin)) {
        img.setAttribute('src', await dataUri(abs, cache));
        stats.inlined += 1;
      } else {
        stats.external.push(src);
      }
    } catch {
      /* keep original */
    }
  }
}

/** Parse a harvested HTML string: tag its openers + inline images, return html. */
async function finalizeTemplate(
  html: string,
  cache: Map<string, string>,
  stats: UiExportStats,
  nameMap: Map<string, string>,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const btn of Array.from(doc.querySelectorAll('button'))) {
    if (!isOpener(btn)) continue;
    const key = nameMap.get(nameKey(btn));
    if (key) {
      btn.setAttribute('data-demo', key);
      markHost(btn.parentElement, key);
    }
  }
  await inlineImagesIn(doc, cache, stats);
  return doc.body.innerHTML;
}

/* -------------------------------------------------------------- formatting -- */

export function prettyCss(css: string): string {
  if (css.split('\n').length > 30) return css;
  let out = '';
  let quote: string | null = null;
  let paren = 0;
  let brace = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === quote && css[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    if (paren === 0 && ch === '{') {
      out = `${out.trimEnd()} {\n`;
      brace += 1;
      out += '  '.repeat(brace);
      continue;
    }
    if (paren === 0 && ch === '}') {
      out = `${out.trimEnd()}\n`;
      brace = Math.max(0, brace - 1);
      out += `${'  '.repeat(brace)}}\n${'  '.repeat(brace)}`;
      continue;
    }
    if (paren === 0 && ch === ';') {
      out += `;\n${'  '.repeat(brace)}`;
      continue;
    }
    out += ch;
  }
  return `${out.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
/** Whitespace-significant or code-bearing elements — copied through untouched.
 * `template` too: pretty-printing injected a newline as its first child, and
 * the shim's first-child setAttribute() then crashed on that text node. */
const RAW_TAGS = new Set(['pre', 'textarea', 'script', 'style', 'template']);

function prettyHtml(html: string): string {
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>|[^<]+/gi;
  let out = '';
  let depth = 0;
  let m: RegExpExecArray | null;
  const indent = () => {
    if (out) out += `\n${'  '.repeat(Math.max(0, depth))}`;
  };
  while ((m = re.exec(html)) !== null) {
    const tok = m[0];
    if (tok.startsWith('<!--') || tok.startsWith('<!')) {
      indent();
      out += tok;
      continue;
    }
    if (tok.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      indent();
      out += tok;
      continue;
    }
    if (tok.startsWith('<')) {
      const tag = (m[1] ?? '').toLowerCase();
      if (RAW_TAGS.has(tag)) {
        const close = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        const end = close === -1 ? html.length : html.indexOf('>', close) + 1;
        indent();
        out += tok + html.slice(m.index + tok.length, end);
        re.lastIndex = end;
        continue;
      }
      indent();
      out += tok;
      const selfClose = tok.endsWith('/>');
      if (!selfClose && !VOID_TAGS.has(tag)) depth += 1;
      continue;
    }
    out += tok;
  }
  return out;
}

/* ------------------------------------------------------------------ build -- */

export async function buildUiExportHtml(): Promise<{ html: string; stats: UiExportStats }> {
  const stats: UiExportStats = {
    bytes: 0, styles: 0, inlined: 0, external: [], panels: 0, views: 0,
  };
  const cache = new Map<string, string>();

  // 1) Neutral live state: close overlays, expand nav sections.
  await prepareLiveState();

  // 2) Harvest PAGES first: view switches REMOUNT the composer, so opener
  //    tags must be applied after the last remount. Restore the original view
  //    via the store — clicking buttons can't know which view was active.
  const initialView = useStore.getState().view;
  const viewBtns = collectViewButtons(document).slice(0, 14);
  const host = document.getElementById('workspace');
  const viewMap = new Map<number, string[]>();
  if (host) {
    const sliceContent = () => Array.from(host.children).slice(1);
    // Compare outerHTML: React REUSES the same DOM element across views —
    // element identity never changes, only the markup inside it does.
    const snap = () =>
      sliceContent()
        .map((c) => c.outerHTML)
        .join('\n--\n');
    for (let j = 0; j < viewBtns.length; j += 1) {
      try {
        const beforeSnap = snap();
        viewBtns[j].click();
        await waitWorkspaceStable(host);
        const afterKids = sliceContent();
        const afterSnap = afterKids.map((c) => c.outerHTML).join('\n--\n');
        if (afterKids.length && afterSnap && afterSnap !== beforeSnap) {
          viewMap.set(j, afterKids.map((c) => c.outerHTML));
          viewBtns[j].setAttribute('data-demo-view', `v${j}`);
        }
      } catch {
        /* skip this page */
      }
    }
    useStore.getState().setView(initialView);
    await settle(700);
  }

  // 3) Harvest panels — tag the opener and mark its mount host DIRECTLY on
  //    the live elements (cloneNode copies attributes; no index math).
  document.getElementById('moriko-session-bar')?.setAttribute('data-demo-topbar', '');
  const openers = collectOpeners(document).slice(0, 50);
  const panelMap = new Map<number, string[]>();
  const nameMap = new Map<string, string>();
  for (let i = 0; i < openers.length; i += 1) {
    try {
      const made = await harvestPanel(openers[i]);
      if (made.length) {
        panelMap.set(i, made.map((n) => n.outerHTML));
        openers[i].setAttribute('data-demo', `p${i}`);
        for (const n of made) markHost(n.parentElement, `p${i}`);
        const nm = nameKey(openers[i]);
        if (nm && !nameMap.has(nm)) nameMap.set(nm, `p${i}`);
      }
      await closePanel(openers[i]);
    } catch {
      /* one bad opener must not sink the export */
    }
  }

  // 3.5) Normalize + heal — nothing may be open at clone time, or React
  //    unmounts the conditional opener (Show configuration) and its tag dies.
  //    NOTE: dismissSettings is a NO-OP ≥1024px (desktop dock ignores Escape),
  //    so the store is toggled directly; Escape still handles nav + modals.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const st = useStore.getState();
    const dockOpen = !!st.settingsOpen;
    const overlay = !!document.querySelector('div.fixed.inset-0');
    if (!dockOpen && !overlay) break;
    if (dockOpen) st.toggleSettings();
    escapeClose();
    await settle(150);
    // Drawer backdrops are CHILDREN (aria-hidden)…
    for (const t of Array.from(
      document.querySelectorAll(
        'div.fixed.inset-0 [class*="bg-black"], div.fixed.inset-0[class*="bg-black"]',
      ),
    )) {
      if (t instanceof HTMLElement) t.click();
    }
    await settle(150);
  }
  // Baseline rail must be expanded so the file's toggle has something to hide.
  if (useStore.getState().sidebarCollapsed) {
    useStore.getState().toggleSidebar();
    await settle(150);
  }
  if (document.body.style.overflow) document.body.style.overflow = '';
  const lostByName = new Map<string, string>();
  for (const [i] of panelMap) {
    const el = openers[i];
    if (el && el.isConnected && el.hasAttribute('data-demo')) continue;
    const nk = el ? nameKey(el) : '';
    if (nk && !lostByName.has(nk)) lostByName.set(nk, `p${i}`);
  }
  for (const btn of collectOpeners(document)) {
    if (btn.hasAttribute('data-demo')) continue;
    const key = lostByName.get(nameKey(btn));
    if (key) btn.setAttribute('data-demo', key);
  }
  for (const el of collectOpeners(document)) {
    if (el.getAttribute('aria-expanded') === 'true') el.setAttribute('aria-expanded', 'false');
  }
  stats.panels = panelMap.size;
  stats.views = viewMap.size;

  // 4) Baseline clone — live app is neutral again (overlays closed, view back).
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  outermost(overlayNodes(clone)).forEach((n) => n.remove()); // never ship open overlays
  for (const s of Array.from(clone.querySelectorAll('script'))) s.remove();

  // Opener / view / topbar tags were applied to the LIVE elements above —
  // cloneNode copied them. Index-based retagging is deliberately avoided.

  // 5) CSS: consolidate every style block, inline url() refs.
  const styleTexts: string[] = [];
  for (const el of Array.from(clone.querySelectorAll('style'))) {
    styleTexts.push(el.textContent ?? '');
    el.remove();
  }
  for (const link of Array.from(clone.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = link.getAttribute('href');
    if (href) {
      try {
        const abs = new URL(href, location.href).href;
        styleTexts.push(await (await fetch(abs)).text());
      } catch {
        stats.external.push(href);
      }
    }
    link.remove();
  }
  for (const link of Array.from(clone.querySelectorAll('link'))) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    const href = link.getAttribute('href') ?? '';
    if (rel.includes('icon') && href) {
      try {
        const abs = new URL(href, location.href).href;
        if (abs.startsWith(location.origin)) {
          link.setAttribute('href', await dataUri(abs, cache));
          stats.inlined += 1;
          continue;
        }
      } catch {
        /* fall through */
      }
    }
    link.remove();
  }
  let css = '';
  for (const text of styleTexts) {
    if (!text.trim()) continue;
    css += `${await inlineCssUrls(text, location.href, cache, stats)}\n\n`;
    stats.styles += 1;
  }

  // 6) Baseline images → data URIs.
  await inlineImagesIn(clone, cache, stats);

  // 7) Templates: harvested panels/pages, opener-tagged + images inlined.
  const wrap = document.createElement('div');
  wrap.id = 'moriko-demo-templates';
  wrap.hidden = true;
  for (const [i, htmls] of panelMap) {
    for (const h of htmls) {
      const tpl = document.createElement('template');
      tpl.setAttribute('data-demo-panel', `p${i}`);
      tpl.innerHTML = await finalizeTemplate(h, cache, stats, nameMap);
      wrap.appendChild(tpl);
    }
  }
  for (const [j, htmls] of viewMap) {
    const tpl = document.createElement('template');
    tpl.setAttribute('data-demo-view', `v${j}`);
    tpl.innerHTML = (
      await Promise.all(htmls.map((h) => finalizeTemplate(h, cache, stats, nameMap)))
    ).join('\n');
    wrap.appendChild(tpl);
  }

  // 8) Inject templates + the interactivity shim (AFTER script stripping).
  clone.querySelector('body')?.appendChild(wrap);
  const shim = document.createElement('script');
  shim.textContent = DEMO_SHIM;
  clone.querySelector('body')?.appendChild(shim);

  // 9) Guide comment + consolidated stylesheet.
  const head =
    clone.querySelector('head') ??
    clone.insertBefore(document.createElement('head'), clone.firstChild);
  const stamp = new Date().toISOString();
  head.insertBefore(
    document.createComment(
      ` MORIKO UI EXPORT: self-contained interactive snapshot generated ${stamp}. ` +
        `App scripts stripped; a small vanilla shim re-opens ${stats.panels} panel(s) ` +
        `and switches ${stats.views} page(s) from their hidden templates. ` +
        `Edit structure, classes and CSS freely — nothing re-renders over your edits. ` +
        `Design tokens live in the :root block below. ` +
        `Assets inlined: ${stats.inlined}; external refs: ${stats.external.length}.`,
    ),
    head.firstChild,
  );
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-moriko-export', '');
  styleEl.textContent =
    `${prettyCss(css)}\n/* export shim */\n.demo-collapsed { display: none !important; }\n`;
  head.appendChild(styleEl);

  const html = prettyHtml(`<!DOCTYPE html>${clone.outerHTML}`);
  stats.bytes = new Blob([html]).size;
  return { html, stats };
}

/** Full flow: busy notice → build → save into ui-exports/ → download → notice. */
export async function exportUi(): Promise<void> {
  const { showNotice } = useStore.getState();
  try {
    showNotice('export.uiBusy');
    const { html, stats } = await buildUiExportHtml();

    let savedPath: string | null = null;
    try {
      const res = await fetch('/api/ui/export', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
        body: html,
      });
      if (res.ok) {
        const data = (await res.json()) as { file?: string };
        savedPath = data.file ?? null;
      }
    } catch {
      // Server save is best effort — the browser download below still runs.
    }

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `moriko-ui-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);

    const kb = Math.max(1, Math.round(stats.bytes / 1024));
    showNotice('export.uiDone', {
      kb,
      file: savedPath ?? 'browser download',
      panels: stats.panels,
      views: stats.views,
    });
  } catch (error) {
    showNotice('export.uiFailed', undefined, {
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}
