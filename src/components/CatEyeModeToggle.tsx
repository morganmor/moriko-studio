/**
 * CatEyeModeToggle — a “pixelated cat-eye” style Chat/Agent mode switcher from
 * agent_input_panel_cat_eye.html, adapted for the Moriko theme.
 *
 * Mechanism (exact replica of the example, implemented with React):
 *  - ONE small pixel-art SVG button. Eyes CLOSED (lines + whiskers) = CHAT only;
 *    Eyes OPEN (orange pupil + highlight) = AGENT active.
 *  - aria-pressed=true when agent is active (same as example); aria-label follows mode.
 *    No hover tooltip — the button label + status line already state the mode
 *    (tooltip cleanup 2026-10: a Tip here only restated the aria-label).
 *  - Blinks on click (scaleY .08 for ~230ms) before the mode changes — the eyelid
 *    closes first, then the mode changes (setMode is called after 110ms in the example).
 *  - Idle blink every 10s ONLY in agent mode (setInterval in the example).
 *  - Status bar above the panel: text is typed ONCE (45 ms/character), remains for 10s,
 *    then disappears with backspace (16 ms/character) and the line is removed from
 *    the layout — a token guard to prevent fast mode switching from causing conflicts.
 *    ‘AGENT MODE ACTIVE’ (accented) / ‘CHAT MODE ONLY’ (dimmed) + flashing block cursor.
 *
 * Theme: glow/cursor uses rgb(var(--c-accent)) to match dark/light/mocha;
 * pixel-art eye colors use the example palette (not theme variables) so that their shape
 * remains consistent with the example across all themes.
 */
import { useEffect, useRef, useState } from 'react';
import { cx } from './ui';

/** Palet pixel-art contoh (tetap, bukan dari tema) — kucing clay + mata oranye. */
const EYE_CLAY = '#cfc8c2';
const EYE_ORANGE = '#ff7a1a';
const EYE_AMBER = '#ffb347';
const EYE_PUPIL = '#1a0f08';
const EYE_HIGHLIGHT = '#ffffff';

/** Satu rect pixel-art: [x, y, width, height]. */

/** Mata TERBUKA (Agent) — rect list VERBATIM dari SVG operator (#ff7a1a outline). */
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
/** Iris amber (#ffb347) — verbatim operator. */
const OPEN_AMBER: Array<[number, number, number, number]> = [
  [9, 2, 1, 1],
  [5, 3, 2, 2],
  [9, 3, 2, 2],
  [6, 5, 1, 1],
  [9, 5, 1, 1],
];
/** Pupil gelap + highlight putih — verbatim operator. */
const OPEN_PUPIL: Array<[number, number, number, number]> = [[7, 2, 2, 4]];
const OPEN_HIGHLIGHT: Array<[number, number, number, number]> = [[6, 2, 1, 1]];

/** Mata TERPEJAM (Chat) — rect list VERBATIM dari SVG operator (#cfc8c2). */
const CLOSED_CLAY: Array<[number, number, number, number]> = [
  [0, 2, 1, 1],
  [15, 2, 1, 1],
  [1, 3, 2, 1],
  [13, 3, 2, 1],
  [3, 4, 10, 1],
];

/** Render satu grup rect list. */
function PixelRects({ rects, fill }: { rects: Array<[number, number, number, number]>; fill: string }) {
  return (
    <>
      {rects.map(([x, y, width, height], index) => (
        <rect key={`${x}-${y}-${index}`} x={x} y={y} width={width} height={height} fill={fill} />
      ))}
    </>
  );
}

/** SVG mata kucing 16x8 — bentuk persis SVG operator; `agent` memilih bitmap. */
function CatEyeSvg({ agent, blinking }: { agent: boolean; blinking: boolean }) {
  return (
    <svg
      viewBox="0 0 16 8"
      aria-label={agent ? 'Eyes Open, Agent Mode' : 'Eyes Closed, Chat Mode'}
      role="img"
      className="h-[16px] w-[32px]"
      style={{ shapeRendering: 'crispEdges', overflow: 'visible' }}
    >
      <g
        className={cx('origin-center transition-transform duration-[110ms]', blinking && 'scale-y-[0.08]')}
      >
        {agent ? (
          <>
            <PixelRects rects={OPEN_ORANGE} fill={EYE_ORANGE} />
            <PixelRects rects={OPEN_AMBER} fill={EYE_AMBER} />
            <PixelRects rects={OPEN_PUPIL} fill={EYE_PUPIL} />
            <PixelRects rects={OPEN_HIGHLIGHT} fill={EYE_HIGHLIGHT} />
          </>
        ) : (
          <PixelRects rects={CLOSED_CLAY} fill={EYE_CLAY} />
        )}
      </g>
    </svg>
  );
}

/**
 * Flash status: ketik maju 45ms/char, tahan `holdMs`, lalu backspace 16ms/char
 * sampai kosong dan menyalakan `done` — caller melepas barisnya dari layout.
 * Teks lama ikut di-backspace dulu saat `text` berpindah (token guard).
 */
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
    if (currentRef.current === text) {
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

/** Tombol mata + status ketik. `agent` = mode agent aktif (mata terbuka). */
export function CatEyeModeToggle({
  agent,
  onToggle,
}: {
  agent: boolean;
  /** Dipanggil setelah animasi blink selesai (110ms, seperti contoh). */
  onToggle: () => void;
}) {
  const [blinking, setBlinking] = useState(false);

  // Idle blink tiap 10s hanya di mode agent (setInterval contoh).
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
      aria-pressed={agent}
      aria-label={agent ? 'Agent Mode Active' : 'Chat Mode Only'}
      onClick={handleClick}
      className={cx(
        'inline-flex h-8 w-[46px] shrink-0 items-center justify-center rounded-control border transition-all duration-200',
        agent
          ? 'border-accent/60 bg-accent/10 shadow-[0_0_10px_rgb(var(--c-accent)/0.4)] hover:border-accent/85'
          : 'border-hairline bg-transparent hover:border-muted/60',
      )}
    >
      <CatEyeSvg agent={agent} blinking={blinking} />
    </button>
  );
  return eye;
}
