import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Copy,
  Crop,
  Download,
  ImagePlus,
  Maximize,
  Maximize2,
  Minimize,
  SquarePen,
  X,
  ZoomIn,
  ZoomOut,
} from './icons';

import { Tip } from './ui';

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

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Double-click jumps to this magnification (and back to fit). */
const DBL_CLICK_SCALE = 2.5;

/**
 * Full-size image preview with zoom, over a dark backdrop.
 *
 * Zooming works like a standard lightbox: mouse wheel zooms toward the cursor,
 * dragging pans while magnified, PINCH zooms and pans with two fingers on
 * touch screens, double-click (or the ⤢ button) toggles between fit and
 * magnified, and the −/%/+ pills or the +/−/0 keys give fine control.
 * Click the backdrop or press Escape to close; the Download button saves the
 * file (same-origin local images download directly) and the Fullscreen button
 * next to it expands the preview to the whole screen (element Fullscreen API,
 * with a CSS-expansion fallback for browsers without it, like iPhone Safari).
 *
 * For images saved locally, the creation metadata — the prompt that produced
 * the image, its model and provider — is fetched from the proxy and shown
 * under the image, with "Copy prompt" and (in Image Studio) "Use this prompt".
 * CDN links and images downloaded before this feature have no metadata and
 * simply render without the panel.
 */
export function ImageLightbox({
  url,
  onClose,
  onUsePrompt,
  onUseReference,
  onEditImage,
}: {
  url: string;
  onClose: () => void;
  onUsePrompt?: (prompt: string) => void;
  /** Adds this image to Image Studio's reference tray. */
  onUseReference?: () => void;
  /** Opens the client-side editor (crop / rotate / resize) for this image. */
  onEditImage?: () => void;
}) {
  const [meta, setMeta] = useState<CreationMeta | null>(null);
  const [copied, setCopied] = useState(false);
  /** 1 = fit the stage; above that the image is magnified and pannable. */
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /** Whole-preview expansion: element fullscreen, or a CSS fallback. */
  const [expanded, setExpanded] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  /** Every active finger, for pinch detection. */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    baseDist: number;
    baseScale: number;
    baseMid: { x: number; y: number };
    baseOffset: { x: number; y: number };
  } | null>(null);
  /** Set once a drag actually moved; the backdrop click then must not close. */
  const draggedRef = useRef(false);

  /** Keeps the translated image from flying away: it may only move as far as
      its magnified overflow allows, and springs back to centered otherwise. */
  const clampOffset = useCallback((nextScale: number, next: { x: number; y: number }) => {
    const stage = stageRef.current;
    if (!stage) return next;
    const maxX = Math.max(0, ((nextScale - 1) * stage.clientWidth) / 2);
    const maxY = Math.max(0, ((nextScale - 1) * stage.clientHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  /** Zooms keeping the point under the cursor pinned in place. */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, nextScale: number) => {
      const stage = stageRef.current;
      const prev = scaleRef.current;
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
      if (!stage || clamped === prev) return;
      const rect = stage.getBoundingClientRect();
      const px = clientX - rect.left - rect.width / 2;
      const py = clientY - rect.top - rect.height / 2;
      const k = clamped / prev;
      const next = clampOffset(clamped, {
        x: px - (px - offsetRef.current.x) * k,
        y: py - (py - offsetRef.current.y) * k,
      });
      scaleRef.current = clamped;
      offsetRef.current = next;
      setScale(clamped);
      setOffset(next);
    },
    [clampOffset],
  );

  const resetZoom = useCallback(() => {
    scaleRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, scaleRef.current * factor);
    },
    [zoomAt],
  );

  useEffect(() => {
    resetZoom();
  }, [url, resetZoom]);

  // native flows) expands the preview, leaving it (Esc) collapses again.
  useEffect(() => {
    const onFsChange = () => setExpanded(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  /** Whole-preview expansion: real element fullscreen where supported
      (desktop, Android), a CSS fallback where not (iPhone Safari). */
  const toggleExpanded = () => {
    const el = rootRef.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => setExpanded(false));
      return;
    }
    if (el?.requestFullscreen) {
      el.requestFullscreen().catch(() => setExpanded(true));
    } else {
      setExpanded((value) => !value);
    }
  };

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

  // browser's own exit-fullscreen key and must not also close the preview.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.fullscreenElement) return;
        onClose();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomBy(1.2);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomBy(1 / 1.2);
      } else if (event.key === '0') {
        event.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomBy, resetZoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
      zoomAt(event.clientX, event.clientY, scaleRef.current * factor);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onImagePointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    draggedRef.current = false;

    if (pointersRef.current.size === 2) {
      dragRef.current = null;
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        baseDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        baseScale: scaleRef.current,
        baseMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        baseOffset: { ...offsetRef.current },
      };
    } else if (pointersRef.current.size === 1) {
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: offsetRef.current.x,
        baseY: offsetRef.current.y,
      };
    }
  };

  const onImagePointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const stage = stageRef.current;
      if (!stage) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const rect = stage.getBoundingClientRect();
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, (pinch.baseScale * dist) / pinch.baseDist),
      );
      const k = nextScale / pinch.baseScale;
      const px = mid.x - rect.left - rect.width / 2;
      const py = mid.y - rect.top - rect.height / 2;
      offsetRef.current = clampOffset(nextScale, {
        x: px - (px - pinch.baseOffset.x) * k + (mid.x - pinch.baseMid.x),
        y: py - (py - pinch.baseOffset.y) * k + (mid.y - pinch.baseMid.y),
      });
      scaleRef.current = nextScale;
      setScale(nextScale);
      setOffset(offsetRef.current);
      draggedRef.current = true;
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) draggedRef.current = true;
    offsetRef.current = clampOffset(scaleRef.current, { x: drag.baseX + dx, y: drag.baseY + dy });
    setOffset(offsetRef.current);
  };

  const endDrag = (event: React.PointerEvent<HTMLImageElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 1) {
      const [restId] = [...pointersRef.current.keys()];
      const [rest] = [...pointersRef.current.values()];
      dragRef.current = {
        pointerId: restId,
        startX: rest.x,
        startY: rest.y,
        baseX: offsetRef.current.x,
        baseY: offsetRef.current.y,
      };
    } else {
      dragRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onImageDoubleClick = (event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (scaleRef.current === 1) {
      zoomAt(event.clientX, event.clientY, DBL_CLICK_SCALE);
    } else {
      resetZoom();
    }
  };

  const copyPrompt = async () => {
    if (!meta) return;
    try {
      await navigator.clipboard.writeText(meta.prompt);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = meta.prompt;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const usePrompt = () => {
    if (!meta || !onUsePrompt) return;
    onUsePrompt(meta.prompt);
    onClose();
  };

  const magnified = scale > 1;
  const gesturing = dragRef.current !== null || pinchRef.current !== null;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Image preview"
      className={
        expanded
          ? 'fixed inset-0 z-[60] flex flex-col items-center gap-2 overflow-hidden bg-black p-2'
          : 'fixed inset-0 z-[60] flex flex-col items-center gap-3 overflow-hidden bg-black/85 p-6'
      }
      onClick={() => {
        if (!draggedRef.current) onClose();
        draggedRef.current = false;
      }}
    >
      <button
        type="button"
        aria-label="Close preview"
        className="absolute right-4 top-4 z-10 rounded-control bg-black/50 p-2 text-white/80 transition-colors hover:text-white"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>

      {}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center self-stretch overflow-hidden"
        onClick={(event) => {
          // click landing on the STAGE ITSELF (not the img) closes the preview
          if (event.target === event.currentTarget && !draggedRef.current) onClose();
          draggedRef.current = false;
        }}
      >
        <img
          src={url}
          alt="Image, full size"
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={onImagePointerDown}
          onPointerMove={onImagePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onImageDoubleClick}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            maxHeight: expanded ? 'calc(100dvh - 88px)' : 'calc(100dvh - 220px)',
            transition: gesturing ? 'none' : 'transform 180ms ease-out',
            cursor: magnified ? (gesturing ? 'grabbing' : 'grab') : 'zoom-in',
            touchAction: 'none',
          }}
          className={
            expanded
              ? 'max-w-full select-none rounded-card border border-hairline object-contain shadow-popover will-change-transform'
              : 'max-w-[90vw] select-none rounded-card border border-hairline object-contain shadow-popover will-change-transform'
          }
        />
      </div>

      {}
      {meta && !expanded ? (
        <div
          className="flex w-full max-w-[680px] shrink-0 flex-col gap-2.5 rounded-card border border-hairline bg-black/60 p-4 backdrop-blur-sm"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-white/85">
            {meta.prompt}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {meta.model ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                {meta.model}
              </span>
            ) : null}
            {meta.provider ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                {meta.provider}
              </span>
            ) : null}
            {meta.requested ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                {meta.requested.width}×{meta.requested.height} requested
              </span>
            ) : null}
            {meta.output &&
            (!meta.requested ||
              meta.output.width !== meta.requested.width ||
              meta.output.height !== meta.requested.height) ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                {meta.output.width}×{meta.output.height} actual
              </span>
            ) : null}
            {meta.aspectRatio ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                {meta.aspectRatio}
              </span>
            ) : null}
            {meta.createdAt ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                {new Date(meta.createdAt).toLocaleString()}
              </span>
            ) : null}
            <span className="min-w-2 flex-1" />
            <button
              type="button"
              onClick={copyPrompt}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-white/20"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy prompt'}
            </button>
            {onUsePrompt ? (
              <button
                type="button"
                onClick={usePrompt}
                className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-white/20"
              >
                <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
                Use this prompt
              </button>
            ) : null}
            {onUseReference ? (
              <button
                type="button"
                onClick={onUseReference}
                className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-white/20"
              >
                <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                Use as reference
              </button>
            ) : null}
            {onEditImage ? (
              <button
                type="button"
                onClick={onEditImage}
                className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-white/20"
              >
                <Crop className="h-3.5 w-3.5" aria-hidden="true" />
                Edit image
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {}
      <div
        className="flex w-full max-w-full shrink-0 flex-wrap items-center justify-center gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-1.5 text-white/90">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={!magnified}
            className="rounded-full p-1.5 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40"
            onClick={() => zoomBy(1 / 1.2)}
          >
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </button>
          <Tip label="Reset zoom (0)">
            <button
              type="button"
              aria-label="Reset zoom to fit"
              className="min-w-[52px] rounded-full px-1.5 py-1 text-[12px] tabular-nums transition-colors hover:bg-white/15 hover:text-white"
              onClick={resetZoom}
            >
              {Math.round(scale * 100)}%
            </button>
          </Tip>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={scale >= MAX_SCALE}
            className="rounded-full p-1.5 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40"
            onClick={() => zoomBy(1.2)}
          >
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden="true" />
          <Tip label="Double-click also toggles this">
            <button
              type="button"
              aria-label={magnified ? 'Fit to screen' : 'Magnify image'}
              className="rounded-full p-1.5 transition-colors hover:bg-white/15 hover:text-white"
              onClick={(event) => {
                if (magnified) {
                  resetZoom();
                } else {
                  const rect = event.currentTarget.getBoundingClientRect();
                  zoomAt(rect.left, rect.top, DBL_CLICK_SCALE);
                }
              }}
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>
        </div>

        <Tip label="Download">
          <a
            href={url}
            download
            aria-label="Download"
            className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-2 text-[13px] text-white/90 transition-colors hover:text-white sm:px-4"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Download</span>
          </a>
        </Tip>

        <Tip label={expanded ? 'Exit fullscreen' : 'Open fullscreen'}>
          <button
            type="button"
            aria-label={expanded ? 'Exit fullscreen' : 'Open fullscreen'}
            onClick={toggleExpanded}
            className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-2 text-[13px] text-white/90 transition-colors hover:text-white sm:px-4"
          >
            {expanded ? (
              <Minimize className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">{expanded ? 'Exit' : 'Fullscreen'}</span>
          </button>
        </Tip>
      </div>
    </div>,
    document.body,
  );
}
