import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from './ui';

/**
 * FISH-EYE CHECKPOINT RAIL — scale-invariant by construction.
 *
 * The thread container sits under CSS `zoom` (.ctx-zoom = ctx-scale/app-zoom)
 * plus #root's `transform: scale(app-zoom)`. getBoundingClientRect() and
 * clientY return SCREEN px, while CSS `top: Npx` is LOCAL px multiplied by
 * the net zoom (ctx-scale) at render. Mixing the two produced a linear,
 * accumulating error: dot 1 accurate, dot 40 far off, dots ending short of
 * the scrollbar.
 *
 * Fix: no pixels anywhere in the math.
 *  - hoverNorm = (clientY - rect.top) / rect.height  → ratio, zoom cancels.
 *  - dot position = cumulative weight fraction        → dimensionless.
 *  - rendered via `top: frac%`                        → resolves in local px,
 *    then zooms with the container exactly like the cursor does.
 * Alignment holds for ANY zoom factor / transform / DPR.
 *
 * Weight: 1 + (M-1) * exp(-((i+0.5 - focus) / sigma)²); focus in index space
 * = hoverNorm * N. Dot size: clamp(MIN, gap_px * 0.55, MAX) — no solid bar.
 */

interface CheckpointRailProps {
  turnNumbers: number[];
  activeTurn: number;
  onJumpToTurn: (turn: number) => void;
  rightOffset: number;
}

const MIN_DOT = 2;
const MAX_DOT = 7;
const MAGNIFY = 22;
const SIGMA = 3;
const ACTIVE_W = 3;
const ACTIVE_H = 14;
const HOVER_W = 10;
const HOVER_H = 10;

interface DotLayout {
  turn: number;
  /** Position as a fraction [0,1] of the rail height — zoom-invariant. */
  frac: number;
  /** Dot size in px (visual only; ~10% off under zoom is invisible at 2–7px). */
  sz: number;
  isActive: boolean;
}

export function CheckpointRail({
  turnNumbers,
  activeTurn,
  onJumpToTurn,
  rightOffset,
}: CheckpointRailProps) {
  const railRef = useRef<HTMLElement>(null);
  /** Cursor position as a RATIO [0,1] of rail height (null = not hovering). */
  const [hoverNorm, setHoverNorm] = useState<number | null>(null);
  /** Screen px — only used for dot SIZES and magnification strength. */
  const [railH, setRailH] = useState(0);

  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const sync = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setRailH(h);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layouts = useMemo<DotLayout[]>(() => {
    const N = turnNumbers.length;
    if (N === 0) return [];
    const b = railH > 0 ? railH / N : 0;
    const M = b > 0 ? Math.max(1, MAGNIFY / b) : 1;
    const activeIdx = Math.max(0, Math.min(N - 1, turnNumbers.indexOf(activeTurn)));
    // Focus in index space: dot i sits at fraction (i+0.5)/N when uniform.
    const focus = hoverNorm != null ? hoverNorm * N : activeIdx + 0.5;

    const weights = new Array<number>(N);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const v = hoverNorm != null
        ? 1 + (M - 1) * Math.exp(-Math.pow((i + 0.5 - focus) / SIGMA, 2))
        : 1;
      weights[i] = v;
      sum += v;
    }

    const result: DotLayout[] = [];
    let c = 0;
    for (let i = 0; i < N; i++) {
      const frac = (c + weights[i] / 2) / sum;
      const nextC = c + weights[i];
      const nextFrac = i < N - 1
        ? (nextC + weights[i + 1] / 2) / sum
        : frac + (frac - (i > 0 ? result[i - 1].frac : 0));
      const gapPx = Math.abs(nextFrac - frac) * railH;
      const sz = Math.max(MIN_DOT, Math.min(MAX_DOT, gapPx * 0.55));
      result.push({ turn: turnNumbers[i], frac, sz, isActive: turnNumbers[i] === activeTurn });
      c = nextC;
    }
    return result;
  }, [turnNumbers, activeTurn, hoverNorm, railH]);

  // Nearest dot to the cursor — both sides are fractions, zoom-invariant.
  const hoverIdx = useMemo(() => {
    if (hoverNorm == null || layouts.length === 0) return -1;
    let best = Infinity;
    let idx = -1;
    for (let i = 0; i < layouts.length; i++) {
      const d = Math.abs(layouts[i].frac - hoverNorm);
      if (d < best) { best = d; idx = i; }
    }
    return idx;
  }, [hoverNorm, layouts]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const el = railRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const n = (e.clientY - rect.top) / rect.height;
    setHoverNorm(Math.max(0, Math.min(1, n)));
  }, []);

  const handleClick = useCallback(() => {
    if (hoverIdx >= 0) onJumpToTurn(layouts[hoverIdx].turn);
  }, [hoverIdx, layouts, onJumpToTurn]);

  if (turnNumbers.length === 0) return null;

  const hovered = hoverIdx >= 0 ? layouts[hoverIdx] : null;

  return (
    <nav
      ref={railRef}
      aria-label="Turn checkpoints"
      style={{ right: rightOffset }}
      className="absolute inset-y-0 hidden w-6 flex-col items-center lg:flex"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverNorm(null)}
      onClick={handleClick}
    >
      {layouts.map((l, i) => {
        const isHover = i === hoverIdx;
        return (
          <button
            key={l.turn}
            type="button"
            onClick={(e) => { e.stopPropagation(); onJumpToTurn(l.turn); }}
            aria-label={`Turn ${l.turn}`}
            aria-current={l.isActive ? 'true' : undefined}
            className={cx(
              'rail-dot absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-150',
              // Colors + default opacity live in index.css (.rail-dot): every
              // theme carries its own --c-rail-dot — a bg-hairline dot was
              // invisible on the light theme (border token, 226 on 246).
              l.isActive && 'rail-dot--active',
              !l.isActive && isHover && 'rail-dot--hover',
            )}
            style={{
              // Percentage → resolves in the container's LOCAL px, then zooms
              // with .ctx-zoom exactly like clientY does. Scale-safe.
              top: `${l.frac * 100}%`,
              width: `${isHover && !l.isActive ? HOVER_W : l.isActive ? ACTIVE_W : l.sz}px`,
              height: `${isHover && !l.isActive ? HOVER_H : l.isActive ? ACTIVE_H : l.sz}px`,
              zIndex: l.isActive ? 3 : isHover ? 2 : 1,
            }}
          />
        );
      })}
      {hovered && (
        <div
          className="pointer-events-none absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded border border-hairline bg-surface px-2 py-0.5 text-xs text-muted z-10"
          style={{ top: `${hovered.frac * 100}%` }}
        >
          Turn {hovered.turn}
        </div>
      )}
    </nav>
  );
}
