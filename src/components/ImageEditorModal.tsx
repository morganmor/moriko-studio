import { useEffect, useMemo, useRef, useState } from 'react';
import { FlipHorizontal, FlipVertical, RotateCcw, RotateCw } from './icons';

import { MAX_REFERENCE_BYTES, encodeWithinLimit } from '../lib/imageEdit';
import { useStore } from '../store/useStore';
import { Modal, cx } from './ui';

/** Crop aspect presets; 'free' keeps whatever rectangle the user drags. */
type Ratio = 'free' | '1:1' | '4:3' | '16:9' | '9:16';

const RATIOS: Array<{ id: Ratio; label: string }> = [
  { id: 'free', label: 'Free' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
];

/** Crop rectangle in fractions of the ORIENTED image (0..1). */
interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** Minimum crop size per axis, as a fraction — keeps handles grabbable. */
const MIN_SIZE = 0.04;
/** Output bounds matching the server's submit validation. */
const OUT_MIN = 64;
const OUT_MAX = 4096;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ratioNumber(ratio: Ratio): number | null {
  if (ratio === 'free') return null;
  const [a, b] = ratio.split(':').map(Number);
  return b ? a / b : null;
}

/** Largest centered rectangle of the given pixel ratio inside W×H. */
function fitCrop(ratio: Ratio, width: number, height: number): CropRect {
  const target = ratioNumber(ratio);
  if (!target || width <= 0 || height <= 0) return { ...FULL };
  let fw = 1;
  let fh = 1;
  if (width / height > target) {
    fh = 1;
    fw = (target * height) / width;
  } else {
    fw = 1;
    fh = width / (target * height);
  }
  return { x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh };
}

/** Maps a crop rect through an orientation change. */
function transformCrop(crop: CropRect, op: 'rot-cw' | 'rot-ccw' | 'flip-h' | 'flip-v'): CropRect {
  switch (op) {
    case 'rot-cw':
      return { x: 1 - crop.y - crop.h, y: crop.x, w: crop.h, h: crop.w };
    case 'rot-ccw':
      return { x: crop.y, y: 1 - crop.x - crop.w, w: crop.h, h: crop.w };
    case 'flip-h':
      return { ...crop, x: 1 - crop.x - crop.w };
    case 'flip-v':
      return { ...crop, y: 1 - crop.y - crop.h };
  }
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  rect: CropRect;
}

/**
 * Corner resize: each mode has a FIXED corner (the one opposite the dragged
 * handle) and available growth space; a locked ratio picks the primary axis
 * by the larger pointer delta, then re-derives the other axis.
 */
function resizeRect(
  mode: DragMode,
  start: CropRect,
  px: number,
  py: number,
  dx: number,
  dy: number,
  ratio: Ratio,
  width: number,
  height: number,
): CropRect {
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  let w: number;
  let h: number;
  let originX: number;
  let originY: number;
  let maxW: number;
  let maxH: number;

  switch (mode) {
    case 'se':
      w = px - start.x;
      h = py - start.y;
      originX = start.x;
      originY = start.y;
      maxW = 1 - start.x;
      maxH = 1 - start.y;
      break;
    case 'nw':
      w = right - px;
      h = bottom - py;
      originX = right;
      originY = bottom;
      maxW = right;
      maxH = bottom;
      break;
    case 'ne':
      w = px - start.x;
      h = bottom - py;
      originX = start.x;
      originY = bottom;
      maxW = 1 - start.x;
      maxH = bottom;
      break;
    default: // 'sw'
      w = right - px;
      h = py - start.y;
      originX = right;
      originY = start.y;
      maxW = right;
      maxH = 1 - start.y;
      break;
  }

  w = clamp(w, MIN_SIZE, maxW);
  h = clamp(h, MIN_SIZE, maxH);

  const target = ratioNumber(ratio);
  if (target && width > 0 && height > 0) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      h = (w * width) / (target * height);
      if (h > maxH) {
        h = maxH;
        w = (h * target * height) / width;
      }
    } else {
      w = (h * target * height) / width;
      if (w > maxW) {
        w = maxW;
        h = (w * width) / (target * height);
      }
    }
    w = clamp(w, MIN_SIZE, maxW);
    h = clamp(h, MIN_SIZE, maxH);
  }

  const growsLeft = mode === 'nw' || mode === 'sw';
  const growsUp = mode === 'nw' || mode === 'ne';
  return {
    x: growsLeft ? originX - w : originX,
    y: growsUp ? originY - h : originY,
    w,
    h,
  };
}

/**
 * Client-side image editor: rotate / flip / crop (free or locked ratio) /
 * resize, exported as a data URL under the 3 MB reference cap. Works for ANY
 * model — the result lands in the reference tray; whether it is SENT to the
 * provider is decided by the model's capabilities (the server strips
 * references from text-to-image models), so editing is never gated on
 * edit-capable models.
 */
export function ImageEditorModal({
  open,
  src,
  onClose,
  onApply,
}: {
  open: boolean;
  src: string;
  onClose: () => void;
  onApply: (dataUrl: string) => void;
}) {
  const showNotice = useStore((state) => state.showNotice);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [rot, setRot] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [ratio, setRatio] = useState<Ratio>('free');
  const [crop, setCrop] = useState<CropRect>({ ...FULL });
  const [longEdge, setLongEdge] = useState('');
  const previewRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // Reset everything whenever a different image opens.
  useEffect(() => {
    if (!open) return;
    setImg(null);
    setRot(0);
    setFlipH(false);
    setFlipV(false);
    setRatio('free');
    setCrop({ ...FULL });
    setLongEdge('');
    const image = new Image();
    image.onload = () => {
      setImg(image);
      setLongEdge(String(Math.max(image.naturalWidth, image.naturalHeight)));
    };
    image.onerror = () => showNotice('image.refFetchFailed');
    image.src = src;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [open, src, showNotice]);

  // Oriented working copy: flips act in DISPLAY space (translate → scale →
  // rotate → draw), so mirroring always mirrors what the user currently sees.
  const oriented = useMemo(() => {
    if (!img) return null;
    const swapped = ((rot % 360) + 360) % 180 !== 0;
    const width = swapped ? img.naturalHeight : img.naturalWidth;
    const height = swapped ? img.naturalWidth : img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.translate(width / 2, height / 2);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return canvas;
  }, [img, rot, flipH, flipV]);

  // Copy the oriented canvas into the visible preview.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !oriented) return;
    canvas.width = oriented.width;
    canvas.height = oriented.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(oriented, 0, 0);
    }
  }, [oriented]);

  const reorient = (op: 'rot-cw' | 'rot-ccw' | 'flip-h' | 'flip-v') => {
    if (op === 'rot-cw') setRot((value) => value + 90);
    else if (op === 'rot-ccw') setRot((value) => value - 90);
    else if (op === 'flip-h') setFlipH((value) => !value);
    else setFlipV((value) => !value);
    setCrop((current) => {
      // Flips keep both axes — even a locked rect stays at its ratio.
      if (op === 'flip-h' || op === 'flip-v') return transformCrop(current, op);
      // A 90° turn inverts the locked pixel ratio — refit; free crops move.
      if (ratio !== 'free' && oriented) {
        return fitCrop(ratio, oriented.height, oriented.width);
      }
      return transformCrop(current, op);
    });
  };

  const pickRatio = (next: Ratio) => {
    setRatio(next);
    if (oriented) setCrop(fitCrop(next, oriented.width, oriented.height));
  };

  const startDrag = (event: React.PointerEvent, mode: DragMode) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, rect: { ...crop } };
  };

  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const box = wrapRef.current?.getBoundingClientRect();
    if (!drag || !box || box.width === 0 || box.height === 0) return;
    const dx = (event.clientX - drag.startX) / box.width;
    const dy = (event.clientY - drag.startY) / box.height;
    const px = (event.clientX - box.left) / box.width;
    const py = (event.clientY - box.top) / box.height;
    const start = drag.rect;

    if (drag.mode === 'move') {
      setCrop({
        ...start,
        x: clamp(start.x + dx, 0, 1 - start.w),
        y: clamp(start.y + dy, 0, 1 - start.h),
      });
      return;
    }
    if (!oriented) return;
    setCrop(resizeRect(drag.mode, start, px, py, dx, dy, ratio, oriented.width, oriented.height));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const apply = () => {
    if (!oriented) return;
    const W = oriented.width;
    const H = oriented.height;
    const sx = clamp(Math.round(crop.x * W), 0, W - 1);
    const sy = clamp(Math.round(crop.y * H), 0, H - 1);
    const sw = clamp(Math.round(crop.w * W), 1, W - sx);
    const sh = clamp(Math.round(crop.h * H), 1, H - sy);
    const parsed = Number(longEdge);
    const targetLong = Number.isFinite(parsed) ? clamp(Math.round(parsed), OUT_MIN, OUT_MAX) : Math.max(sw, sh);
    const scale = targetLong / Math.max(sw, sh);
    const out = document.createElement('canvas');
    out.width = clamp(Math.round(sw * scale), OUT_MIN, OUT_MAX);
    out.height = clamp(Math.round(sh * scale), OUT_MIN, OUT_MAX);
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(oriented, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const encoded = encodeWithinLimit(out, MAX_REFERENCE_BYTES, src.startsWith('data:image/png'));
    if (!encoded) {
      showNotice('image.editEncodeFailed');
      return;
    }
    onApply(encoded);
    onClose();
  };

  const cropStyle: React.CSSProperties = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`,
    height: `${crop.h * 100}%`,
  };

  const handleClass = 'absolute h-3.5 w-3.5 rounded-[3px] border border-white/80 bg-accent shadow-card';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit image"
      description="Crop, rotate or resize — the result joins your reference tray."
      size="max-w-3xl"
      footer={
        <>
          <button type="button" className="pill-button border border-hairline text-muted hover:text-ink" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pill-button bg-accent text-accent-ink hover:brightness-110"
            onClick={apply}
            disabled={!oriented}
          >
            Add to tray
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className="icon-button" aria-label="Rotate counter-clockwise" onClick={() => reorient('rot-ccw')}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label="Rotate clockwise" onClick={() => reorient('rot-cw')}>
            <RotateCw className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label="Flip horizontally" onClick={() => reorient('flip-h')}>
            <FlipHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label="Flip vertically" onClick={() => reorient('flip-v')}>
            <FlipVertical className="h-4 w-4" aria-hidden="true" />
          </button>

          <span className="mx-1 h-4 w-px bg-hairline" aria-hidden="true" />

          {RATIOS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => pickRatio(entry.id)}
              className={cx(
                'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                ratio === entry.id
                  ? 'border-accent/60 bg-accent-soft text-ink'
                  : 'border-hairline bg-surface text-muted hover:border-accent/50 hover:text-ink',
              )}
            >
              {entry.label}
            </button>
          ))}

          <span className="min-w-1 flex-1" />

          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            Long edge
            <input
              type="number"
              min={OUT_MIN}
              max={OUT_MAX}
              value={longEdge}
              onChange={(event) => setLongEdge(event.target.value)}
              className="field w-20 px-2 py-1 text-center text-[12px] tabular-nums"
              aria-label="Output long edge in pixels"
            />
            <span className="text-faint">px</span>
          </label>
        </div>

        <div className="flex min-h-[200px] justify-center overflow-hidden rounded-control border border-hairline bg-canvas p-3">
          <div
            ref={wrapRef}
            className="relative inline-block max-w-full touch-none"
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <canvas
              ref={previewRef}
              className="block max-h-[46vh] max-w-full rounded-control border border-hairline"
              style={{ height: 'auto', width: 'auto' }}
            />
            {oriented ? (
              <div className="absolute inset-0">
                <div
                  role="presentation"
                  className="absolute cursor-move"
                  style={cropStyle}
                  onPointerDown={(event) => startDrag(event, 'move')}
                >
                  <div className="absolute inset-0 border border-accent" style={{ boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)' }} />
                  <div className={cx(handleClass, '-left-1.5 -top-1.5 cursor-nwse-resize')} onPointerDown={(event) => startDrag(event, 'nw')} />
                  <div className={cx(handleClass, '-right-1.5 -top-1.5 cursor-nesw-resize')} onPointerDown={(event) => startDrag(event, 'ne')} />
                  <div className={cx(handleClass, '-left-1.5 -bottom-1.5 cursor-nesw-resize')} onPointerDown={(event) => startDrag(event, 'sw')} />
                  <div className={cx(handleClass, '-right-1.5 -bottom-1.5 cursor-nwse-resize')} onPointerDown={(event) => startDrag(event, 'se')} />
                </div>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-faint">Loading…</div>
            )}
          </div>
        </div>

        <p className="text-[11.5px] text-faint">
          {oriented ? `${oriented.width}×${oriented.height} px source` : 'Reading image…'} — output stays under the 3 MB reference cap automatically.
        </p>
      </div>
    </Modal>
  );
}
