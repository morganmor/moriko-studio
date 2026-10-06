/**
 * VisualCard (Fase D + VISUAL v2) — the LIVE VISUAL renderer for agent__render_visual.
 *
 * SECURITY MODEL (the prove of D.2):
 *   <iframe sandbox="allow-scripts" srcDoc={html} csp="…">
 *
 *  - sandbox="allow-scripts" WITHOUT allow-same-origin → the document runs in
 *    an OPAQUE origin: `window.parent`, `document.domain`, localStorage and
 *    cookies are all unreachable. `allow-top-navigation` is absent, so the
 *    frame cannot redirect the host page; `allow-popups` is absent too.
 *  - csp="default-src 'none'; script-src 'unsafe-inline'; style-src
 *    'unsafe-inline'; img-src data: blob:; font-src data:" → NOTHING may be
 *    fetched from the network (every remote URL fails closed), while inline
 *    <style>/<script> and data:/blob: assets stay alive — the whole point of
 *    the feature: CSS animations and JS interactivity run at full power.
 *  - referrerPolicy="no-referrer" + the opaque origin strip any identity.
 *
 * The payload persists on the turn segment, so a reload re-renders it from
 * storage — nothing is "live" in the volatile sense.
 *
 * VISUAL v2:
 *  - EDIT-IN-PLACE: `visual.replaces` re-binds THIS card to the new payload;
 *    the parent thread has already folded it into the newest segment. The
 *    frame's key includes the payload ref so React swaps the document, and
 *    a live SSE update can arrive through `refreshToken` without a remount.
 *  - FRONTEND PREVIEW: `visual.variants` (1..3 candidates) renders ALL of
 *    them side by side (stacked below md). The user picks one → the pick is
 *    posted to the server (broadcast + steer back to the model) and the
 *    card shows the chosen candidate enlarged, others as history.
 *
 * SIZING (dynamic + windowed): the sandboxed document CANNOT be measured
 * directly (opaque origin), so a tiny reporter script is injected into it —
 * the ONE sanctioned bridge: it measures the document and postMessages its
 * height; the card validates the source window and clamps hard. Auto-fit is
 * the DEFAULT (card = exactly as tall as its content — no blind stretching),
 * and the card carries real window edges: drag the bottom edge (height),
 * the sides (width), or the bottom corners (both). Manual sizing takes
 * control from auto-fit until "Fit" is pressed again (lit when active).
 * Fullscreen (pola ImageLightbox) stays fill-the-overlay.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Maximize2,
  ShieldCheck,
  UnfoldVertical,
  X,
} from './icons';

import { attachmentRefUrl, pickVisualVariant, steerVisualPick } from '../lib/api';
import { storage } from '../lib/storage';
import { useStore } from '../store/useStore';
import { Tip, cx } from './ui';

/** The sandbox+CSP pair every render of a visual uses. Proven inert: no
 *  network source exists in the policy and the origin is opaque.
 *  The `csp` IFRAME ATTRIBUTE is Firefox-only (Chrome ignores it), so the
 *  policy is ALSO injected as a <meta http-equiv> tag at the TOP of the
 *  document — the cross-browser enforcement point. A document that already
 *  carries its own CSP meta keeps BOTH (the strictest wins per directive). */
const VISUAL_SANDBOX = 'allow-scripts';
const VISUAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** React 18 iframe typings belum punya atribut `csp` — dipakai lewat spread
 *  (pola yang sama dengan VisualFrame). */
const CSP_ATTR = { csp: VISUAL_CSP } as Record<string, string>;

/** Injects the CSP meta as the FIRST head child (before any <style>/<script>).
 *  No <head>? The meta itself creates one when parsed. This is what makes the
 *  policy effective in Chrome/Edge/Safari, not just Firefox. */
function enforceCsp(html: string): string {
  if (/<meta[^>]+http-equiv=["']?Content-Security-Policy/i.test(html)) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP.replace(/"/g, '&quot;')}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${meta}`);
  }
  return `${meta}\n${html}`;
}


const VISUAL_MIN_W = 320;
const VISUAL_MIN_H = 160;
const VISUAL_MAX_H = 2000;

const clampVisualHeight = (value: number): number =>
  Math.round(Math.max(VISUAL_MIN_H, Math.min(VISUAL_MAX_H, value)));

/** Window-style resize handles: bottom edge (height), side edges (width),
 *  bottom corners (both). Top handles are deliberately absent — the card
 *  lives in document flow, so growing "upward" would shove everything above
 *  it; the windowed metaphor applies where it makes sense. */
const RESIZE_HANDLES: Array<{ dir: string; cls: string }> = [
  { dir: 's', cls: 'inset-x-2 bottom-0 h-1.5 cursor-s-resize' },
  { dir: 'e', cls: 'inset-y-1 right-0 w-1.5 cursor-e-resize' },
  { dir: 'w', cls: 'inset-y-1 left-0 w-1.5 cursor-w-resize' },
  { dir: 'se', cls: 'bottom-0 right-0 h-3.5 w-3.5 cursor-se-resize' },
  { dir: 'sw', cls: 'bottom-0 left-0 h-3.5 w-3.5 cursor-sw-resize' },
];

/**
 * Injects the VISUAL RUNTIME before </body>: a normalization style + the
 * height reporter.
 *
 * - `html,body{min-height:0!important}` — models LOVE min-height:100vh, but
 *   inside an iframe "vh" is circular (the iframe IS the viewport): the
 *   document would always report exactly its current frame height and
 *   auto-fit could never shrink the card. Neutralized so the report is the
 *   TRUE content height (the style is injected last, so an author rule that
 *   also uses !important still wins over it).
 * - The reporter is the ONE sanctioned bridge across the sandbox boundary:
 *   the child measures its own document and postMessages the number. The
 *   parent validates the source window and clamps. Inline script → allowed
 *   by our CSP ('unsafe-inline'); an author CSP that blocks inline scripts
 *   simply degrades the card to fixed height.
 */
function injectVisualRuntime(html: string, id: string): string {
  const style = '<style>html,body{min-height:0!important}</style>';
  const script =
    '<script>(function(){var last=0;function send(){var d=document;' +
    'var h=Math.max(d.documentElement?d.documentElement.scrollHeight:0,d.body?d.body.scrollHeight:0);' +
    'h=Math.round(h);if(Math.abs(h-last)<2)return;last=h;' +
    `try{parent.postMessage({__morikoVisual:{id:${JSON.stringify(id)},height:h}},"*")}catch(e){}}` +
    'window.addEventListener("load",send);window.addEventListener("resize",send);' +
    'document.addEventListener("DOMContentLoaded",send);' +
    'if(document.fonts&&document.fonts.ready){document.fonts.ready.then(send)}' +
    'if(window.ResizeObserver&&document.documentElement){try{new ResizeObserver(send).observe(document.documentElement)}catch(e){}}' +
    'send()})();</script>';
  const runtime = `${style}${script}`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, (match) => `${runtime}${match}`);
  return `${html}${runtime}`;
}

export interface VisualSpec {
  id: string;
  /** Inline payload (small visuals, or re-inlined by the detail route). */
  html?: string;
  /** P2 EXTERNALIZATION: the payload lives in the byte store — fetch on mount. */
  htmlRef?: { hash: string; byteSize: number };
  title: string;
  height: number;
  /** VISUAL v2: true = this payload is an edit-in-place replacement. */
  replaces?: true;
  /** VISUAL v2: frontend-preview candidates (1..3), the user picks one. */
  variants?: Array<{
    id: string;
    html?: string;
    htmlRef?: { hash: string; byteSize: number };
    title: string;
    height: number;
  }>;
}

/**
 * P2: module-level cache for byte-store visual payloads — a hash always maps
 * to the same document, so one fetch per session per visual, shared by the
 * inline card AND the fullscreen view.
 */
const visualHtmlCache = new Map<string, Promise<string>>();

function loadVisualHtml(visual: VisualSpec): Promise<string> {
  if (visual.html !== undefined) return Promise.resolve(visual.html);
  const hash = visual.htmlRef?.hash;
  if (!hash) return Promise.resolve('');
  let cached = visualHtmlCache.get(hash);
  if (!cached) {
    cached = fetch(attachmentRefUrl(hash, 'text/html')).then((response) => {
      if (!response.ok) throw new Error(`visual payload ${response.status}`);
      return response.text();
    });
    cached.catch(() => visualHtmlCache.delete(hash));
    visualHtmlCache.set(hash, cached);
  }
  return cached;
}

/**
 * VISUAL v2: the LIVE re-bind channel — publishBusEvent rides the addon SSE
 * to every browser. An edit-in-place/pick arrives as a topic event; this hook
 * returns a token that changes whenever the card's id was touched, so the
 * frame re-reads its (mutated) conversation segment.
 */
function useVisualLiveToken(visualId: string): number {
  const addonEvent = useStore((state) => state.addonEvent);
  return useMemo(() => {
    const topic = typeof addonEvent?.topic === 'string' ? addonEvent.topic : '';
    if (!topic.startsWith('moriko:visual-')) return 0;
    const payload = addonEvent?.payload as { visualId?: unknown } | undefined;
    if (payload?.visualId !== visualId) return 0;
    return addonEvent?.ts ?? Date.now();
  }, [addonEvent, visualId]);
}

/** The sandboxed iframe. Shared by the inline card and the fullscreen view.
 *  The `csp` attribute (Firefox-only enforcement, Chrome uses the meta) is
 *  set via spread so React's strict iframe typings stay honest.
 *  `fill` mode: fullscreen stretches the frame to its container (height 100%)
 *  instead of a bogus pixel value. `srcDoc`/`frameRef` let the inline card
 *  attach its reporter-injected document + measurement plumbing. */
function VisualFrame({
  visual,
  height,
  fill = false,
  frameRef,
  srcDoc,
}: {
  visual: VisualSpec;
  height: number;
  fill?: boolean;
  frameRef?: React.Ref<HTMLIFrameElement>;
  /** P2: pre-resolved document (inline or fetched) — required, never undefined. */
  srcDoc: string;
}) {
  const cspAttr = { csp: VISUAL_CSP } as Record<string, string>;
  return (
    <iframe
      ref={frameRef}
      title={visual.title || 'Agent visual'}
      sandbox={VISUAL_SANDBOX}
      {...cspAttr}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      className="w-full border-0 bg-white"
      style={fill ? { height: '100%', display: 'block' } : { height, display: 'block' }}
    />
  );
}

/** Resolves one variant spec to its document (inline or byte-store fetch). */
function useVariantHtml(variant: { html?: string; htmlRef?: { hash: string; byteSize: number } } | undefined): string | undefined {
  const [html, setHtml] = useState<string | undefined>(variant?.html);
  useEffect(() => {
    let cancelled = false;
    if (variant?.html !== undefined) {
      setHtml(variant.html);
      return;
    }
    if (!variant) {
      setHtml(undefined);
      return;
    }
    loadVisualHtml(variant as VisualSpec)
      .then((resolved) => {
        if (!cancelled) setHtml(resolved);
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [variant?.html, variant?.htmlRef?.hash, variant]);
  return html;
}

/** One preview candidate: its own sandboxed frame + Pick control. */
function VariantFrame({
  variant,
  index,
  picked,
  onPick,
}: {
  variant: NonNullable<VisualSpec['variants']>[number];
  index: number;
  picked: boolean;
  onPick: (variantId: string) => void;
}) {
  const html = useVariantHtml(variant);
  return (
    <div
      className={cx(
        'relative min-w-0 flex-1 overflow-hidden rounded-card border bg-surface',
        picked ? 'border-accent' : 'border-hairline',
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-hairline bg-elevated px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink">
          {index + 1}. {variant.title}
        </span>
        {picked ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] font-medium text-accent">
            <Check className="h-3 w-3" aria-hidden="true" />
            chosen
          </span>
        ) : (
          <Tip label="Pick this frontend">
            <button
              type="button"
              className="icon-button h-6 w-6 shrink-0"
              onClick={() => onPick(variant.id)}
              aria-label={`Pick ${variant.title}`}
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tip>
        )}
      </div>
      <div className="bg-white">
        {html !== undefined ? (
          <iframe
            title={variant.title || `Variant ${index + 1}`}
            sandbox={VISUAL_SANDBOX}
            {...CSP_ATTR}
            srcDoc={injectVisualRuntime(enforceCsp(html), variant.id)}
            referrerPolicy="no-referrer"
            className="w-full border-0 bg-white"
            style={{ height: clampVisualHeight(variant.height || 420), display: 'block' }}
          />
        ) : (
          <div className="flex items-center justify-center text-[11.5px] text-faint" style={{ height: 240 }}>
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The inline card under the tool call — CONTENT-SIZED + WINDOWED.
 *
 * Sizing model:
 *  - AUTO-FIT (default): the sandboxed document reports its own height via
 *    the injected reporter; the card follows the content (clamped), so the
 *    panel is exactly as tall as what it shows.
 *  - WINDOWED RESIZE: real window edges — drag the bottom edge (height), the
 *    side edges (width), or the bottom corners (both). Any manual height
 *    switch takes control AWAY from auto-fit until "Fit" is pressed again
 *    (the button is lit while auto-fit is active).
 *  - Width only becomes fixed once the user drags a side; until then the
 *    card spans the thread column like every other block.
 *  - GEOMETRY SCOPE (VISUAL v2): manual geometry keys on the ACTIVE id —
 *    an edit-in-place (same id) keeps the user's size; a NEW visual id
 *    starts fresh at auto-fit.
 */
export function VisualCard({
  visual,
  onFullscreen,
}: {
  visual: VisualSpec;
  onFullscreen: (visual: VisualSpec) => void;
}) {
  const activeId = useStore((state) => state.activeId);
  /** VISUAL v2: re-read the conversation record when a live update touches
   *  this card's id (edit-in-place / pick from another browser). */
  const liveToken = useVisualLiveToken(visual.id);
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [pickedVariantId, setPickedVariantId] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const savedGeometry = storage.loadVisualGeometry(visual.id);
  const [height, setHeight] = useState(savedGeometry?.height ?? visual.height);
  const [width, setWidth] = useState<number | null>(savedGeometry?.width ?? null);
  /** Height follows the reported content height until the user takes over. */
  const [autoFit, setAutoFit] = useState(savedGeometry?.autoFit ?? true);
  const autoFitRef = useRef(savedGeometry?.autoFit ?? true);
  const lastReportedRef = useRef(visual.height);

  /** VISUAL v2: an external update re-fits ONLY auto-fit cards — a card the
   *  user sized manually keeps its window across edits (that is the point of
   *  editing in place); auto-fit follows the new payload's height intent. */
  useEffect(() => {
    if (liveToken === 0) return;
    if (!autoFitRef.current) return;
    setHeight(clampVisualHeight(visual.height));
    lastReportedRef.current = clampVisualHeight(visual.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveToken]);

  const [resolvedHtml, setResolvedHtml] = useState<string | undefined>(visual.html);
  useEffect(() => {
    let cancelled = false;
    if (visual.html !== undefined) {
      setResolvedHtml(visual.html);
      return;
    }
    loadVisualHtml(visual)
      .then((html) => {
        if (!cancelled) setResolvedHtml(html);
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [visual.html, visual.htmlRef?.hash]);
  const resizeRef = useRef<{
    dir: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    maxW: number;
  } | null>(null);

  /** Persist manual sizing (any user takeover) — device store, debounced. */
  const persistGeometry = (
    next: Partial<{ width: number | null; height: number; autoFit: boolean }>,
  ) => {
    storage.saveVisualGeometry(visual.id, {
      width,
      height,
      autoFit,
      ...next,
    });
  };

  useEffect(() => {
    const saved = storage.loadVisualGeometry(visual.id);
    autoFitRef.current = saved?.autoFit ?? true;
    setAutoFit(saved?.autoFit ?? true);
    setHeight(saved?.height ?? visual.height);
    setWidth(saved?.width ?? null);
  }, [visual.id]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const payload = (event.data as { __morikoVisual?: { height?: unknown } } | null)?.__morikoVisual;
      if (!payload || typeof payload.height !== 'number' || !Number.isFinite(payload.height)) return;
      const reported = clampVisualHeight(payload.height);
      lastReportedRef.current = reported;
      if (!autoFitRef.current) return;
      setHeight((current) => (Math.abs(current - reported) >= 2 ? reported : current));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Manual height (resize handles + nudge buttons) — disables auto-fit. */
  const takeManualHeight = (value: number) => {
    const next = clampVisualHeight(value);
    autoFitRef.current = false;
    setAutoFit(false);
    setHeight(next);
    persistGeometry({ height: next, autoFit: false });
  };

  /** Back to content-driven height — clears the persisted takeover. */
  const fitContent = () => {
    autoFitRef.current = true;
    setAutoFit(true);
    setHeight(clampVisualHeight(lastReportedRef.current));
    persistGeometry({ autoFit: true });
  };

  const startResize = (dir: string) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    resizeRef.current = {
      dir,
      startX: event.clientX,
      startY: event.clientY,
      startW: width ?? rootRef.current?.offsetWidth ?? VISUAL_MIN_W,
      startH: height,
      maxW: Math.max(VISUAL_MIN_W, rootRef.current?.parentElement?.clientWidth ?? VISUAL_MIN_W),
    };
  };

  const onResizeMove = (event: React.PointerEvent) => {
    const drag = resizeRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.dir.includes('e')) {
      const nextW = Math.round(Math.min(drag.maxW, Math.max(VISUAL_MIN_W, drag.startW + dx)));
      setWidth(nextW);
      persistGeometry({ width: nextW });
    }
    if (drag.dir.includes('w')) {
      const nextW = Math.round(Math.min(drag.maxW, Math.max(VISUAL_MIN_W, drag.startW - dx)));
      setWidth(nextW);
      persistGeometry({ width: nextW });
    }
    if (drag.dir.includes('s')) takeManualHeight(drag.startH + dy);
    if (drag.dir.includes('n')) takeManualHeight(drag.startH - dy);
  };

  const endResize = () => {
    resizeRef.current = null;
  };

  /** COLLAPSE (pola pill): body/frame disembunyikan dengan grid-rows animasi
   *  0fr↔1fr; judul bar tetap terlihat sebagai baris satu (header pill). */
  const [bodyOpen, setBodyOpen] = useState(true);

  const srcDoc = useMemo(
    // VISUAL v2: the live token participates so an SSE re-bind swaps the doc.
    () => (resolvedHtml === undefined ? '' : injectVisualRuntime(enforceCsp(resolvedHtml), visual.id)),
    [resolvedHtml, visual.id, liveToken],
  );
  if (resolvedHtml === undefined) {
    return (
      <div
        className="relative mt-1 flex max-w-full items-center justify-center overflow-hidden rounded-card border border-hairline bg-surface shadow-card"
        style={{ width: width ?? '100%', height }}
      >
        <span className="text-[11.5px] text-faint">Loading visual…</span>
      </div>
    );
  }

  /** ── FRONTEND PREVIEW mode ─────────────────────────────────────────── */
  if (visual.variants && visual.variants.length > 0) {
    const variants = visual.variants;
    const chosen = pickedVariantId ?? activeVariantId;
    const pick = (variantId: string) => {
      if (pickedVariantId) return;
      setActiveVariantId(variantId);
      setPickedVariantId(variantId);
      const variant = variants.find((candidate) => candidate.id === variantId);
      void (async () => {
        const steerText = await pickVisualVariant({
          visualId: visual.id,
          variantId,
          variantIndex: variants.findIndex((candidate) => candidate.id === variantId),
          title: variant?.title,
        });
        if (steerText && activeId) await steerVisualPick(activeId, steerText);
      })();
    };
    const pickedVariant = variants.find((candidate) => candidate.id === chosen) ?? null;
    return (
      <div
        ref={rootRef}
        className="relative mt-1 max-w-full overflow-hidden rounded-card border border-hairline bg-surface shadow-card"
        style={{ width: width ?? '100%' }}
      >
        <div className="flex items-center gap-2 border-b border-hairline bg-elevated px-3 py-1.5">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
            {visual.title}
          </span>
          <span className="hidden shrink-0 text-[10.5px] text-faint sm:inline">
            {pickedVariant ? 'pick locked' : `${variants.length} candidates — pick one`}
          </span>
          <Tip label="Open fullscreen">
            <button
              type="button"
              className="icon-button h-6 w-6 shrink-0"
              onClick={() => onFullscreen(pickedVariant ?? visual)}
              aria-label="Open fullscreen"
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tip>
        </div>
        <div className="flex flex-col gap-2 p-2 md:flex-row">
          {variants.map((variant, index) => (
            <VariantFrame
              key={variant.id}
              variant={variant}
              index={index}
              picked={pickedVariant !== null && variant.id === pickedVariant.id}
              onPick={pick}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="relative mt-1 max-w-full overflow-hidden rounded-card border border-hairline bg-surface shadow-card"
      style={{ width: width ?? '100%' }}
    >
      {/** The title bar; VISUAL v2 shows the edit-in-place badge. */}
      <div className="flex items-center gap-2 border-b border-hairline bg-elevated px-3 py-1.5">
        <button
          type="button"
          onClick={() => setBodyOpen((value) => !value)}
          aria-expanded={bodyOpen}
          aria-label={bodyOpen ? 'Collapse visual panel' : 'Expand visual panel'}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200', !bodyOpen && '-rotate-90')}
            aria-hidden="true"
          />
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
            {visual.title}
          </span>
        </button>
        {visual.replaces ? (
          <Tip label="The agent updated this card in place — earlier frames stay in history above.">
            <span className="hidden shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] font-medium text-accent sm:inline">
              edited in place
            </span>
          </Tip>
        ) : null}
        <Tip label={autoFit ? 'Auto-fit is on — height follows the content' : 'Fit content (auto-height)'}>
          <button
            type="button"
            className={cx('icon-button h-6 w-6 shrink-0', autoFit && 'text-accent')}
            onClick={fitContent}
            aria-label="Fit content"
          >
            <UnfoldVertical className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Shorter (manual height, disables auto-fit)">
          <button
            type="button"
            className="icon-button h-6 w-6 shrink-0"
            onClick={() => takeManualHeight(height - 180)}
            aria-label="Decrease height"
          >
            <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Taller (manual height, disables auto-fit)">
          <button
            type="button"
            className="icon-button h-6 w-6 shrink-0"
            onClick={() => takeManualHeight(height + 180)}
            aria-label="Increase height"
          >
            <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Open fullscreen">
          <button
            type="button"
            className="icon-button h-6 w-6 shrink-0"
            onClick={() => onFullscreen(visual)}
            aria-label="Open fullscreen"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tip>
      </div>
      {/** The payload frame; the copy affordance lives in fullscreen.
          COLLAPSE: grid-rows 0fr↔1fr (pola CollapsePanel) — tinggi kartu
          dianimasikan mulus dua arah; resize handles ikut hilang saat
          tertutup (separator tanpa konten membingungkan). */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: bodyOpen ? '1fr' : '0fr' }}
        aria-hidden={!bodyOpen}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="bg-white">
            <VisualFrame visual={visual} height={height} frameRef={frameRef} srcDoc={srcDoc ?? ''} />
          </div>
          {/** Windowed resize handles (see RESIZE_HANDLES). */}
          {bodyOpen ? (
            RESIZE_HANDLES.map((handle) => (
              <div
                key={handle.dir}
                role="separator"
                className={cx('absolute z-20 touch-none transition-colors hover:bg-accent/30', handle.cls)}
                onPointerDown={startResize(handle.dir)}
                onPointerMove={onResizeMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
              />
            ))
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Fullscreen overlay (pola ImageLightbox): fixed, z-50, Escape/×/backdrop.
 *  VISUAL v2: adds a device-width preview row (Fill / 1280 / 768 / 390) —
 *  the design review view a real frontend needs; the scaled frame keeps its
 *  true layout width and the host scales it to fit the overlay. */
const FULLSCREEN_WIDTHS = [
  { id: 'fill', label: 'Fill', width: 0 },
  { id: 'desktop', label: '1280', width: 1280 },
  { id: 'tablet', label: '768', width: 768 },
  { id: 'mobile', label: '390', width: 390 },
] as const;

export function VisualFullscreen({ visual, onClose }: { visual: VisualSpec; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [widthMode, setWidthMode] = useState<number>(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === 'number') setStageWidth(Math.round(next));
    });
    observer.observe(stage);
    setStageWidth(Math.round(stage.clientWidth));
    return () => observer.disconnect();
  }, []);

  const [srcDoc, setSrcDoc] = useState<string | null>(visual.html !== undefined ? injectVisualRuntime(enforceCsp(visual.html), visual.id) : null);
  useEffect(() => {
    let cancelled = false;
    if (visual.html !== undefined) {
      setSrcDoc(injectVisualRuntime(enforceCsp(visual.html), visual.id));
      return;
    }
    loadVisualHtml(visual)
      .then((html) => {
        if (!cancelled) setSrcDoc(injectVisualRuntime(enforceCsp(html), visual.id));
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [visual]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={visual.title || 'Agent visual'}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/90">{visual.title}</span>
        <div className="flex items-center gap-1 rounded-control bg-white/10 p-0.5">
          {FULLSCREEN_WIDTHS.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={cx(
                'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                widthMode === mode.width ? 'bg-white text-black' : 'text-white/70 hover:text-white',
              )}
              onClick={() => setWidthMode(mode.width)}
              aria-pressed={widthMode === mode.width}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <span className="hidden text-[11px] text-white/50 sm:inline">sandboxed · no network</span>
        <button
          type="button"
          className="rounded-control p-1.5 text-white/70 transition-colors hover:text-white"
          onClick={onClose}
          aria-label="Close fullscreen"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div ref={stageRef} className="relative min-h-0 flex-1 p-4">
        {srcDoc !== null && widthMode === 0 ? (
          <div className="h-full">
            <VisualFrame visual={visual} height={0} fill srcDoc={srcDoc} />
          </div>
        ) : null}
        {srcDoc !== null && widthMode > 0 ? (() => {
          // Responsive preview: the iframe keeps its TRUE device width (the
          // document lays out at 1280/768/390) and the host scales it to fit
          // the stage. Height = stageHeight / scale so the scaled frame still
          // fills the overlay vertically; the document scrolls inside.
          const scale = stageWidth > 0 ? Math.min(1, stageWidth / widthMode) : 1;
          const stageHeight = stageRef.current?.clientHeight ?? 0;
          return (
            <div className="h-full overflow-hidden">
              <iframe
                title={visual.title || 'Agent visual'}
                sandbox={VISUAL_SANDBOX}
                {...CSP_ATTR}
                srcDoc={srcDoc}
                referrerPolicy="no-referrer"
                className="absolute top-0 left-1/2 origin-top-left border-0 bg-white shadow-2xl"
                style={{
                  width: widthMode,
                  height: stageHeight > 0 ? Math.round(stageHeight / scale) : '100%',
                  transform: `translateX(-${(widthMode * scale) / 2}px) scale(${scale})`,
                }}
              />
            </div>
          );
        })() : null}
        {srcDoc === null ? (
          <div className="flex h-full items-center justify-center text-[12px] text-white/60">Loading…</div>
        ) : null}
      </div>
    </div>
  );
}
