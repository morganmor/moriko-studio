import type { Accent, Density, FontFamily, ThemeMode } from '../types';

/**
 * Theme mechanism ported from design/moriko-design-1-theme-mechanism.html:
 * one idempotent applyAppearance() for every appearance knob, plus the View
 * Transition circular reveal used when the theme flips.
 *
 * State is PASSED IN (never imported from the store) so this module stays
 * dependency-free and cycle-free.
 */
export interface AppearanceState {
  theme: ThemeMode;
  accent: Accent;
  density: Density;
  ambient: boolean;
  fontFamily: FontFamily;
  /** Tri-state like the design: null = follow the OS, true/false = forced. */
  reduceMotion: boolean | null;
}

const darkMq = () => window.matchMedia('(prefers-color-scheme: dark)');
const motionMq = () => window.matchMedia('(prefers-reduced-motion: reduce)');

/** Design's themeOf(): 'system' resolves through the OS preference. */
export function resolveTheme(theme: ThemeMode): 'dark' | 'light' | 'mocha' {
  if (theme !== 'system') return theme;
  return darkMq().matches ? 'dark' : 'light';
}

/** Design's reduced(): an explicit choice wins, null follows prefers-reduced-motion. */
export function isMotionReduced(reduceMotion: boolean | null): boolean {
  return reduceMotion === null ? motionMq().matches : reduceMotion;
}

/** Design's applyAppearance(): writes every appearance attribute onto <html>. */
export function applyAppearance(state: AppearanceState): void {
  const root = document.documentElement;
  const resolved = resolveTheme(state.theme);
  root.classList.toggle('dark', resolved !== 'light');
  root.classList.toggle('mocha', resolved === 'mocha');
  root.style.colorScheme = resolved === 'light' ? 'light' : 'dark';
  root.dataset.accent = state.accent;
  root.dataset.density = state.density;
  root.dataset.font = state.fontFamily;
  root.classList.toggle('no-amb', !state.ambient);
  root.classList.toggle('reduce', isMotionReduced(state.reduceMotion));
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
}

type ViewTransitionLike = { ready: Promise<void> };
type DocWithTransition = Document & {
  startViewTransition?: (updateCallback: () => void) => ViewTransitionLike;
};

/**
 * Design's setTheme(): runs `update` + applyAppearance inside a View
 * Transition, then reveals the new theme as a circle expanding from the
 * pointer (520ms, cubic-bezier(.2,.8,.2,1)). Without View Transition support
 * — or when motion is reduced — falls back to an instant apply.
 */
export function transitionAppearance(
  next: AppearanceState,
  update: () => void,
  ev?: { clientX: number; clientY: number },
): void {
  const doc = document as DocWithTransition;
  if (!doc.startViewTransition || isMotionReduced(next.reduceMotion)) {
    update();
    applyAppearance(next);
    return;
  }
  const x = ev && ev.clientX ? ev.clientX : window.innerWidth / 2;
  const y = ev && ev.clientY ? ev.clientY : window.innerHeight / 2;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = doc.startViewTransition(() => {
    update();
    applyAppearance(next);
  });
  transition.ready
    .then(() => {
      const options: KeyframeAnimationOptions & { pseudoElement?: string } = {
        duration: 520,
        easing: 'cubic-bezier(.2,.8,.2,1)',
        pseudoElement: '::view-transition-new(root)',
      };
      document.documentElement.animate(
        { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        options,
      );
    })
    .catch(() => {});
}
