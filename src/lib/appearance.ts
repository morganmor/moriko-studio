import type { Accent, Density, FontFamily, ThemeMode } from '../types';


export interface AppearanceState {
  theme: ThemeMode;
  accent: Accent;
  density: Density;
  ambient: boolean;
  fontFamily: FontFamily;
  
  reduceMotion: boolean | null;
}

const darkMq = () => window.matchMedia('(prefers-color-scheme: dark)');
const motionMq = () => window.matchMedia('(prefers-reduced-motion: reduce)');


export function resolveTheme(theme: ThemeMode): 'dark' | 'light' | 'mocha' {
  if (theme !== 'system') return theme;
  return darkMq().matches ? 'dark' : 'light';
}


export function isMotionReduced(reduceMotion: boolean | null): boolean {
  return reduceMotion === null ? motionMq().matches : reduceMotion;
}


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
