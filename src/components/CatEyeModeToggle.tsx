
import { useEffect, useRef, useState } from 'react';
import { cx } from './ui';
import { useStore } from '../store/useStore';
import { isMotionReduced } from '../lib/appearance';




const OPEN_ORANGE: Array<[number, number, number, number]> = [
  [4, 0, 8, 1],
  [2, 1, 2, 1],
  [12, 1, 2, 1],
  [1, 2, 1, 1],
  [14, 2, 1, 1],
  [0, 3, 1, 2],
  [15, 3, 1, 2],
  [1, 5, 1, 1],
  [14, 5, 1, 1],
  [2, 6, 2, 1],
  [12, 6, 2, 1],
  [4, 7, 8, 1],
];

const OPEN_AMBER: Array<[number, number, number, number]> = [
  [9, 2, 1, 1],
  [5, 3, 2, 2],
  [9, 3, 2, 2],
  [6, 5, 1, 1],
  [9, 5, 1, 1],
];

const OPEN_PUPIL: Array<[number, number, number, number]> = [[7, 2, 2, 4]];
const OPEN_HIGHLIGHT: Array<[number, number, number, number]> = [[6, 2, 1, 1]];


const CLOSED_CLAY: Array<[number, number, number, number]> = [
  [0, 2, 1, 1],
  [15, 2, 1, 1],
  [1, 3, 2, 1],
  [13, 3, 2, 1],
  [3, 4, 10, 1],
];


function PixelRects({ rects, className }: { rects: Array<[number, number, number, number]>; className: string }) {
  return (
    <>
      {rects.map(([x, y, width, height], index) => (
        <rect key={`${x}-${y}-${index}`} x={x} y={y} width={width} height={height} className={className} />
      ))}
    </>
  );
}


function CatEyeSvg({ agent, blinking }: { agent: boolean; blinking: boolean }) {
  return (
    <svg
      viewBox="0 0 16 8"
      aria-label={agent ? 'Eyes Open, Agent Mode' : 'Eyes Closed, Chat Mode'}
      role="img"
      style={{ shapeRendering: 'crispEdges', overflow: 'visible' }}
    >
      <g
        className={cx('eye-g', blinking && 'blink')}
      >
        {agent ? (
          <>
            <PixelRects rects={OPEN_ORANGE} className="eo" />
            <PixelRects rects={OPEN_AMBER} className="ei" />
            <g className="pupil">
              <PixelRects rects={OPEN_PUPIL} className="ep" />
            </g>
            <PixelRects rects={OPEN_HIGHLIGHT} className="eh" />
          </>
        ) : (
          <PixelRects rects={CLOSED_CLAY} className="ec" />
        )}
      </g>
    </svg>
  );
}


export function useTypewriterStatus(text: string, holdMs = 0): { text: string; done: boolean } {
  const [display, setDisplay] = useState('');
  const [done, setDone] = useState(false);
  const tokenRef = useRef(0);
  const currentRef = useRef('');

  useEffect(() => {
    const token = ++tokenRef.current;
    let cancelled = false;
    let timer = 0;
    const tick = (fn: () => void, ms: number): void => {
      timer = window.setTimeout(fn, ms);
    };

    const eraseTo = (then: () => void): void => {
      if (cancelled || tokenRef.current !== token) return;
      const value = currentRef.current;
      if (!value) {
        then();
        return;
      }
      currentRef.current = value.slice(0, -1);
      setDisplay(currentRef.current);
      tick(() => eraseTo(then), 16);
    };

    const write = (i: number): void => {
      if (cancelled || tokenRef.current !== token) return;
      currentRef.current = text.slice(0, i);
      setDisplay(currentRef.current);
      if (i < text.length) tick(() => write(i + 1), 45);
      else if (holdMs > 0) tick(() => eraseTo(() => setDone(true)), holdMs);
    };

    setDone(false);
    if (isMotionReduced(useStore.getState().reduceMotion)) {
      currentRef.current = text;
      setDisplay(text);
      if (holdMs > 0) {
        tick(() => {
          if (cancelled || tokenRef.current !== token) return;
          currentRef.current = '';
          setDisplay('');
          setDone(true);
        }, holdMs);
      }
    } else if (currentRef.current === text) {
      if (holdMs > 0) tick(() => eraseTo(() => setDone(true)), holdMs);
    } else {
      eraseTo(() => write(1));
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, holdMs]);

  return { text: display, done };
}


export function CatEyeModeToggle({
  agent,
  onToggle,
}: {
  agent: boolean;
  
  onToggle: () => void;
}) {
  const [blinking, setBlinking] = useState(false);
  const rootRef = useRef<HTMLButtonElement>(null);

  
  useEffect(() => {
    if (!agent || isMotionReduced(useStore.getState().reduceMotion)) return;
    
    const UNITS_PER_PX = 16 / 32;
    let frame = 0;
    let last: PointerEvent | null = null;
    const onMove = (event: PointerEvent) => {
      last = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const button = rootRef.current;
        const pointer = last;
        if (!button || !pointer || !button.offsetParent) return;
        const rect = button.getBoundingClientRect();
        const dx = pointer.clientX - (rect.left + rect.width / 2);
        const dy = pointer.clientY - (rect.top + rect.height / 2);
        const dist = Math.hypot(dx, dy) || 1;
        const strength = Math.min(1, dist / 200);
        button.style.setProperty('--px', `${(dx / dist) * 2.6 * strength * UNITS_PER_PX}px`);
        button.style.setProperty('--py', `${(dy / dist) * 1.4 * strength * UNITS_PER_PX}px`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [agent]);

  useEffect(() => {
    if (!agent) return;
    const timer = window.setInterval(() => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 230);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [agent]);

  const handleClick = (): void => {
    setBlinking(true);
    setTimeout(() => onToggle(), 110);
    setTimeout(() => setBlinking(false), 230);
  };

  const eye = (
    <button
      type="button"
      ref={rootRef}
      aria-pressed={agent}
      aria-label={agent ? 'Agent Mode Active' : 'Chat Mode Only'}
      onClick={handleClick}
      className="cat-eye"
    >
      <CatEyeSvg agent={agent} blinking={blinking} />
    </button>
  );
  return eye;
}
