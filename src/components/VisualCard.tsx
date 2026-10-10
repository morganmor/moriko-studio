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
const RESIZE_HANDLES: Array<{ dir: string; style: React.CSSProperties }> = [
  { dir: 's', style: { left: 8, right: 8, bottom: 0, height: 6, cursor: 's-resize' } },
  { dir: 'e', style: { top: 4, bottom: 4, right: 0, width: 6, cursor: 'e-resize' } },
  { dir: 'w', style: { top: 4, bottom: 4, left: 0, width: 6, cursor: 'w-resize' } },
  { dir: 'se', style: { bottom: 0, right: 0, height: 14, width: 14, cursor: 'se-resize' } },
  { dir: 'sw', style: { bottom: 0, left: 0, height: 14, width: 14, cursor: 'sw-resize' } },
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

/**
 * F5.1 — vendor lib bundles: fetched ONCE per lib per session from the
 * harness origin (in-memory cache only; never persisted to the chat), then
 * injected as an inline <script> at the top of <head> before the srcDoc is
 * set. The iframe itself stays sandboxed with CSP default-src 'none' +
 * script-src 'unsafe-inline' — the bundle text rides the srcDoc.
 */
const vendorCache = new Map<string, Promise<string>>();

function loadVendorBundle(lib: string): Promise<string> {
  let cached = vendorCache.get(lib);
  if (!cached) {
    cached = fetch(`/api/agent/visual-vendor/${encodeURIComponent(lib)}`).then((response) => {
      if (!response.ok) throw new Error(`vendor bundle ${lib}: ${response.status}`);
      return response.text();
    });
    cached.catch(() => vendorCache.delete(lib));
    vendorCache.set(lib, cached);
  }
  return cached;
}

/** Resolves a visual's lib list (payload-provided, best-effort). */
function visualLibs(visual: VisualSpec): string[] {
  const libs = (visual as VisualSpec & { libs?: string[] }).libs;
  return Array.isArray(libs) ? libs.filter((l) => typeof l === 'string' && /^[a-z0-9-]+$/.test(l)) : [];
}

/** Injects the vendor bundles at the top of <head> (or before the document). */
async function injectVendorLibs(html: string, libs: string[]): Promise<string> {
  if (libs.length === 0) return html;
  const parts = await Promise.all(
    libs.map((lib) => loadVendorBundle(lib).then((code) => `<script>${code}</script>`).catch(() => `<!-- vendor ${lib} unavailable -->`)),
  );
  const blob = parts.join('\n');
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => `${match}\n${blob}`);
  return `${blob}\n${html}`;
}

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
      style={fill ? { width: '100%', height: '100%', display: 'block', border: 0, background: '#fff' } : { width: '100%', height, display: 'block', border: 0, background: '#fff' }}
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
      className="card"
      style={{
        position: 'relative',
        minWidth: 0,
        flex: 1,
        overflow: 'hidden',
        margin: 0,
        padding: 0,
        borderColor: picked ? 'rgb(var(--c-accent))' : 'var(--line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--line)', background: 'rgb(var(--c-elev))', padding: '6px 10px' }}>
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
          {index + 1}. {variant.title}
        </span>
        {picked ? (
          <span className="cap a" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
            chosen
          </span>
        ) : (
          <Tip label="Pick this frontend">
            <button
              type="button"
              className="ib xs"
              onClick={() => onPick(variant.id)}
              aria-label={`Pick ${variant.title}`}
            >
              <Check className="ic" aria-hidden="true" />
            </button>
          </Tip>
        )}
      </div>
      <div style={{ background: '#fff' }}>
        {html !== undefined ? (
          <iframe
            title={variant.title || `Variant ${index + 1}`}
            sandbox={VISUAL_SANDBOX}
            {...CSP_ATTR}
            srcDoc={injectVisualRuntime(enforceCsp(html), variant.id)}
            referrerPolicy="no-referrer"
            style={{ width: '100%', height: clampVisualHeight(variant.height || 420), display: 'block', border: 0, background: '#fff' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240, fontSize: 11.5, color: 'var(--faint)' }}>
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
    const base = visual.html !== undefined ? Promise.resolve(visual.html) : loadVisualHtml(visual);
    const libs = visualLibs(visual);
    base
      .then((html) => (libs.length > 0 ? injectVendorLibs(html, libs) : html))
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
    () => (resolvedHtml === undefined ? '' : injectVisualRuntime(enforceCsp(resolvedHtml), visual.id)),
    [resolvedHtml, visual.id, liveToken],
  );
  if (resolvedHtml === undefined) {
    return (
      <div
        className="card"
        style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', width: width ?? '100%', height, margin: '4px 0 0', padding: 0 }}
      >
        <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>Loading visual…</span>
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
        className="card"
        style={{ position: 'relative', marginTop: 4, maxWidth: '100%', overflow: 'hidden', padding: 0, width: width ?? '100%' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--line)', background: 'rgb(var(--c-elev))', padding: '6px 12px' }}>
          <ShieldCheck className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" />
          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
            {visual.title}
          </span>
          <span className="show-sm" style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--faint)' }}>
            {pickedVariant ? 'pick locked' : `${variants.length} candidates — pick one`}
          </span>
          <Tip label="Open fullscreen">
            <button
              type="button"
              className="ib xs"
              onClick={() => onFullscreen(pickedVariant ?? visual)}
              aria-label="Open fullscreen"
            >
              <Maximize2 className="ic" aria-hidden="true" />
            </button>
          </Tip>
        </div>
        <div className="var-row">
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
      className="card"
      style={{ position: 'relative', marginTop: 4, maxWidth: '100%', overflow: 'hidden', padding: 0, width: width ?? '100%' }}
    >
      {/** The title bar; VISUAL v2 shows the edit-in-place badge. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--line)', background: 'rgb(var(--c-elev))', padding: '6px 12px' }}>
        <button
          type="button"
          onClick={() => setBodyOpen((value) => !value)}
          aria-expanded={bodyOpen}
          aria-label={bodyOpen ? 'Collapse visual panel' : 'Expand visual panel'}
          style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 8, textAlign: 'left', color: 'inherit' }}
        >
          <ChevronDown
            className="chev"
            style={{ color: 'var(--faint)', transition: 'transform .2s', transform: bodyOpen ? undefined : 'rotate(-90deg)' }}
            aria-hidden="true"
          />
          <ShieldCheck className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" />
          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
            {visual.title}
          </span>
        </button>
        {visual.replaces ? (
          <Tip label="The agent updated this card in place — earlier frames stay in history above.">
            <span className="cap a show-sm">
              edited in place
            </span>
          </Tip>
        ) : null}
        <Tip label={autoFit ? 'Auto-fit is on — height follows the content' : 'Fit content (auto-height)'}>
          <button
            type="button"
            className={cx('ib xs', autoFit && 'on')}
            onClick={fitContent}
            aria-label="Fit content"
          >
            <UnfoldVertical className="ic" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Shorter (manual height, disables auto-fit)">
          <button
            type="button"
            className="ib xs"
            onClick={() => takeManualHeight(height - 180)}
            aria-label="Decrease height"
          >
            <ChevronsDownUp className="ic" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Taller (manual height, disables auto-fit)">
          <button
            type="button"
            className="ib xs"
            onClick={() => takeManualHeight(height + 180)}
            aria-label="Increase height"
          >
            <ChevronsUpDown className="ic" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Open fullscreen">
          <button
            type="button"
            className="ib xs"
            onClick={() => onFullscreen(visual)}
            aria-label="Open fullscreen"
          >
            <Maximize2 className="ic" aria-hidden="true" />
          </button>
        </Tip>
      </div>
      {/** The payload frame; the copy affordance lives in fullscreen.
          COLLAPSE: grid-rows 0fr↔1fr (pola CollapsePanel) — tinggi kartu
          dianimasikan mulus dua arah; resize handles ikut hilang saat
          tertutup (separator tanpa konten membingungkan). */}
      <div className={cx('col', !bodyOpen && 'shut')} aria-hidden={!bodyOpen}>
        <div className="col-in">
          <div style={{ background: '#fff' }}>
            <VisualFrame visual={visual} height={height} frameRef={frameRef} srcDoc={srcDoc ?? ''} />
          </div>
          {/** Windowed resize handles (see RESIZE_HANDLES). */}
          {bodyOpen ? (
            RESIZE_HANDLES.map((handle) => (
              <div
                key={handle.dir}
                role="separator"
                className="rz-h"
                style={{ position: 'absolute', zIndex: 20, touchAction: 'none', ...handle.style }}
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
    const base = visual.html !== undefined ? Promise.resolve(visual.html) : loadVisualHtml(visual);
    const libs = visualLibs(visual);
    base
      .then((html) => (libs.length > 0 ? injectVendorLibs(html, libs) : html))
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
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', flexDirection: 'column', background: 'rgb(var(--c-shadow) / 0.85)', backdropFilter: 'blur(4px)' }}
      role="dialog"
      aria-modal="true"
      aria-label={visual.title || 'Agent visual'}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px' }}>
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-paper) / 0.9)' }}>{visual.title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 'var(--r-md)', background: 'rgb(var(--c-paper) / 0.1)', padding: 3 }}>
          {FULLSCREEN_WIDTHS.map((mode) => (
            <button
              key={mode.id}
              type="button"
              style={{
                borderRadius: 999,
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 500,
                color: widthMode === mode.width ? '#000' : 'rgb(var(--c-paper) / 0.7)',
                background: widthMode === mode.width ? 'rgb(var(--c-paper))' : 'transparent',
              }}
              onClick={() => setWidthMode(mode.width)}
              aria-pressed={widthMode === mode.width}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <span className="show-sm" style={{ fontSize: 11, color: 'rgb(var(--c-paper) / 0.5)' }}>sandboxed · no network</span>
        <button
          type="button"
          style={{ display: 'grid', placeItems: 'center', borderRadius: 'var(--r-md)', padding: 6, color: 'rgb(var(--c-paper) / 0.7)' }}
          onClick={onClose}
          aria-label="Close fullscreen"
        >
          <X className="ic" style={{ width: 20, height: 20 }} aria-hidden="true" />
        </button>
      </div>
      <div ref={stageRef} style={{ position: 'relative', minHeight: 0, flex: 1, padding: 16 }}>
        {srcDoc !== null && widthMode === 0 ? (
          <div style={{ height: '100%' }}>
            <VisualFrame visual={visual} height={0} fill srcDoc={srcDoc} />
          </div>
        ) : null}
        {srcDoc !== null && widthMode > 0 ? (() => {
          // Responsive preview: the iframe keeps its TRUE device width (the
          const scale = stageWidth > 0 ? Math.min(1, stageWidth / widthMode) : 1;
          const stageHeight = stageRef.current?.clientHeight ?? 0;
          return (
            <div style={{ height: '100%', overflow: 'hidden' }}>
              <iframe
                title={visual.title || 'Agent visual'}
                sandbox={VISUAL_SANDBOX}
                {...CSP_ATTR}
                srcDoc={srcDoc}
                referrerPolicy="no-referrer"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transformOrigin: 'top left',
                  border: 0,
                  background: '#fff',
                  boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.5)',
                  width: widthMode,
                  height: stageHeight > 0 ? Math.round(stageHeight / scale) : '100%',
                  transform: `translateX(-${(widthMode * scale) / 2}px) scale(${scale})`,
                }}
              />
            </div>
          );
        })() : null}
        {srcDoc === null ? (
          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'rgb(var(--c-paper) / 0.6)' }}>Loading…</div>
        ) : null}
      </div>
    </div>
  );
}
