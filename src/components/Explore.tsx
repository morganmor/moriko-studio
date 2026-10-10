import type { ReactNode } from 'react';

import { brandWordmarkSvgUrl } from '../lib/brandAssets';
import { MorikoCatMark } from './MorikoCatMark';
import { useStore } from '../store/useStore';
import { isMotionReduced } from '../lib/appearance';

/**
 * Landing view before a thread exists — ported from moriko-design-1.html.
 *
 * Layout: breathing-halo pixel cat, dithered wordmark, time-based greeting,
 * hint copy (kbd chips), then the composer (`children`) mid-screen. The
 * 2×2 suggestion grid was dropped — the canvas stays minimal.
 *
 * The mode status line stays Composer-owned (single source — no doubling).
 */
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function greeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Explore({
  children,
}: {
  children?: ReactNode;
}) {

  /** Canvas-chat design: pressing the pet cat gives only the squishy boop. */
  const petCat = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const cat = event.currentTarget;
    if (isMotionReduced(useStore.getState().reduceMotion)) return;
    cat.classList.remove('boop');
    void cat.offsetWidth;
    cat.classList.add('boop');
  };

  return (
    <div className="hero" style={{ textAlign: 'center' }}>
      {}
      <div className="relative isolate">
        <span className="d1-halo" aria-hidden="true" />
        <button
          type="button"
          className="hero-cat"
          aria-label="Pet Moriko"
          onPointerMove={(event) => {
            if (isMotionReduced(useStore.getState().reduceMotion)) return;
            const box = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - box.left) / box.width - 0.5;
            const y = (event.clientY - box.top) / box.height - 0.5;
            event.currentTarget.style.setProperty('--ry', `${clamp(x * 28, -14, 14)}deg`);
            event.currentTarget.style.setProperty('--rx', `${clamp(-y * 28, -14, 14)}deg`);
          }}
          onPointerLeave={(event) => {
            event.currentTarget.style.setProperty('--ry', '0deg');
            event.currentTarget.style.setProperty('--rx', '0deg');
          }}
          onClick={petCat}
        >
          <MorikoCatMark />
        </button>
      </div>
      <img
        src={brandWordmarkSvgUrl}
        alt="Moriko Studio"
        draggable={false}
        width={42}
        height={9}
        style={{ aspectRatio: '42 / 9', margin: '6px auto 2px', width: 150, height: 32, display: 'block' }}
      />
      <h1
        className="greet"
        style={{ margin: '8px 0 6px', fontSize: 26, fontWeight: 700, letterSpacing: '-0.025em', color: 'rgb(var(--c-ink))' }}
      >
        {greeting()} — what shall we build?
      </h1>
      <p className="greet-sub" style={{ margin: 0, maxWidth: 480, fontSize: 14, color: 'var(--muted)' }}>
        Ask, plan, or let Moriko act on your workspace. Type <kbd>/</kbd> for commands,{' '}
        <kbd>Ctrl K</kbd> for everything else.
      </p>

      {}
      {children ? (
        <div className="suggest composer-slot" style={{ marginTop: 8, width: '100%', maxWidth: 'none', display: 'block', textAlign: 'left' }}>{children}</div>
      ) : null}

    </div>
  );
}
