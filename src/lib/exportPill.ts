/**
 * exportPill — ONE self-contained HTML export of the ACTIVITY PILL panel
 * (Thread.tsx ActivityTicker + index.css .activity-ticker family) for a
 * DESIGNER agent to revise: markup, styles, animations, and the exact way the
 * pill looks to the user while the agent is working.
 *
 * Contents of the generated file:
 *   • a spec card (states, animation timings, behavior, source references)
 *   • designer controls (state switcher, row-entrance replay, reduced motion)
 *   • a mock thread stage holding a LIVE CLONE of the real pill markup —
 *     harvested from the running app (opened briefly to capture panel rows,
 *     then restored) — falling back to equivalent synthetic markup
 *   • the FULL app stylesheet (pill rules, keyframes, tokens, utilities)
 *   • a vanilla shim that reproduces React behavior: 2s word rotation while
 *     running, expand/collapse (grid-rows + chevron), comet on .is-running
 *
 * No backticks / ${ / </script inside PILL_SHIM — it is inlined raw.
 */
import { useStore } from '../store/useStore';
import { inlineCssUrls, inlineImagesIn, prettyCss, type UiExportStats } from './exportUi';

/** Same rotating words as Thread.tsx ACTIVITY_WORDS (kept in sync by hand). */
const ACTIVITY_WORDS = [
  'Doing Work', 'Stand Still', 'Be Calm', 'Stay Focused', 'On Track', 'In Motion',
];

/** Fallback markup when the live thread has no pill (fresh chat). */
const SYNTH_PILL = `
<div class="activity-stack w-full">
  <div class="activity-pill-wrap relative">
    <div class="activity-ticker">
      <button type="button" aria-expanded="false" aria-label="Expand this turn’s activity panel" class="flex w-full cursor-pointer items-center gap-2 px-3.5 py-1.5 text-left">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200 -rotate-90"><path d="m6 9 6 6 6-6"></path></svg>
        <span class="activity-ticker-word whitespace-nowrap text-[12.5px] font-semibold text-ink">Doing Work</span>
        <span class="demo-dots flex items-center gap-1" aria-hidden="true">
          <span class="ticker-dot ticker-dot-1 h-1.5 w-1.5 rounded-full bg-accent/90"></span>
          <span class="ticker-dot ticker-dot-2 h-1.5 w-1.5 rounded-full bg-accent/90"></span>
          <span class="ticker-dot ticker-dot-3 h-1.5 w-1.5 rounded-full bg-accent/90"></span>
        </span>
      </button>
      <div class="activity-panel grid transition-[grid-template-rows] duration-300 ease-in-out" style="grid-template-rows: 0fr" aria-hidden="true">
        <div class="min-h-0 overflow-hidden">
          <div class="activity-panel-scroll max-h-[420px] overflow-y-auto px-3 pb-2 pt-1">
            <div class="pill-row-enter flex min-h-[38px] items-start gap-2.5">
              <span class="relative flex w-[26px] shrink-0 self-stretch" aria-hidden="true">
                <span class="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-ink/40"></span>
                <span class="relative mt-[8px] flex h-[10px] w-full items-center">
                  <span class="h-[10px] w-[10px] shrink-0 rounded-full border-2 border-accent bg-canvas"></span>
                  <span class="h-[2px] flex-1 bg-accent/70"></span>
                  <span class="h-[10px] w-[10px] shrink-0 rounded-full border-2 border-accent bg-canvas"></span>
                </span>
              </span>
              <div class="min-w-0 flex-1 pt-[3px]">
                <p class="text-[13px] leading-relaxed text-muted">Sample interm row — streaming text appears here while the agent works.</p>
              </div>
            </div>
            <div class="pill-row-enter flex min-h-[38px] items-start gap-2.5">
              <span class="relative flex w-[26px] shrink-0 self-stretch" aria-hidden="true">
                <span class="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-ink/40"></span>
              </span>
              <div class="min-w-0 flex-1 pt-[3px]">
                <p class="text-[13px] leading-relaxed text-muted">Sample activity row — reasoning &amp; tool cards stack top-to-bottom in order.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;

/** Demo-only styles (scaffold + state rules the React app enforces by render). */
const DEMO_CSS = `
/* The inlined app shell locks the viewport (index.css: html, body { height:100%;
   overflow:hidden }) — this export is a normal scrollable document, so release
   BOTH locks: overflow is propagated html -> body -> viewport. */
html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; }
body { overflow-x: hidden; }
.pill-page { max-width: 980px; margin: 0 auto; padding: 20px 16px 72px; }
.pill-card { border: 1px solid rgb(var(--c-hairline)); border-radius: 12px; background: rgb(var(--c-elevated)); padding: 14px 16px; margin-bottom: 14px; }
.pill-card h2 { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgb(var(--c-muted)); margin: 0 0 8px; }
.pill-card table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.pill-card th, .pill-card td { text-align: left; padding: 5px 8px 5px 0; vertical-align: top; border-bottom: 1px solid rgb(var(--c-hairline)); color: rgb(var(--c-muted)); }
.pill-card th { color: rgb(var(--c-ink)); font-weight: 600; white-space: nowrap; }
.pill-card td code, .pill-card p code { font-family: ui-monospace, monospace; font-size: 11.5px; color: rgb(var(--c-accent)); }
.pill-card p { margin: 6px 0 0; font-size: 12.5px; color: rgb(var(--c-muted)); line-height: 1.55; }
.pill-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.pill-ctl { font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 12px; border-radius: 8px; border: 1px solid rgb(var(--c-hairline)); background: rgb(var(--c-canvas)); color: rgb(var(--c-ink)); cursor: pointer; }
.pill-ctl:hover { border-color: rgb(var(--c-accent)); }
.pill-ctl.on { background: rgb(var(--c-accent)); border-color: rgb(var(--c-accent)); color: #101010; }
.pill-state-out { font-family: ui-monospace, monospace; font-size: 12px; color: rgb(var(--c-accent)); }
.pill-label { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgb(var(--c-faint, #888)); margin: 18px 0 6px; }
.pill-stage { border: 1px dashed rgb(var(--c-hairline)); border-radius: 14px; padding: 18px 14px; background: rgb(var(--c-canvas)); }
.pill-mock { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
.pill-mock-bubble { align-self: flex-end; max-width: 78%; padding: 8px 12px; border-radius: 14px; background: rgb(var(--c-elevated)); border: 1px solid rgb(var(--c-hairline)); font-size: 13px; color: rgb(var(--c-ink)); }
.pill-mock-bubble.moriko { align-self: flex-start; background: transparent; border-color: transparent; color: rgb(var(--c-muted)); }
.pill-demo { margin-top: 4px; }
/* React renders the dots only while running AND collapsed — mirror that here. */
.pill-demo .demo-dots { display: flex; }
.pill-demo .activity-pill-wrap.is-open .demo-dots,
.pill-demo .activity-ticker:not(.is-running) .demo-dots { display: none; }
/* Reduced-motion preview (same overrides as prefers-reduced-motion in the app). */
.pill-page.reduced *, .pill-page.reduced *::before, .pill-page.reduced *::after {
  animation-duration: .01ms !important; animation-iteration-count: 1 !important;
  transition-duration: .01ms !important; scroll-behavior: auto !important;
}
.pill-page.reduced .activity-ticker.is-running::before { animation: none; background: rgb(var(--c-accent)); opacity: .55; }
.pill-page.reduced .activity-ticker-word, .pill-page.reduced .activity-ticker .ticker-dot, .pill-page.reduced .pill-row-enter { animation: none; }
`;

const PILL_SHIM = `(function () {
  var WORDS = ['Doing Work', 'Stand Still', 'Be Calm', 'Stay Focused', 'On Track', 'In Motion'];
  var wrap = document.querySelector('.activity-pill-wrap');
  var ticker = document.querySelector('.activity-ticker');
  if (!wrap || !ticker) return;
  var btn = ticker.querySelector('button');
  var wordEl = ticker.querySelector('.activity-ticker-word');
  var chev = btn ? btn.querySelector('svg') : null;
  var panel = ticker.querySelector('.activity-panel');
  var scroll = ticker.querySelector('.activity-panel-scroll');
  var state = { running: true, open: false, reduced: false, idx: 0 };
  var timer = 0;
  function setWord(i) {
    if (!wordEl) return;
    state.idx = ((i % WORDS.length) + WORDS.length) % WORDS.length;
    wordEl.textContent = WORDS[state.idx];
    wordEl.style.animation = 'none';
    void wordEl.offsetWidth;
    wordEl.style.animation = '';
  }
  function startWords() { stopWords(); timer = window.setInterval(function () { setWord(state.idx + 1); }, 2000); }
  function stopWords() { if (timer) { window.clearInterval(timer); timer = 0; } }
  function mark() {
    var out = document.getElementById('pill-state-out');
    if (out) out.textContent = (state.running ? 'RUNNING' : 'DONE') + ' · ' + (state.open ? 'EXPANDED' : 'COLLAPSED') + (state.reduced ? ' · reduced-motion' : '');
    var ctls = document.querySelectorAll('[data-pill-act]');
    for (var c = 0; c < ctls.length; c++) {
      var a = ctls[c].getAttribute('data-pill-act');
      var on =
        (a === 'run-collapsed' && state.running && !state.open) ||
        (a === 'run-expanded' && state.running && state.open) ||
        (a === 'done-collapsed' && !state.running && !state.open) ||
        (a === 'done-expanded' && !state.running && state.open) ||
        (a === 'reduced' && state.reduced);
      ctls[c].classList.toggle('on', !!on);
    }
  }
  function apply() {
    wrap.classList.toggle('is-open', state.open);
    ticker.classList.toggle('is-running', state.running);
    if (chev) chev.classList.toggle('-rotate-90', !state.open);
    if (panel) {
      panel.style.gridTemplateRows = state.open ? '1fr' : '0fr';
      panel.setAttribute('aria-hidden', state.open ? 'false' : 'true');
    }
    if (btn) btn.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    if (state.running) startWords(); else stopWords();
    if (state.open && scroll) scroll.scrollTop = scroll.scrollHeight;
    var page = document.querySelector('.pill-page');
    if (page) page.classList.toggle('reduced', state.reduced);
    mark();
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var ctl = t.closest('[data-pill-act]');
    if (ctl) {
      var act = ctl.getAttribute('data-pill-act');
      if (act === 'run-collapsed') { state.running = true; state.open = false; }
      else if (act === 'run-expanded') { state.running = true; state.open = true; }
      else if (act === 'done-collapsed') { state.running = false; state.open = false; }
      else if (act === 'done-expanded') { state.running = false; state.open = true; }
      else if (act === 'reduced') { state.reduced = !state.reduced; }
      else if (act === 'replay') {
        var rows = document.querySelectorAll('.pill-row-enter');
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          r.classList.remove('pill-row-enter');
          void r.offsetWidth;
          r.classList.add('pill-row-enter');
        }
        mark();
        return;
      }
      apply();
      return;
    }
    if (t.closest('.activity-ticker > button')) { state.open = !state.open; apply(); }
  });
  apply();
})();`;

function guideComment(stats: UiExportStats, harvested: boolean, stamp: string): string {
  return (
    `<!-- MORIKO PILL PANEL EXPORT — design-spec file generated ${stamp}. ` +
    `Source: src/components/Thread.tsx ActivityTicker (states: running x open), ` +
    `src/styles/index.css .activity-ticker/.activity-pill-wrap/.pill-row-enter (animations below). ` +
    `Markup is ${harvested ? 'a live clone of the running app (panel rows included)' : 'equivalent synthetic markup (no pill existed in the thread at export time)'}. ` +
    `Full app stylesheet included; a vanilla shim drives the 2s word rotation and expand/collapse. ` +
    `Styles inlined: ${stats.styles}; assets inlined: ${stats.inlined}; external refs: ${stats.external.length}. -->`
  );
}

const SPEC_HTML = `
<div class="pill-card">
  <h2>Activity pill — spec for redesign</h2>
  <table>
    <tr><th>Element</th><td>Exactly ONE pill per assistant turn, stacked above the turn’s rows inside the thread column (<code>.activity-stack</code> → <code>.activity-pill-wrap</code> → <code>.activity-ticker</code>).</td></tr>
    <tr><th>Collapsed chip</th><td><code>[ ▼ &lt;word&gt; ●●● ]</code> — chevron rotated -90°, label, three pulsing dots (dots only while RUNNING and collapsed). Width is <code>fit-content</code>.</td></tr>
    <tr><th>Expanded panel</th><td>Full-width (<code>.is-open</code> → width 100%). Rows = flat ordered list of events: reasoning, tool cards, interm text, steer bubbles. Height animates via <code>grid-template-rows: 0fr → 1fr</code> (300ms ease-in-out). Scroll area caps at 420px and auto-scrolls to the newest row.</td></tr>
    <tr><th>RUNNING border</th><td>Conic-gradient “comet” rotates around the panel border: <code>activity-ring-spin 2.8s linear infinite</code> on <code>::before</code> (via <code>@property --ticker-angle</code>). Idle = flat translucent accent ring.</td></tr>
    <tr><th>Word rotation</th><td>While running, label swaps every <strong>2000ms</strong> through: ${ACTIVITY_WORDS.map((w) => `“${w}”`).join(', ')}. Each swap replays <code>activity-word-in 420ms cubic-bezier(.22,1,.36,1)</code> (fade + 4px rise + blur). When the turn settles, the last word FREEZES.</td></tr>
    <tr><th>Dots</th><td><code>ticker-dot-pulse 1.2s ease-in-out infinite</code>, staggered delays 0 / 150 / 300ms.</td></tr>
    <tr><th>Row entrance</th><td>New rows play <code>pill-row-enter 260ms</code> (fade + 3px rise); timeline rail on the left (26px column, 1px line, accent nodes for interm rows).</td></tr>
    <tr><th>Reduced motion</th><td>Comet → static 55% accent ring; word/dot/row animations off; transitions 0.01ms (toggle in the controls to preview).</td></tr>
    <tr><th>User perception</th><td>Idle turn: quiet chip, word frozen, no motion. Agent working: border comet spins, word breathes every 2s, dots pulse — the pill is the primary “alive” signal in the thread.</td></tr>
    <tr><th>Source files</th><td><code>src/components/Thread.tsx</code> (ActivityTicker, ACTIVITY_WORDS) · <code>src/styles/index.css</code> (~L433–591) · rows built in MessageRow.</td></tr>
  </table>
</div>
<div class="pill-card">
  <h2>Designer controls (scaffold — not part of the design)</h2>
  <div class="pill-controls">
    <button type="button" class="pill-ctl" data-pill-act="run-collapsed">▶ Running · collapsed</button>
    <button type="button" class="pill-ctl" data-pill-act="run-expanded">▶ Running · expanded</button>
    <button type="button" class="pill-ctl" data-pill-act="done-collapsed">■ Done · collapsed</button>
    <button type="button" class="pill-ctl" data-pill-act="done-expanded">■ Done · expanded</button>
    <button type="button" class="pill-ctl" data-pill-act="replay">Replay row entrance</button>
    <button type="button" class="pill-ctl" data-pill-act="reduced">Reduced motion</button>
    <span class="pill-state-out" id="pill-state-out"></span>
  </div>
  <p>Click the pill itself to expand/collapse. The file opens in RUNNING · COLLAPSED — the exact state the user sees while the agent works.</p>
</div>`;

export async function buildPillExportHtml(): Promise<{
  html: string;
  stats: UiExportStats & { pill: boolean };
}> {
  const stats: UiExportStats & { pill: boolean } = {
    bytes: 0, styles: 0, inlined: 0, external: [], panels: 0, views: 0, pill: false,
  };
  const cache = new Map<string, string>();

  // 1) Harvest the real pill: prefer one whose panel content is already
  //    mounted; otherwise open one briefly to capture rows, then restore it.
  let pillHtml = '';
  const stacks = Array.from(document.querySelectorAll('.activity-stack'));
  const withRows = stacks.find((s) => s.querySelector('.activity-panel-scroll')) ?? stacks[0];
  if (withRows) {
    const btn = withRows.querySelector('.activity-ticker > button') as HTMLElement | null;
    const wrap = withRows.querySelector('.activity-pill-wrap');
    const wasOpen = wrap?.classList.contains('is-open') ?? false;
    const hasContent = !!withRows.querySelector('.activity-panel-scroll');
    if (btn && !wasOpen && !hasContent) {
      btn.click();
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    }
    pillHtml = withRows.outerHTML;
    if (btn && !wasOpen) {
      btn.click();
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    }
  }
  const harvested = pillHtml.length > 0;
  if (!harvested) pillHtml = SYNTH_PILL;

  // Normalize: guarantee the dots group exists (live markup only renders it
  // while running+collapsed) with the marker class the demo CSS gates on.
  const parsed = new DOMParser().parseFromString(pillHtml, 'text/html');
  const stack = parsed.body.firstElementChild;
  if (stack && !stack.querySelector('.demo-dots')) {
    const word = stack.querySelector('.activity-ticker-word');
    const btn = stack.querySelector('.activity-ticker > button');
    if (word && btn) {
      const dots = parsed.createElement('span');
      dots.className = 'demo-dots flex items-center gap-1';
      dots.setAttribute('aria-hidden', 'true');
      for (const n of ['ticker-dot ticker-dot-1', 'ticker-dot ticker-dot-2', 'ticker-dot ticker-dot-3']) {
        const d = parsed.createElement('span');
        d.className = `${n} h-1.5 w-1.5 rounded-full bg-accent/90`;
        dots.appendChild(d);
      }
      word.after(dots);
    }
  }
  pillHtml = stack ? parsed.body.innerHTML : SYNTH_PILL;

  // 2) Full stylesheet (pill rules + keyframes + tokens + utilities).
  const styleTexts: string[] = [];
  for (const el of Array.from(document.querySelectorAll('style'))) {
    styleTexts.push(el.textContent ?? '');
  }
  for (const link of Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = link.getAttribute('href');
    if (href) {
      try {
        const abs = new URL(href, location.href).href;
        styleTexts.push(await (await fetch(abs)).text());
      } catch {
        stats.external.push(href);
      }
    }
  }
  let css = '';
  for (const text of styleTexts) {
    if (!text.trim()) continue;
    css += `${await inlineCssUrls(text, location.href, cache, stats)}\n\n`;
    stats.styles += 1;
  }

  // 3) Any images inside the harvested pill → data URIs.
  const holder = parsed.createElement('div');
  holder.innerHTML = pillHtml;
  await inlineImagesIn(holder, cache, stats);
  pillHtml = holder.innerHTML;
  stats.panels = 1;
  stats.pill = harvested;

  // 4) Assemble the document.
  const stamp = new Date().toISOString();
  const themeClass = document.documentElement.className;
  const colorScheme =
    document.documentElement.style.colorScheme || (themeClass.includes('dark') ? 'dark' : 'light');
  const page = `
<!DOCTYPE html>
<html class="${themeClass}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="${colorScheme}" />
${guideComment(stats, harvested, stamp)}
<style data-moriko-export>${prettyCss(css)}</style>
<style data-pill-demo>${DEMO_CSS}</style>
</head>
<body class="${document.body.className}">
<div class="pill-page">
  <div class="pill-card">
    <h2>Moriko — Activity Pill · design export</h2>
    <p>Single-file snapshot of the pill panel: real markup, real CSS, real animations. Use the controls to step through every state; edit structure/classes/CSS freely — nothing re-renders over your edits. Design tokens are in the <code>:root</code> block of the stylesheet below.</p>
  </div>
${SPEC_HTML}
  <div class="pill-label">Stage — pill as the user sees it in the thread</div>
  <div class="pill-stage">
    <div class="pill-mock">
      <div class="pill-mock-bubble">Fix the pill so the border comet keeps spinning while the panel is expanded.</div>
      <div class="pill-mock-bubble moriko">On it — harvesting the current markup so the redesign keeps the real row structure.</div>
      <div class="pill-demo" data-pill-root>${pillHtml}</div>
    </div>
  </div>
</div>
<script>${PILL_SHIM}</script>
</body>
</html>`;

  stats.bytes = new Blob([page]).size;
  return { html: page, stats };
}

/** Full flow: busy notice → build → save (?kind=pill) → download → notice. */
export async function exportPill(): Promise<void> {
  const { showNotice } = useStore.getState();
  try {
    showNotice('export.pillBusy');
    const { html, stats } = await buildPillExportHtml();

    let savedPath: string | null = null;
    try {
      const res = await fetch('/api/ui/export?kind=pill', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
        body: html,
      });
      if (res.ok) {
        const data = (await res.json()) as { file?: string };
        savedPath = data.file ?? null;
      }
    } catch {
      // Server save is best effort — the browser download still runs.
    }

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `moriko-pill-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);

    showNotice('export.pillDone', {
      kb: Math.max(1, Math.round(stats.bytes / 1024)),
      file: savedPath ?? 'browser download',
      source: stats.pill ? 'live markup' : 'synthetic markup',
    });
  } catch (error) {
    showNotice('export.pillFailed', undefined, {
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}
