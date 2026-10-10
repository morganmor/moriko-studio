import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crop,
  Download,
  ImagePlus,
  Maximize,
  Minimize,
  Minus,
  PanelRight,
  Plus,
  RotateCcw,
  Save,
  X,
} from './icons';

import { cx } from './ui';

/** Creation metadata saved beside downloaded images by the proxy. */
interface CreationMeta {
  prompt: string;
  model?: string;
  provider?: string;
  createdAt?: string;
  /** The pixel size the user requested, if any. */
  requested?: { width: number; height: number } | null;
  /** The real pixel size of the saved file, read from the image itself. */
  output?: { width: number; height: number } | null;
  /** The aspect-ratio preset that was sent, if any. */
  aspectRatio?: string | null;
}

/** Design zoom range: 100%–600%. */
const MIN_SCALE = 1;
const MAX_SCALE = 6;
/** Double-click jumps to this magnification (and back to fit). */
const DBL_CLICK_SCALE = 2.5;
/** Keyboard / dock zoom step (design: ×1.3 per press). */
const ZOOM_STEP = 1.3;
const fmtDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Image viewer — a React port of design/image-viewer.html (.vr dialog).
 *
 * Anatomy (design): ambient blur + scrim, a stage (viewport → frame → image),
 * a top bar with the glass meta pill (title + counter) and the glass actions
 * (favorite, download, details, fullscreen, close), round prev/next buttons, a
 * bottom dock with the thumbnail strip + zoom controls, an aria-live toast,
 * and a right side panel (prompt + details + shortcuts + Download / Reuse
 * prompt CTAs).
 *
 * Mechanism (design): wheel zooms toward the cursor (100–600%), drag pans
 * while magnified, pinch zooms, double-click toggles 250%, swipe left/right
 * navigates when not zoomed, tapping outside the image closes. Keys: arrows
 * browse, +/−/0 zoom, I details, F fullscreen, C copy prompt, Esc close; Tab
 * is trapped inside the dialog. Chrome auto-hides after 2.5s idle while
 * fullscreen (CSS focus-mode fallback where the Fullscreen API is missing).
 *
 * Theme: the chrome keeps the design's scoped dark tokens (.vr defines them);
 * the accent follows the active moriko accent (--c-accent).
 */
export function ImageLightbox({
  url,
  onClose,
  onUsePrompt,
  onUseReference,
  onEditImage,
  urls,
  onNavigate,
  saved,
  onToggleSave,
  title,
  prompt,
}: {
  url: string;
  onClose: () => void;
  onUsePrompt?: (prompt: string) => void;
  /** Adds this image to Image Studio's reference tray. */
  onUseReference?: () => void;
  /** Opens the client-side editor (crop / rotate / resize) for this image. */
  onEditImage?: () => void;
  /** Design prev/next mechanism: the full list this image belongs to. */
  urls?: string[];
  /** Moves the preview to another member of `urls`. */
  onNavigate?: (url: string) => void;
  /** Design save icon: whether this image is saved to the Gallery… */
  saved?: boolean;
  /** …and its toggle (save when unsaved, remove when saved). */
  onToggleSave?: () => void;
  /** Design title (bar + panel header); falls back to the prompt's first line. */
  title?: string;
  /** Prompt text for the panel when no proxy metadata exists (CDN images). */
  prompt?: string;
}) {
  const [meta, setMeta] = useState<CreationMeta | null>(null);
  const [copied, setCopied] = useState(false);
  /** 1 = fit the frame; above that the image is magnified and pannable. */
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /** A pointer is down on the viewport (grabbing / no transition). */
  const [live, setLive] = useState(false);
  /** Side panel visibility (design: open when the window is wider than 860). */
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 860);
  /** Fullscreen (element API), or the CSS focus-mode fallback. */
  const [focusMode, setFocusMode] = useState(false);
  const [idle, setIdle] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  /** Navigation direction of the last step: frame slides in from it. */
  const [navDir, setNavDir] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const startRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
    target: EventTarget | null;
  } | null>(null);
  const pinchRef = useRef<{ d: number; sc: number } | null>(null);
  const idleTRef = useRef<number | null>(null);
  const toastTRef = useRef<number | null>(null);
  const copiedTRef = useRef<number | null>(null);
  const panelOpenRef = useRef(panelOpen);
  const focusRef = useRef(focusMode);
  panelOpenRef.current = panelOpen;
  focusRef.current = focusMode;

  /* ── zoom / pan engine (design settle / zoomAt / rel) ─────────────── */

  /** Snaps back to fit at ≤100%, else clamps the pan to the magnified
      overflow of the image inside the viewport (design settle()). */
  const settle = useCallback(() => {
    let nextScale = scaleRef.current;
    let nextOffset = { ...offsetRef.current };
    if (nextScale <= 1.001) {
      nextScale = 1;
      nextOffset = { x: 0, y: 0 };
    } else {
      const img = imgRef.current;
      const vp = vpRef.current;
      if (img && vp) {
        const mx = Math.max(0, (img.offsetWidth * nextScale - vp.clientWidth) / 2);
        const my = Math.max(0, (img.offsetHeight * nextScale - vp.clientHeight) / 2);
        nextOffset = {
          x: Math.min(mx, Math.max(-mx, nextOffset.x)),
          y: Math.min(my, Math.max(-my, nextOffset.y)),
        };
      }
    }
    scaleRef.current = nextScale;
    offsetRef.current = nextOffset;
    setScale(nextScale);
    setOffset(nextOffset);
  }, []);

  /** Cursor point relative to the frame centre (design rel()). */
  const rel = useCallback((clientX: number, clientY: number): [number, number] => {
    const box = (frameRef.current ?? vpRef.current)?.getBoundingClientRect();
    if (!box) return [0, 0];
    return [clientX - box.left - box.width / 2, clientY - box.top - box.height / 2];
  }, []);

  /** Zooms keeping the point under the cursor pinned in place (design zoomAt). */
  const zoomAt = useCallback(
    (next: number, cx = 0, cy = 0) => {
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      const k = clamped / scaleRef.current;
      offsetRef.current = {
        x: cx - (cx - offsetRef.current.x) * k,
        y: cy - (cy - offsetRef.current.y) * k,
      };
      scaleRef.current = clamped;
      settle();
    },
    [settle],
  );

  const zoomBy = useCallback((factor: number) => zoomAt(scaleRef.current * factor), [zoomAt]);
  const resetZoom = useCallback(() => zoomAt(1), [zoomAt]);

  /* ── chrome: idle, panel, fullscreen/focus ────────────────────────── */

  /** Rearms the 2.5s chrome auto-hide while focused/fullscreen (design wake). */
  const wake = useCallback(() => {
    setIdle(false);
    if (idleTRef.current) window.clearTimeout(idleTRef.current);
    if (focusRef.current) idleTRef.current = window.setTimeout(() => setIdle(true), 2500);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTRef.current) window.clearTimeout(toastTRef.current);
    toastTRef.current = window.setTimeout(() => setToast(null), 1700);
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((value) => !value);
    wake();
  }, [wake]);

  /** Entering focus (fullscreen): remember the panel state, hide the panel. */
  const enterFocus = useCallback(() => {
    panelWasRef.current = panelOpenRef.current;
    setPanelOpen(false);
    setFocusMode(true);
    wake();
  }, [wake]);

  /** Leaving focus: restore the panel as it was (design setFocus/setPanel). */
  const exitFocus = useCallback(() => {
    setFocusMode(false);
    setPanelOpen(panelWasRef.current);
    setIdle(false);
    if (idleTRef.current) window.clearTimeout(idleTRef.current);
  }, []);

  const panelWasRef = useRef(true);

  const toggleFs = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    const el = rootRef.current;
    if (el?.requestFullscreen) {
      try {
        await el.requestFullscreen();
        return;
      } catch {
        // Fall through to the CSS focus mode.
      }
    }
    if (focusRef.current) exitFocus();
    else enterFocus();
  }, [enterFocus, exitFocus]);

  /* ── navigation (design show / go) ────────────────────────────────── */

  const listIndex = urls && urls.length > 1 ? urls.indexOf(url) : -1;

  const step = useCallback(
    (direction: number) => {
      if (!urls || !onNavigate || urls.length < 2) return;
      const index = urls.indexOf(url);
      const next = (index + direction + urls.length) % urls.length;
      setNavDir(direction);
      onNavigate(urls[next]);
    },
    [urls, onNavigate, url],
  );

  /* ── actions (design copy / download / toggleFav / reuse) ─────────── */

  const promptText = prompt || meta?.prompt || '';

  const copyPrompt = useCallback(async () => {
    if (!promptText) return;
    try {
      await navigator.clipboard.writeText(promptText);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = promptText;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    setCopied(true);
    if (copiedTRef.current) window.clearTimeout(copiedTRef.current);
    copiedTRef.current = window.setTimeout(() => setCopied(false), 1600);
    showToast('Prompt copied');
  }, [promptText, showToast]);

  const download = useCallback(() => {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    showToast('Download started');
  }, [url, showToast]);

  const toggleSave = () => {
    if (!onToggleSave) return;
    onToggleSave();
    showToast(saved ? 'Removed from gallery' : 'Added to gallery');
  };

  const reusePrompt = () => {
    if (!onUsePrompt || !promptText) return;
    onUsePrompt(promptText);
    showToast('Prompt sent to the editor');
  };

  /** Bar title + panel heading: design title, else the prompt's first line. */
  const heading = useMemo(() => {
    if (title) return title;
    const first = promptText.split(/[\n.]/)[0]?.trim() ?? '';
    if (!first) return 'Image';
    return first.length > 48 ? `${first.slice(0, 47).trimEnd()}…` : first;
  }, [title, promptText]);

  /** Panel DETAILS rows: only the fields that exist (design kv list). */
  const details = useMemo(() => {
    const rows: Array<[string, string]> = [];
    if (meta?.model) rows.push(['Model', meta.model]);
    if (meta?.provider) rows.push(['Provider', meta.provider]);
    const size = meta?.output ?? meta?.requested ?? null;
    if (size) rows.push(['Size', `${size.width}×${size.height}`]);
    if (meta?.createdAt) rows.push(['Created', fmtDate.format(new Date(meta.createdAt))]);
    return rows;
  }, [meta]);

  /* ── effects ──────────────────────────────────────────────────────── */

  // New image: back to fit (design show() resets sc/tx/ty).
  useEffect(() => {
    resetZoom();
    setMoreOpen(false);
  }, [url, resetZoom]);

  // Proxy metadata for local images (model / provider / size / created).
  useEffect(() => {
    const match = /\/api\/images\/local\/([a-zA-Z0-9_-]+\.(?:png|jpe?g|webp))$/.exec(url);
    if (!match) {
      setMeta(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/images/meta/${encodeURIComponent(match[1])}`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<CreationMeta>) : null))
      .then((data) => setMeta(data && data.prompt ? data : null))
      .catch(() => setMeta(null));
    return () => controller.abort();
  }, [url]);

  // Design "Show more": only offered when the prompt overflows its box.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) {
      setHasMore(false);
      return;
    }
    setHasMore(el.scrollHeight > el.clientHeight + 2);
  }, [promptText, panelOpen]);

  // Closed panel is inert (design side.inert = !panelOpen).
  useEffect(() => {
    sideRef.current?.toggleAttribute('inert', !panelOpen);
  }, [panelOpen]);

  // Fullscreen ↔ focus mode (design fullscreenchange → setFocus).
  useEffect(() => {
    const onFsChange = () => {
      if (document.fullscreenElement) enterFocus();
      else exitFocus();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [enterFocus, exitFocus]);

  // Focus the dialog, lock body scroll, restore both (design open/close).
  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      openerRef.current?.focus();
      if (idleTRef.current) window.clearTimeout(idleTRef.current);
      if (toastTRef.current) window.clearTimeout(toastTRef.current);
      if (copiedTRef.current) window.clearTimeout(copiedTRef.current);
    };
  }, []);

  // Keyboard (design): browse, zoom, details, fullscreen, copy, close + Tab trap.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      if (key === 'Escape') {
        if (document.fullscreenElement) return;
        onClose();
      } else if (key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (key === '+' || key === '=') {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (key === '-' || key === '_') {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (key === '0') {
        event.preventDefault();
        resetZoom();
      } else if (key === 'i' || key === 'I') {
        togglePanel();
      } else if (key === 'f' || key === 'F') {
        void toggleFs();
      } else if (key === 'c' || key === 'C') {
        void copyPrompt();
      } else if (key === 'Tab') {
        const root = rootRef.current;
        if (!root) return;
        const nodes = [
          ...root.querySelectorAll<HTMLElement>('button,[href],[tabindex]:not([tabindex="-1"])'),
        ].filter(
          (el) => !el.hasAttribute('disabled') && !el.closest('[inert]') && el.getClientRects().length,
        );
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step, zoomBy, resetZoom, togglePanel, toggleFs, copyPrompt]);

  // Wheel zoom toward the cursor (design: exp curve, ctrl = fine).
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const [cx, cy] = rel(event.clientX, event.clientY);
      zoomAt(scaleRef.current * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018)), cx, cy);
      wake();
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [zoomAt, rel, wake]);

  /* ── pointer: pan / pinch / swipe / tap-to-close (design vp) ──────── */

  const onVpPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const vp = vpRef.current;
    if (!vp) return;
    vp.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setLive(true);
    if (pointersRef.current.size === 1) {
      startRef.current = {
        x: event.clientX,
        y: event.clientY,
        tx: offsetRef.current.x,
        ty: offsetRef.current.y,
        target: event.target,
      };
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, sc: scaleRef.current };
    }
  };

  const onVpPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const ptrs = pointersRef.current;
    if (!ptrs.has(event.pointerId)) return;
    ptrs.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const pinch = pinchRef.current;
    if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const [cx, cy] = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomAt((pinch.sc * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, cx, cy);
      return;
    }

    const start = startRef.current;
    if (ptrs.size === 1 && start && scaleRef.current > 1) {
      offsetRef.current = {
        x: start.tx + event.clientX - start.x,
        y: start.ty + event.clientY - start.y,
      };
      settle();
    }
  };

  const releasePointer = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const ptrs = pointersRef.current;
    if (!ptrs.has(event.pointerId)) return;
    ptrs.delete(event.pointerId);
    if (ptrs.size < 2) pinchRef.current = null;

    if (ptrs.size === 1) {
      const [, pos] = [...ptrs.values()];
      startRef.current = {
        x: pos.x,
        y: pos.y,
        tx: offsetRef.current.x,
        ty: offsetRef.current.y,
        target: null,
      };
    } else if (ptrs.size === 0) {
      setLive(false);
      const start = startRef.current;
      if (start && !cancelled && scaleRef.current === 1) {
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        // Not zoomed: a hard horizontal swipe browses, a tap outside closes.
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          step(dx < 0 ? 1 : -1);
        } else if (Math.hypot(dx, dy) < 4 && start.target && start.target !== imgRef.current) {
          onClose();
        }
      }
      startRef.current = null;
    }

    const vp = vpRef.current;
    if (vp?.hasPointerCapture(event.pointerId)) vp.releasePointerCapture(event.pointerId);
  };

  const onImgDoubleClick = (event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    const [cx, cy] = rel(event.clientX, event.clientY);
    zoomAt(scaleRef.current > 1 ? 1 : DBL_CLICK_SCALE, cx, cy);
  };

  const magnified = scale > 1;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className={cx('vr', idle && 'is-idle')}
      onPointerMove={wake}
    >
      <div
        key={`amb-${url}`}
        className="vamb"
        style={{ backgroundImage: `url("${url}")` }}
        aria-hidden="true"
      />
      <div className="vscrim" aria-hidden="true" />

      <section className="vstage">
        <div
          ref={vpRef}
          className={cx('vvp', live && 'live')}
          data-zoomed={magnified ? 'true' : 'false'}
          onPointerDown={onVpPointerDown}
          onPointerMove={onVpPointerMove}
          onPointerUp={(event) => releasePointer(event, false)}
          onPointerCancel={(event) => releasePointer(event, true)}
        >
          <div
            key={url}
            ref={frameRef}
            className="vframe"
            style={{ '--v-dx': `${navDir * 28}px` } as CSSProperties}
          >
            <img
              ref={imgRef}
              src={url}
              alt={heading}
              draggable={false}
              onDoubleClick={onImgDoubleClick}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
            />
          </div>
        </div>

        <header className="vbar vchrome">
          <div className="vmeta vglass">
            <h2>{heading}</h2>
            {listIndex >= 0 ? (
              <span className="vcount">
                {listIndex + 1} / {urls?.length}
              </span>
            ) : null}
          </div>
          <div className="vacts">
            {onToggleSave ? (
              <button
                type="button"
                className="vbtn vglass fav"
                aria-pressed={Boolean(saved)}
                aria-label={saved ? 'Remove from gallery' : 'Save to gallery'}
                data-tip={saved ? 'Remove from gallery' : 'Save to gallery'}
                onClick={toggleSave}
              >
                <Save className="ic" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="vbtn vglass"
              aria-label="Download"
              data-tip="Download"
              onClick={download}
            >
              <Download className="ic" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="vbtn vglass"
              aria-pressed={panelOpen}
              aria-label="Details"
              data-tip="Details · I"
              onClick={togglePanel}
            >
              <PanelRight className="ic" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="vbtn vglass"
              aria-pressed={focusMode}
              aria-label={focusMode ? 'Exit fullscreen' : 'Fullscreen'}
              data-tip="Fullscreen · F"
              onClick={() => void toggleFs()}
            >
              {focusMode ? (
                <Minimize className="ic" aria-hidden="true" />
              ) : (
                <Maximize className="ic" aria-hidden="true" />
              )}
            </button>
            <button
              ref={closeRef}
              type="button"
              className="vbtn vglass"
              aria-label="Close"
              data-tip="Close · Esc"
              data-tip-align="end"
              onClick={onClose}
            >
              <X className="ic" aria-hidden="true" />
            </button>
          </div>
        </header>

        {listIndex >= 0 ? (
          <>
            <button
              type="button"
              className="vbtn round vglass vnav prev vchrome"
              aria-label="Previous image"
              onClick={() => step(-1)}
            >
              <ChevronLeft className="ic" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="vbtn round vglass vnav next vchrome"
              aria-label="Next image"
              onClick={() => step(1)}
            >
              <ChevronRight className="ic" aria-hidden="true" />
            </button>

            <div className="vdock vglass vchrome">
              <div className="vthumbs">
                {urls?.map((entry, index) => (
                  <button
                    key={entry}
                    type="button"
                    className="vth"
                    aria-current={index === listIndex}
                    aria-label={`Show image ${index + 1}`}
                    onClick={() => {
                      setNavDir(index > listIndex ? 1 : -1);
                      onNavigate?.(entry);
                    }}
                  >
                    <img src={entry} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
              <span className="vdivider" aria-hidden="true" />
              <div className="vzoom">
                <button
                  type="button"
                  className="vbtn ghost"
                  aria-label="Zoom out"
                  data-tip="Zoom out · −"
                  data-tip-pos="top"
                  onClick={() => zoomBy(1 / ZOOM_STEP)}
                >
                  <Minus className="ic" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="vpct"
                  aria-label="Reset zoom"
                  data-tip="Reset · 0"
                  data-tip-pos="top"
                  onClick={resetZoom}
                >
                  {Math.round(scale * 100)}%
                </button>
                <button
                  type="button"
                  className="vbtn ghost"
                  aria-label="Zoom in"
                  data-tip="Zoom in · +"
                  data-tip-pos="top"
                  onClick={() => zoomBy(ZOOM_STEP)}
                >
                  <Plus className="ic" aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        ) : null}

        <div className={cx('vtoast', toast && 'show')} role="status" aria-live="polite">
          <Check className="ic" aria-hidden="true" />
          <span>{toast ?? ''}</span>
        </div>
      </section>

      <aside ref={sideRef} className={cx('vside', !panelOpen && 'closed')} aria-label="Image details">
        <div className="vside-h">
          {listIndex >= 0 ? (
            <div className="veyebrow">
              Image {listIndex + 1} of {urls?.length}
            </div>
          ) : null}
          <h3>{heading}</h3>
        </div>

        <div className="vside-b">
          {promptText ? (
            <section className="vsec">
              <div className="vlab">
                <span>Prompt</span>
                <button type="button" className="vchip" onClick={() => void copyPrompt()}>
                  {copied ? (
                    <Check className="ic" aria-hidden="true" />
                  ) : (
                    <Copy className="ic" aria-hidden="true" />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div ref={promptRef} className={cx('vprompt', moreOpen && 'open')}>
                {promptText}
              </div>
              {hasMore ? (
                <button
                  type="button"
                  className="vlink"
                  onClick={() => setMoreOpen((value) => !value)}
                >
                  {moreOpen ? 'Show less' : 'Show more'}
                </button>
              ) : null}
            </section>
          ) : null}

          {details.length ? (
            <section className="vsec">
              <div className="vlab">
                <span>Details</span>
              </div>
              <dl className="vkv">
                {details.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          <section className="vsec">
            <div className="vlab">
              <span>Shortcuts</span>
            </div>
            <ul className="vkeys">
              <li>
                <span>
                  <kbd>←</kbd>
                  <kbd>→</kbd>
                </span>
                Browse
              </li>
              <li>
                <span>
                  <kbd>+</kbd>
                  <kbd>−</kbd>
                  <kbd>0</kbd>
                </span>
                Zoom
              </li>
              <li>
                <span>
                  <kbd>I</kbd>
                </span>
                Details
              </li>
              <li>
                <span>
                  <kbd>F</kbd>
                </span>
                Fullscreen
              </li>
              <li>
                <span>
                  <kbd>C</kbd>
                </span>
                Copy prompt
              </li>
              <li>
                <span>
                  <kbd>Esc</kbd>
                </span>
                Close
              </li>
            </ul>
          </section>
        </div>

        <div className="vside-f">
          <button type="button" className="vcta" onClick={download}>
            <Download className="ic" aria-hidden="true" />
            Download
          </button>
          {onUsePrompt && promptText ? (
            <button type="button" className="vcta alt" onClick={reusePrompt}>
              <RotateCcw className="ic" aria-hidden="true" />
              Reuse prompt
            </button>
          ) : null}
          {onUseReference ? (
            <button type="button" className="vcta alt" onClick={onUseReference}>
              <ImagePlus className="ic" aria-hidden="true" />
              Use as reference
            </button>
          ) : null}
          {onEditImage ? (
            <button type="button" className="vcta alt" onClick={onEditImage}>
              <Crop className="ic" aria-hidden="true" />
              Edit image
            </button>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
