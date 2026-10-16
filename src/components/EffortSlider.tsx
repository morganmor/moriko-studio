/**
 * EffortSlider — "thought field" reasoning slider ported 1:1 from the mimo
 * reference (attachment-016.html): dot-matrix canvas + fisheye lens thumb,
 * spring physics, phosphor trail, packet streams, sparks, ripples, boot scan
 * and the 5×7 dot-matrix effort-name morph. Controlled by `value` (index into
 * `labels`); commits go through `onChange`. `active` gates the rAF loop.
 */
import { useEffect, useRef } from 'react';

type RGB = [number, number, number, number];

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
  1,
];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

let colorProbe: CanvasRenderingContext2D | null | undefined;
function parseColor(str: string): RGB {
  const s = str.trim();
  if (/^[\d.]+[\s,/]+[\d.]+/.test(s)) {
    const n = s.split(/[\s,/]+/).map(Number);
    if (n.length >= 3 && n.every((v) => Number.isFinite(v))) return [n[0], n[1], n[2], n[3] ?? 1];
  }
  if (colorProbe === undefined) colorProbe = document.createElement('canvas').getContext('2d');
  if (colorProbe) {
    colorProbe.fillStyle = '#000';
    colorProbe.fillStyle = s || '#000';
    const v = String(colorProbe.fillStyle);
    if (v[0] === '#') {
      const hex = v.slice(1);
      const to = (h: string) => parseInt(h.length === 1 ? h + h : h, 16);
      return [
        to(hex.slice(0, 2)),
        to(hex.slice(2, 4)),
        to(hex.slice(4, 6)),
        hex.length >= 8 ? to(hex.slice(6, 8)) / 255 : 1,
      ];
    }
    const m = v.match(/[\d.]+/g);
    if (m && m.length >= 3) return [+m[0], +m[1], +m[2], m[3] !== undefined ? +m[3] : 1];
  }
  return [0, 0, 0, 1];
}

/** 5×7 dot-matrix glyphs (from the reference; unknown letters advance as blanks). */
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['####', '#...', '#...', '###.', '#...', '#...', '####'],
  F: ['####', '#...', '#...', '###.', '#...', '#...', '#...'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  L: ['#...', '#...', '#...', '#...', '#...', '#...', '####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
};
const NP = 4;
const NR = 7;
const NPAD = 12;

interface Word {
  pts: [number, number][];
  cols: number;
}

function buildWords(labels: string[]): Word[] {
  return labels.map((word) => {
    const pts: [number, number][] = [];
    let x = 0;
    for (const ch of word.toUpperCase()) {
      const gl = GLYPHS[ch];
      if (!gl) {
        x += 4;
        continue;
      }
      gl.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) if (row[c] === '#') pts.push([x + c, r]);
      });
      x += gl[0].length + 1;
    }
    return { pts, cols: Math.max(0, x - 1) };
  });
}

interface Strand {
  lam: number;
  a: number;
  w: number;
  f: number;
  b: number;
}
interface Packet {
  x: number;
  s: number;
  v: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fr: number;
  life: number;
  ttl: number;
  s: number;
}
interface Ripple {
  t0: number;
  x: number;
  dir: number;
  amp: number;
}
interface Particle {
  x: number;
  y: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  a: number;
  a0: number;
  ghost: boolean;
  t0: number;
  dur: number;
  arc: number;
  life: number;
}

const STR: Strand[] = [
  { lam: 66, a: 1.0, w: 1.0, f: 0.0, b: 1.0 },
  { lam: 47, a: 0.8, w: 1.3, f: 2.1, b: 0.92 },
  { lam: 86, a: 0.62, w: 0.8, f: 4.2, b: 0.86 },
  { lam: 39, a: 0.9, w: 1.55, f: 1.3, b: 0.8 },
  { lam: 57, a: 0.52, w: 1.15, f: 5.0, b: 0.74 },
  { lam: 33, a: 0.72, w: 1.85, f: 3.4, b: 0.68 },
];
const NS = STR.length;
const ROWS = 9;
const MID = (ROWS - 1) / 2;
const NB = 16;
const IGN = 0.45;
const GA = [0.2, 0.38, 0.6, 0.88];

export interface EffortSliderProps {
  labels: string[];
  hints: string[];
  value: number;
  onChange: (index: number) => void;
  /** Gate the rAF loop; a static frame is drawn while false. */
  active?: boolean;
  label?: string;
  className?: string;
}

export function EffortSlider({
  labels,
  hints,
  value,
  onChange,
  active = true,
  label = 'Reasoning effort',
  className,
}: EffortSliderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const nameRef = useRef<HTMLCanvasElement>(null);
  const nameBgRef = useRef<HTMLCanvasElement>(null);
  const descRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<ReturnType<typeof createEngine> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const hintsRef = useRef(hints);
  hintsRef.current = hints;

  const labelsKey = labels.join('\u0000');

  useEffect(() => {
    const root = rootRef.current;
    const slider = sliderRef.current;
    const main = mainRef.current;
    const glow = glowRef.current;
    const name = nameRef.current;
    const nameBg = nameBgRef.current;
    if (!root || !slider || !main || !glow || !name || !nameBg) return;
    const engine = createEngine({
      root,
      slider,
      main,
      glow,
      name,
      nameBg,
      desc: descRef.current,
      idx: null,
      ends: null,
      labels: labelsRef.current,
      hints: hintsRef.current,
      value,
      reduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      onCommit: (index) => onChangeRef.current(index),
    });
    engineRef.current = engine;
    if (active && !engine.reduce) engine.start();
    else engine.staticRender();

    const observer = new ResizeObserver(() => {
      engine.layout();
      if (!engine.isRunning()) engine.staticRender();
    });
    observer.observe(slider);

    const onTheme = () => {
      engine.readTheme();
      engine.paintNameBg();
      if (!engine.isRunning()) engine.staticRender();
    };
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    let dprCancelled = false;
    const watchDpr = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const handler = () => {
        if (dprCancelled) return;
        engine.layout();
        engine.layoutName();
        if (!engine.isRunning()) engine.staticRender();
        watchDpr();
      };
      mq.addEventListener('change', handler, { once: true });
    };
    watchDpr();

    return () => {
      dprCancelled = true;
      observer.disconnect();
      themeObserver.disconnect();
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.labelsKey === labelsKey) return;
    engine.setLabels(labelsRef.current, labelsKey);
    if (active && !engine.reduce) engine.start();
    else engine.staticRender();
  }, [labelsKey]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.apply(value, true);
  }, [value]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (active && !engine.reduce) engine.start();
    else {
      engine.stop();
      engine.staticRender();
    }
    if (!active) return;
    const timer = window.setTimeout(() => {
      engine.layout();
      if (!engine.isRunning()) engine.staticRender();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [active]);

  const engine = () => engineRef.current;

  return (
    <div
      ref={rootRef}
      className={`effort-block${className ? ` ${className}` : ''}`}
      aria-label={label}
    >
      <div
        ref={sliderRef}
        className="effort-slider"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, labels.length - 1)}
        aria-valuenow={value}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const target = event.currentTarget;
          engine()?.pointerDown(event.clientX, event.pointerId, event.pointerType, target);
        }}
        onPointerMove={(event) => engine()?.pointerMove(event.clientX, event.pointerId, event.pointerType)}
        onPointerUp={(event) => engine()?.pointerEnd(event.pointerId, 'up', event.clientX)}
        onPointerCancel={(event) => engine()?.pointerEnd(event.pointerId, 'cancel', event.clientX)}
        onPointerLeave={() => engine()?.pointerLeave()}
        onFocus={() => {
          const target = engine()?.slider;
          let focusVisible = true;
          try {
            focusVisible = target ? target.matches(':focus-visible') : true;
          } catch {
            focusVisible = true;
          }
          engine()?.setFocus(focusVisible);
        }}
        onBlur={() => engine()?.setFocus(false)}
        onKeyDown={(event) => engine()?.keyDown(event)}
      >
        <canvas ref={glowRef} className="effort-glow" aria-hidden="true" />
        <canvas ref={mainRef} aria-hidden="true" />
      </div>
      <div className="effort-name" aria-hidden="true">
        <canvas ref={nameBgRef} />
        <canvas ref={nameRef} className="effort-name-cv" />
      </div>
      <span ref={descRef} className="effort-desc" />
    </div>
  );
}


function createEngine(host: {
  root: HTMLDivElement;
  slider: HTMLDivElement;
  main: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  name: HTMLCanvasElement | null;
  nameBg: HTMLCanvasElement | null;
  desc: HTMLSpanElement | null;
  idx: HTMLSpanElement | null;
  ends: HTMLDivElement | null;
  labels: string[];
  hints: string[];
  value: number;
  reduce: boolean;
  onCommit: (index: number) => void;
}) {
  const { root, slider, main, glow, name, nameBg, desc, idx, ends, reduce } = host;
  const mctx = main.getContext('2d');
  const gctx = glow.getContext('2d');
  const nctx = name?.getContext('2d') ?? null;
  const nbg = nameBg?.getContext('2d') ?? null;

  let labels = host.labels;
  let hints = host.hints;
  let labelsKey = labels.join('\u0000');
  let MAX = Math.max(1, labels.length - 1);
  let words = buildWords(labels);
  let level = clamp(Math.round(host.value), 0, MAX);
  let applied = -1;

  let T: {
    dot: RGB;
    tick: RGB;
    hot: RGB;
    glass: RGB;
    text: RGB;
    H: RGB[];
  } = { dot: [0, 0, 0, 1], tick: [0, 0, 0, 1], hot: [0, 0, 0, 1], glass: [0, 0, 0, 0.2], text: [255, 255, 255, 1], H: [] };

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n: string) => parseColor(cs.getPropertyValue(n));
    const accent = g('--c-accent');
    const ramp = (k: number): RGB => [
      Math.min(255, accent[0] * k),
      Math.min(255, accent[1] * k),
      Math.min(255, accent[2] * k),
      1,
    ];
    T = {
      dot: g('--dot'),
      tick: mix(accent, g('--dot-tick'), 0.4),
      hot: g('--hot'),
      glass: g('--glass'),
      text: g('--eff-text'),
      H: [0.5, 0.66, 0.8, 0.92, 1, 1.12, 1.28].map(ramp),
    };
  }

  function heatAt(p: number): RGB {
    if (MAX < 1) return T.H[0] ?? [255, 138, 36, 1];
    const t = (clamp(p, 0, MAX) / MAX) * 6;
    const i = clamp(Math.floor(t), 0, 5);
    return mix(T.H[i] ?? T.H[6], T.H[i + 1] ?? T.H[6], clamp(t - i, 0, 1));
  }

  const F = { W: 0, H: 0, x0: 0, x1: 0, yc: 0, P: 8, m: 6, extra: 0, cols: 0, left: 0 };
  let trail = new Float32Array(0);

  function layout() {
    const W = slider.clientWidth;
    const H = slider.clientHeight;
    if (!W || !H || MAX < 1) return;
    const cs = getComputedStyle(root);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const firstEnd = ends?.children[0] as HTMLElement | undefined;
    const half = (firstEnd?.offsetWidth || 48) / 2;
    const x0 = Math.max(padL + half, 34);
    const x1 = Math.min(W - padR - half, W - 34);
    if (x1 - x0 < 60) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const span = x1 - x0;
    const m = Math.max(3, Math.round(span / (MAX * 8)));
    const P = span / (MAX * m);
    const extra = Math.floor((x0 - 6) / P);
    Object.assign(F, { W, H, x0, x1, yc: H / 2, P, m, extra, cols: MAX * m + 1 + extra * 2, left: x0 - extra * P });
    for (const [cv, ctx] of [
      [main, mctx],
      [glow, gctx],
    ] as const) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    trail = new Float32Array(F.cols * ROWS);
  }

  const sim = {
    pos: level,
    vel: 0,
    target: level,
    t: 0,
    flash: 0,
    bt: 0,
    beat: 0,
    boot: reduce ? 1 : 0,
    pop: 0,
    ignite: -1,
    fired: false,
    hover: 0,
    hoverOn: false,
    hoverX: -1,
    press: 0,
    focus: 0,
    focusOn: false,
    igniteAt: 0,
  };
  const packets: Packet[] = [];
  const sparks: Spark[] = [];
  const ripples: Ripple[] = [];
  const ph = STR.map((s) => s.f);
  const sa = new Float32Array(NS);
  const ys = new Float32Array(NS);
  const pk = new Float32Array(NS);
  let nparts: Particle[] = [];
  let drag: { id: number; off: number; x0: number; live: boolean } | null = null;
  let running = false;
  let rafId = 0;
  let last = 0;

  const energy = () => clamp(sim.pos / MAX, 0, 1);
  const stopX = (i: number) => F.x0 + (i / MAX) * (F.x1 - F.x0);
  const soft = (u: number, lim: number) =>
    u < 0 ? -lim * (1 - Math.exp(u / lim)) : u > MAX ? MAX + lim * (1 - Math.exp(-(u - MAX) / lim)) : u;
  const thumbX = () => stopX(soft(sim.pos, 0.2));
  const lensR = () => 19 + 5 * energy() + 2 * sim.hover + 2.5 * sim.press + 2.5 * sim.pop;

  function spark(x: number, y: number, burst: boolean) {
    const a = burst ? Math.random() * TAU : -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
    const v = burst ? 60 + Math.random() * 110 : 16 + Math.random() * 44;
    sparks.push({
      x: x + (Math.random() - 0.5) * 8,
      y: y + (Math.random() - 0.5) * 6,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      fr: burst ? 4.2 : 2,
      life: 1,
      ttl: 0.45 + Math.random() * 0.8,
      s: 1.3 + Math.random() * 1.5,
    });
  }

  function step(dt: number) {
    const S = sim;
    S.t += dt;
    const dr = drag !== null && drag.live;
    const k = dr ? 560 : 250;
    const c = 2 * Math.sqrt(k) * (dr ? 0.95 : 0.6);
    for (let i = 0, h = dt / 4; i < 4; i++) {
      S.vel += (k * (S.target - S.pos) - c * S.vel) * h;
      S.pos += S.vel * h;
    }

    const e = energy();
    const ease = 1 - Math.exp(-dt * 8);
    for (let i = 0; i < NS; i++) {
      sa[i] += (clamp(S.pos - i, 0, 1) - sa[i]) * ease;
      ph[i] += STR[i].w * (1.3 + 4.4 * e) * dt;
    }
    S.hover += ((S.hoverOn && !drag ? 1 : 0) - S.hover) * (1 - Math.exp(-dt * 10));
    S.press += ((dr ? 1 : 0) - S.press) * (1 - Math.exp(-dt * 14));
    S.focus += ((S.focusOn ? 1 : 0) - S.focus) * (1 - Math.exp(-dt * 12));
    S.flash *= Math.exp(-dt * 4.5);
    S.pop *= Math.exp(-dt * 9);
    S.boot = Math.min(1, S.boot + dt / 0.8);
    S.bt += dt * (0.55 + 1.15 * e);
    const f = S.bt % 1;
    const f0 = Math.min(f, 1 - f);
    S.beat = Math.exp((-f0 * f0) / 0.004) + 0.55 * Math.exp(-((f - 0.2) ** 2) / 0.004);

    const tx = thumbX();
    if (level && S.boot > 0.6 && Math.random() < (0.3 + 0.62 * S.pos) * dt) {
      packets.push({
        x: F.left,
        s: Math.floor(Math.random() * clamp(Math.round(S.pos), 1, NS)),
        v: 55 + 55 * e + Math.random() * 35,
      });
    }
    for (let i = packets.length; i--; ) {
      const p = packets[i];
      const d = tx - p.x;
      if (d < -4 || sa[p.s] < 0.05) {
        packets.splice(i, 1);
        continue;
      }
      p.x += p.v * (1 + 2.4 * Math.exp(-d / 36)) * dt;
      if (p.x >= tx - 5) {
        packets.splice(i, 1);
        S.flash = Math.min(1, S.flash + 0.2);
      }
    }

    const sr = level === MAX ? 8 : level === MAX - 1 ? 2.2 : 0;
    if (sr && S.boot >= 1 && Math.random() < sr * dt) spark(tx, F.yc, false);
    for (let i = sparks.length; i--; ) {
      const p = sparks[i];
      p.life -= dt / p.ttl;
      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      p.vx *= Math.exp(-dt * p.fr);
      p.vy = p.vy * Math.exp(-dt * p.fr * 0.8) - 30 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    if (S.igniteAt && S.t >= S.igniteAt) {
      S.igniteAt = 0;
      if (level === MAX) {
        S.ignite = 0;
        S.fired = false;
      }
    }
    if (S.ignite >= 0 && !S.fired && level !== MAX) S.ignite = -1;
    if (S.ignite >= 0) {
      S.ignite += dt;
      if (!S.fired && S.ignite >= IGN) {
        S.fired = true;
        S.flash = 1;
        S.pop = 1.4;
        for (let i = 0; i < 26; i++) spark(tx, F.yc, true);
        ripples.push({ t0: S.t, x: tx, dir: 1, amp: 1.7 });
      }
      if (S.ignite > 1.2) S.ignite = -1;
    }
    for (let i = ripples.length; i--; ) if (S.t - ripples[i].t0 > 1.1) ripples.splice(i, 1);
  }

  function draw(dt: number) {
    if (!F.W || !mctx || !gctx) return;
    const S = sim;
    const ctx = mctx;
    const g = gctx;
    const P = F.P;
    const yc = F.yc;
    ctx.clearRect(0, 0, F.W, F.H);
    g.clearRect(0, 0, F.W, F.H);

    const e = energy();
    const tx = thumbX();
    const heat = heatAt(S.pos);
    const bootA = smooth(0.5, 1, S.boot);
    const R = lensR() * (0.55 + 0.45 * bootA);
    const sx = 1 + Math.min(0.24, Math.abs(S.vel) * 0.022);
    const sy = 1 / sx;
    const lensK = 0.4 + 0.16 * e + 0.1 * S.press;
    const coreB = clamp(S.pos, 0, 1) * ((0.3 + 0.5 * e) * (0.82 + 0.18 * S.beat) + S.flash * 0.9) * bootA;
    const L = Math.min(48, 10 + 0.5 * Math.max(0, tx - F.left));
    const amp = P * (0.9 + 2.25 * e);
    const turb = Math.max(0, e - 0.62) * 2.6;
    const sig = P * (0.44 + 0.1 * e);
    const inv = 1 / (2 * sig * sig);
    const pw = 1 / (2 * (1.6 * P) ** 2);
    const ign = S.ignite >= 0 && S.ignite < IGN ? S.ignite / IGN : -1;
    const sweepX = F.left + (tx - F.left) * ign * ign;
    const sw = 1 / (2 * (1.8 * P) ** 2);
    const bootF = S.boot < 1 ? S.boot * (F.cols + 10) : -1;
    const decay = dt > 0 ? Math.exp(-dt * 7) : 0;
    const right = F.left + (F.cols - 1) * P;
    const hovStop =
      sim.hover > 0.01 ? Math.round(clamp((sim.hoverX - F.x0) / (F.x1 - F.x0) * MAX, 0, MAX)) : -1;

    ctx.save();
    ctx.translate(tx, yc);
    ctx.scale(sx, sy);
    const tint = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    tint.addColorStop(0, css(heat, (0.1 + 0.1 * e) * bootA));
    tint.addColorStop(1, css(heat, 0.02 * bootA));
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
    ctx.restore();

    const B: Path2D[] = Array.from({ length: NB }, () => new Path2D());
    const G: Path2D[] = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const tick = new Path2D();

    for (let j = 0; j < F.cols; j++) {
      const xb = F.left + j * P;
      const d = tx - xb;
      const lit = smooth(-P * 0.4, P * 0.9, d);
      const src = smooth(0, 4 * P, xb - F.left);
      const edge = 0.3 + 0.7 * smooth(-P, 4 * P, Math.min(xb - F.left, right - xb));
      const sj = j - F.extra;
      const stopI = sj >= 0 && sj % F.m === 0 && sj <= MAX * F.m ? sj / F.m : -1;
      let boot = 1;
      let scan = 0;
      if (bootF >= 0) {
        const b = bootF - j;
        boot = smooth(0, 4, b);
        scan = Math.exp(-((b - 2) ** 2) / 3) * 0.9;
      }
      const sweep = ign >= 0 ? Math.exp(-((xb - sweepX) ** 2) * sw) * 1.1 : 0;

      if (lit > 0.001) {
        const env = 1 - Math.exp(-Math.max(0, d) / L);
        for (let i = 0; i < NS; i++) {
          if (sa[i] < 0.01) {
            pk[i] = 0;
            continue;
          }
          const s = STR[i];
          const q = (TAU / s.lam) * xb - ph[i];
          let y = Math.sin(q) * 0.78 + Math.sin(2.13 * q + s.f + S.t * 0.6) * 0.22;
          if (turb) y += turb * 0.38 * Math.sin(xb * 0.11 + S.t * 3.1 + s.f * 2) * Math.sin(xb * 0.047 - S.t * 1.7 + i);
          ys[i] = yc + y * amp * s.a * env;
          let b = 1;
          for (const p of packets)
            if (p.s === i) {
              const dx = xb - p.x;
              b += 2.3 * Math.exp((-dx * dx) / pw);
            }
          pk[i] = b * s.b * sa[i];
        }
      }

      for (let r = 0; r < ROWS; r++) {
        const yb = yc + (r - MID) * P;
        const rowF = 1 - 0.32 * ((r - MID) / MID) ** 2;
        let v = scan;
        if (lit > 0.001) {
          let sum = 0;
          for (let i = 0; i < NS; i++)
            if (pk[i]) {
              const dy = yb - ys[i];
              sum += pk[i] * Math.exp(-dy * dy * inv);
            }
          v += (sum * src * (0.62 + 0.38 * e) + sweep) * lit;
        }
        const isTick = stopI >= 0 && (r === 0 || r === ROWS - 1);
        if (isTick) {
          if (d >= -P * 0.5) v = Math.max(v, 0.5);
          if (stopI === hovStop && stopI !== level) v += 0.5 * sim.hover;
        }

        let px = xb;
        let py = yb;
        for (const rp of ripples) {
          const age = S.t - rp.t0;
          const ddx = px - rp.x;
          const ddy = py - yc;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          const front = rp.dir > 0 ? age * 240 : Math.max(0, 140 - age * 240);
          const k =
            Math.exp(-((dist - front) ** 2) / 162) *
            Math.max(0, 1 - age / (rp.dir > 0 ? 1.05 : 0.6)) *
            Math.min(1, age / 0.06) *
            rp.amp;
          px += (ddx / dist) * k * 3.4 * rp.dir;
          py += (ddy / dist) * k * 3.4 * rp.dir;
          v += k * (rp.dir > 0 ? 0.4 : 0.18);
        }

        let mag = 1;
        const dx = (px - tx) / sx;
        const dy = (py - yc) / sy;
        const rr = Math.sqrt(dx * dx + dy * dy);
        if (rr < R) {
          const u = rr / R;
          const sc = rr > 1e-3 ? 1 + (lensK * R * Math.sin(Math.PI * u)) / (Math.PI * rr) : 1 + lensK;
          mag = Math.sqrt(sc * (1 + lensK * Math.cos(Math.PI * u)));
          px = tx + dx * sc * sx;
          py = yc + dy * sy;
          v += coreB * Math.exp(-u * u * 5.5);
        }

        const index = j * ROWS + r;
        let vis = 1 - Math.exp(-1.5 * v);
        const tr = trail[index] * decay;
        if (tr > vis) vis = tr;
        trail[index] = vis;
        const rad = (1.05 * (isTick ? 1 : rowF) + 1.3 * vis) * mag * edge * boot;
        if (rad < 0.15) continue;
        const q = Math.min(NB - 1, Math.round(vis * (NB - 1)));
        if (q === 0 && isTick) {
          const rt = rad * 1.25;
          tick.moveTo(px + rt, py);
          tick.arc(px, py, rt, 0, TAU);
          continue;
        }
        B[q].moveTo(px + rad, py);
        B[q].arc(px, py, rad, 0, TAU);
        if (q >= 4) {
          const gp = G[Math.min(3, Math.floor((q - 4) / 3))];
          const gr = rad * 2.2;
          gp.moveTo(px + gr, py);
          gp.arc(px, py, gr, 0, TAU);
        }
      }
    }

    const hotMix = 0.12 + 0.88 * e * e;
    for (let q = 0; q < NB; q++) {
      const f = q / (NB - 1);
      let col = mix(T.dot, heat, smooth(0, 0.5, f));
      if (f > 0.5) col = mix(col, T.hot, smooth(0.5, 1, f) * hotMix);
      ctx.fillStyle = css(col);
      ctx.fill(B[q]);
    }
    ctx.fillStyle = css(T.tick);
    ctx.fill(tick);
    const gc = mix(heat, T.hot, 0.25 * hotMix);
    for (let k = 0; k < 4; k++) {
      g.fillStyle = css(gc, GA[k]);
      g.fill(G[k]);
    }

    if (coreB > 0.01) {
      const cr = 10 + 12 * e;
      const rg = g.createRadialGradient(tx, yc, 0, tx, yc, cr);
      rg.addColorStop(0, css(mix(heat, T.hot, 0.5), Math.min(1, coreB)));
      rg.addColorStop(1, css(heat, 0));
      g.fillStyle = rg;
      g.beginPath();
      g.arc(tx, yc, cr, 0, TAU);
      g.fill();
    }

    const rimA = (0.4 + 0.2 * e + 0.25 * sim.hover + 0.35 * sim.press) * bootA;
    ctx.save();
    ctx.translate(tx, yc);
    ctx.scale(sx, sy);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = css(heat, Math.min(1, rimA));
    ctx.beginPath();
    ctx.arc(0, 0, R + 0.5, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = css(heat, rimA * 0.28);
    ctx.beginPath();
    ctx.arc(0, 0, R + 4 + 1.5 * sim.press, 0, TAU);
    ctx.stroke();
    if (sim.focus > 0.01) {
      ctx.setLineDash([2, 3.5]);
      ctx.lineDashOffset = -S.t * 8;
      ctx.strokeStyle = css(T.text, 0.8 * sim.focus);
      ctx.beginPath();
      ctx.arc(0, 0, R + 8, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = css(T.glass, T.glass[3] * bootA);
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, R - 3.5, Math.PI * 1.1, Math.PI * 1.42);
    ctx.stroke();
    ctx.restore();

    if (hovStop >= 0 && hovStop !== level && !drag) {
      ctx.save();
      ctx.setLineDash([1.5, 3]);
      ctx.lineDashOffset = S.t * 6;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = css(T.H[hovStop] ?? heat, 0.6 * sim.hover * bootA);
      ctx.beginPath();
      ctx.arc(stopX(hovStop), yc, 9 + (4 * hovStop) / MAX, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    for (const p of sparks) {
      const a = p.life * smooth(0, 14, Math.min(p.y, F.H - p.y, p.x, F.W - p.x));
      const col = mix(heat, T.hot, a * a);
      const s = p.s * (0.55 + 0.45 * a);
      ctx.fillStyle = css(col, Math.min(1, a * 1.5));
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      g.fillStyle = css(col, a * 0.7);
      g.fillRect(p.x - s * 1.6, p.y - s * 1.6, s * 3.2, s * 3.2);
    }
  }

  let NW = 0;
  let NH = NR * NP + NPAD * 2;

  function layoutName() {
    if (!name || !nameBg || !nctx || !nbg) return;
    const nCols = words.reduce((max, w) => Math.max(max, w.cols), 0);
    NW = nCols * NP + NPAD * 2;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    for (const [cv, ctx] of [
      [name, nctx],
      [nameBg, nbg],
    ] as const) {
      cv.style.width = `${NW}px`;
      cv.style.height = `${NH}px`;
      cv.width = Math.round(NW * dpr);
      cv.height = Math.round(NH * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    paintNameBg();
  }

  function paintNameBg() {
    if (!nbg) return;
    const nCols = words.reduce((max, w) => Math.max(max, w.cols), 0);
    nbg.clearRect(0, 0, NW, NH);
    nbg.fillStyle = css(T.dot);
    nbg.beginPath();
    for (let r = 0; r < NR; r++)
      for (let c = 0; c < nCols; c++) {
        const x = NPAD + (c + 0.5) * NP;
        const y = NPAD + (r + 0.5) * NP;
        nbg.moveTo(x + 0.85, y);
        nbg.arc(x, y, 0.85, 0, TAU);
      }
    nbg.fill();
  }

  function morphName(i: number, dir: number, animate: boolean) {
    const W = words[i];
    if (!W) return;
    const now = sim.t;
    const tg = W.pts
      .map(([c, r]) => [NPAD + (c + 0.5) * NP, NPAD + (r + 0.5) * NP, c] as [number, number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const live = nparts
      .filter((p) => !p.ghost)
      .sort((a, b) => a.x - b.x || a.y - b.y);
    const used = new Uint8Array(live.length);
    const next: Particle[] = tg.map(([tx, ty, c], k) => {
      let sx = tx;
      let sy = ty;
      let a0 = 1;
      if (animate && live.length) {
        const si = Math.round((k * (live.length - 1)) / Math.max(1, tg.length - 1));
        used[si] = 1;
        sx = live[si].x;
        sy = live[si].y;
        a0 = live[si].a;
      } else if (animate) {
        sx = tx + (Math.random() - 0.5) * 16;
        sy = ty + 6 + Math.random() * 10;
        a0 = 0;
      }
      return {
        x: sx,
        y: sy,
        sx,
        sy,
        tx,
        ty,
        a: a0,
        a0,
        ghost: false,
        t0: now + (dir < 0 ? W.cols - c : c) * 0.007,
        dur: animate ? 0.44 + Math.random() * 0.1 : 0,
        arc: (dir < 0 ? 1 : -1) * (2 + Math.random() * 6),
        life: 1,
      };
    });
    const ghosts: Particle[] = animate
      ? nparts
          .filter((p) => p.ghost)
          .concat(live.filter((_, k) => !used[k]).map((p) => ({ ...p, ghost: true, life: 1 })))
      : [];
    nparts = next.concat(ghosts);
  }

  function drawName(dt: number) {
    if (!nctx) return;
    const ctx = nctx;
    const base = heatAt(sim.pos);
    const t = sim.t;
    ctx.clearRect(0, 0, NW, NH);
    const sheen = level === MAX && running ? ((t % 2.6) / 2.6) * (NW + 80) - 40 : -1e4;
    const pulse = running ? 0.16 * sim.beat * energy() : 0;
    for (let i = nparts.length; i--; ) {
      const p = nparts[i];
      if (p.ghost) {
        p.life -= dt * 3.6;
        if (p.life <= 0) {
          nparts.splice(i, 1);
          continue;
        }
        p.y += dt * 12;
        ctx.fillStyle = css(base, p.life * 0.8);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.45 * p.life, 0, TAU);
        ctx.fill();
        continue;
      }
      const k = p.dur ? clamp((t - p.t0) / p.dur, 0, 1) : 1;
      const eo = 1 - (1 - k) ** 3;
      const fly = Math.sin(Math.PI * k);
      p.x = p.sx + (p.tx - p.sx) * eo;
      p.y = p.sy + (p.ty - p.sy) * eo + fly * p.arc;
      p.a = p.a0 + (1 - p.a0) * Math.min(1, k * 2.5);
      const sh = Math.exp(-((p.x - sheen) ** 2) / 200);
      ctx.fillStyle = css(mix(base, T.hot, Math.min(1, fly * 0.6 + sh * 0.85 + pulse)), p.a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.45 + fly * 0.55 + sh * 0.35, 0, TAU);
      ctx.fill();
    }
  }

  function loop(now: number) {
    if (!running) return;
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt);
    draw(dt);
    drawName(dt);
    rafId = requestAnimationFrame(loop);
  }

  function staticRender() {
    sim.pos = sim.target = level;
    sim.vel = 0;
    sim.focus = sim.focusOn ? 1 : 0;
    for (let i = 0; i < NS; i++) sa[i] = clamp(sim.pos - i, 0, 1);
    draw(0);
    drawName(0);
  }

  function haptic(to: number) {
    if (!navigator.vibrate) return;
    navigator.vibrate(to === MAX ? [12, 40, 22] : Math.round(5 + (to / MAX) * 9));
  }

  function roll(el: HTMLElement | null, text: string, dir: number) {
    if (!el || el.textContent === text) return;
    el.textContent = text;
    if (!dir || reduce) return;
    el.animate?.(
      [
        { transform: `translateY(${dir * 80}%)`, opacity: 0, filter: 'blur(2px)' },
        { transform: 'none', opacity: 1, filter: 'none' },
      ],
      { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }

  function apply(next: number, animate: boolean) {
    const i = clamp(Math.round(next), 0, MAX);
    const prev = applied >= 0 ? applied : level;
    level = i;
    applied = i;
    if (!drag) sim.target = i;
    const dir = animate ? Math.sign(i - prev) : 0;
    const live = animate && running;
    root.style.setProperty('--c', css(heatAt(i)));
    slider.setAttribute('aria-valuenow', String(i));
    slider.setAttribute('aria-valuetext', `${labels[i]}, ${i + 1} of ${labels.length}`);
    roll(desc, hints[i] ?? '', dir);
    roll(idx, String(i + 1), dir);
    if (ends) {
      for (const child of Array.from(ends.children) as HTMLElement[]) {
        child.classList.toggle('on', Number(child.dataset.end) === i);
      }
    }
    morphName(i, dir, live);
    if (live && dir) {
      sim.pop = dir * 0.8;
      ripples.push({ t0: sim.t, x: stopX(i), dir, amp: 1 });
      if (ripples.length > 5) ripples.shift();
      if (i === MAX && prev < MAX) {
        sim.ignite = 0;
        sim.fired = false;
      }
    }
    if (animate) haptic(i);
    if (!running) staticRender();
  }

  function commit(i: number) {
    const n = clamp(Math.round(i), 0, MAX);
    if (n === level) return;
    apply(n, true);
    host.onCommit(n);
  }

  const uAt = (clientX: number) => {
    const r = slider.getBoundingClientRect();
    return ((clientX - r.left - F.x0) / (F.x1 - F.x0)) * MAX;
  };
  const rubber = (u: number) => soft(u, 0.35);
  const magnet = (u: number) => {
    const n = Math.round(u);
    const f = u - n;
    return n + Math.sign(f) * 0.5 * Math.pow(Math.abs(f) * 2, 2.2);
  };
  const onLens = (clientX: number) =>
    Math.abs(clientX - slider.getBoundingClientRect().left - thumbX()) <= lensR() + 4;

  function dragTo(u: number) {
    if (!drag) return;
    const raw = rubber(u - drag.off);
    const inside = clamp(raw, 0, MAX);
    sim.target = magnet(inside) + raw - inside;
    commit(Math.round(inside));
    if (!running) staticRender();
  }

  function pointerDown(clientX: number, pointerId: number, pointerType: string, target: HTMLElement) {
    if (!F.W) return;
    const u = uAt(clientX);
    drag = {
      id: pointerId,
      off: onLens(clientX) ? u - sim.pos : 0,
      x0: clientX,
      live: pointerType !== 'touch',
    };
    try {
      target.setPointerCapture(pointerId);
    } catch {
    }
    if (drag.live) {
      slider.classList.add('dragging');
      dragTo(u);
    }
  }

  function pointerMove(clientX: number, pointerId: number, pointerType: string) {
    sim.hoverX = clientX - slider.getBoundingClientRect().left;
    sim.hoverOn = pointerType === 'mouse';
    slider.classList.toggle('on-lens', onLens(clientX));
    if (!drag || pointerId !== drag.id) return;
    if (!drag.live && Math.abs(clientX - drag.x0) > 4) {
      drag.live = true;
      slider.classList.add('dragging');
    }
    if (drag.live) dragTo(uAt(clientX));
  }

  function pointerEnd(pointerId: number, kind: 'up' | 'cancel', clientX: number) {
    if (!drag || pointerId !== drag.id) return;
    if (!drag.live && kind === 'up') {
      drag.live = true;
      dragTo(uAt(clientX));
    }
    drag = null;
    slider.classList.remove('dragging');
    sim.target = level;
    if (!running) staticRender();
  }

  function pointerLeave() {
    sim.hoverOn = false;
    slider.classList.remove('on-lens');
  }

  function setFocus(on: boolean) {
    sim.focusOn = on;
    if (!running) staticRender();
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const STEPS: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 2,
      PageDown: -2,
    };
    const inc = STEPS[event.key];
    let v: number | null = inc
      ? level + inc
      : event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? MAX
          : null;
    if (v === null) return;
    event.preventDefault();
    sim.focusOn = true;
    v = clamp(v, 0, MAX);
    if (v === level) {
      sim.vel += (inc || (event.key === 'End' ? 1 : -1)) * 5;
      if (!running) staticRender();
      return;
    }
    sim.target = v;
    commit(v);
  }

  readTheme();
  layoutName();
  layout();
  apply(level, false);
  applied = -1;
  sim.igniteAt = reduce ? 0 : level === MAX ? 0.7 : 0;

  return {
    reduce,
    get labelsKey() {
      return labelsKey;
    },
    isRunning: () => running,
    layout,
    layoutName,
    readTheme,
    paintNameBg,
    staticRender,
    apply,
    setLabels(next: string[], key: string) {
      labels = next;
      labelsKey = key;
      MAX = Math.max(1, labels.length - 1);
      words = buildWords(labels);
      level = clamp(level, 0, MAX);
      applied = -1;
      layoutName();
      layout();
      apply(level, false);
    },
    start() {
      if (reduce || running) return;
      running = true;
      last = performance.now();
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
    pointerDown,
    pointerMove,
    pointerEnd,
    pointerLeave,
    setFocus,
    keyDown,
    slider,
  };
}
