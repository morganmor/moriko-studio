/**
 * RSA/T Skill tree — achievement map (permintaan user): TANPA scroll.
 * Kamera transform translate+scale — pan dengan drag mouse (pointer events,
 * grip pixel), zoom dengan wheel (non-passive, memperbesar ke arah kursor).
 * Data node dari store bersama (useRsat) — ikut berubah saat quest dibuat/diubah.
 * Topologi/garis/medal/tip tetap port 1:1 desain rsat-panel-skill-tree.html.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { tr } from './shared.tsx';
import { Spr, sa } from './sprites.tsx';
import { eff, prog, useRsat, type Ach } from './store.tsx';

type Pos = { c: number; r: number };

/** Layout desain (baris 197–209): depth memo → kolom; row = rata-rata parent, di-spasi. */
function layout(list: Ach[]): Record<string, Pos> {
  const dp: Record<string, number> = {};
  const by = (id: string) => list.find((a) => a.id === id);
  const depth = (a: Ach): number => {
    if (a.id in dp) return dp[a.id];
    dp[a.id] = 0;
    return (dp[a.id] = a.dep.reduce((m, d) => {
      const p = by(d);
      return p ? Math.max(m, depth(p) + 1) : m;
    }, 0));
  };
  list.forEach(depth);
  const used: Record<number, Set<number>> = {};
  const pos: Record<string, Pos> = {};
  [...list]
    .sort((x, y) => dp[x.id] - dp[y.id] || x.no - y.no)
    .forEach((a) => {
      const col = dp[a.id];
      used[col] = used[col] || new Set();
      const ps = a.dep.map((d) => pos[d]).filter(Boolean);
      let r = ps.length ? Math.round(ps.reduce((s, p) => s + p.r, 0) / ps.length) : 0;
      while (used[col].has(r)) r++;
      used[col].add(r);
      pos[a.id] = { c: col, r };
    });
  return pos;
}

/** Kamera map: pan (drag) + zoom (wheel di posisi kursor).
 *  transform-origin:0 0 → koordinat kamera: world = (viewport − t)/z.
 *  Clamp: tepi map tak boleh keluar viewport (margin 120px). */
const ZMIN = 0.5, ZMAX = 2.25, MARG = 120;
const lim = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function clampCam(z: number, x: number, y: number, vw: number, vh: number, W: number, H: number): { x: number; y: number } {
  return {
    x: lim(x, Math.min(MARG - W * z, vw - MARG), Math.max(MARG - W * z, vw - MARG)),
    y: lim(y, Math.min(MARG - H * z, vh - MARG), Math.max(MARG - H * z, vh - MARG)),
  };
}

function usePanZoom(W: number, H: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cam, setCam] = useState({ z: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState(false);
  const dr = useRef<{ px: number; py: number; id: number; moved: boolean } | null>(null);

  // Pan dengan AMBANG 4px: capture & pan baru dimulai setelah mouse benar-benar
  // bergeser — supaya klik (node/tombol) tidak dimakan pointer capture.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    dr.current = { px: e.clientX, py: e.clientY, id: e.pointerId, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const st = dr.current;
    if (!st) return;
    const el = ref.current;
    if (!el) return;
    const dx = e.clientX - st.px, dy = e.clientY - st.py;
    if (!st.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      (e.currentTarget as HTMLElement).setPointerCapture(st.id);
      st.moved = true;
      setDrag(true);
    }
    dr.current = { ...st, px: e.clientX, py: e.clientY };
    setCam((c) => {
      const r = el.getBoundingClientRect();
      const p = clampCam(c.z, c.x + dx, c.y + dy, r.width, r.height, W, H);
      return { ...c, ...p };
    });
  };
  const endPan = () => { dr.current = null; setDrag(false); };

  // Zoom wheel: non-passive (preventDefault) — anchor di posisi kursor.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setCam((c) => {
        const z2 = Math.max(ZMIN, Math.min(ZMAX, c.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const k = z2 / c.z;
        const p = clampCam(z2, mx - (mx - c.x) * k, my - (my - c.y) * k, r.width, r.height, W, H);
        return { z: z2, ...p };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [W, H]);

  return { ref, cam, drag, onPointerDown, onPointerMove, endPan };
}

function Medal({ a, e }: { a: Ach; e: string }) {
  const lock = e === 'locked';
  return (
    <span className="mw lg">
      <span className={`medal t-${a.tier}${lock ? ' lock' : ''} lg${e === 'available' ? ' glow' : ''}`}>
        <Spr name={lock ? 'lock' : 'ore'} style={sa(lock ? 'rgb(var(--c-rsat-locked))' : `rgb(var(--c-rsat-${a.tier}))`)} />
      </span>
      {e === 'done' ? (
        <span className="bdg">
          <Spr name="check" style={sa('rgb(var(--c-rsat-done))')} />
        </span>
      ) : ['claimed', 'in_progress', 'review', 'blocked'].includes(e) ? (
        <span className={`pip st-${e}`} />
      ) : null}
    </span>
  );
}

function Node({ a, list, x, y, lang, onOpen }: { a: Ach; list: Ach[]; x: number; y: number; lang: string; onOpen: (id: string) => void }) {
  const t = (k: string) => tr(lang, k);
  const e = eff(list, a);
  return (
    <button className={`nd st-${e}`} type="button" onClick={() => onOpen(a.id)} style={{ left: `${x}px`, top: `${y}px` }} aria-label={`${a.id} ${a.title}`}>
      <Medal a={a} e={e} />
      <span className="nl">{a.id}</span>
      <span className="tip">
        <b className={`tt t-${a.tier}`}>{a.title}</b>
        <span>{a.desc}</span>
        <span className="tm">
          {t(`s_${e}`)} · {a.pts} pts · {prog(a)}%
        </span>
      </span>
    </button>
  );
}

export default function SkillTree({ onOpen }: { onOpen: (id: string) => void }) {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);
  const ACH = s.achs;

  const pos = layout(ACH);
  const COLW = 150, ROWH = 106, PX = 34, PY = 30, NS = 64;
  const ps = Object.values(pos);
  const cols = ps.length ? Math.max(...ps.map((p) => p.c)) + 1 : 1;
  const rows = ps.length ? Math.max(...ps.map((p) => p.r)) + 1 : 1;
  const W = PX * 2 + (cols - 1) * COLW + NS + 280;
  const H = PY * 2 + (rows - 1) * ROWH + NS + 110;
  const cx = (p: Pos) => PX + p.c * COLW;
  const cy = (p: Pos) => PY + p.r * ROWH;
  const map = usePanZoom(W, H);

  const lines = ACH.flatMap((a) =>
    a.dep
      .filter((d) => pos[d] && pos[a.id])
      .map((d) => {
        const p = pos[d], q = pos[a.id];
        const x1 = cx(p) + NS, y1 = cy(p) + NS / 2, x2 = cx(q), y2 = cy(q) + NS / 2;
        const xm = Math.round(((x1 + x2) / 2) / 4) * 4;
        const parent = ACH.find((x) => x.id === d);
        return (
          <path key={`${d}>${a.id}`} className={`ln${parent?.state === 'done' ? ' on' : ''}`} d={`M${x1} ${y1}H${xm}V${y2}H${x2}`} />
        );
      }),
  );

  return (
    <>
      <div className="col">
        <h2>{t('tree')}</h2>
        <div className="legend">
          {['locked', 'available', 'in_progress', 'review', 'done'].map((st) => (
            <span key={st}>
              <i className={`dot st-${st}`} />
              {t(`s_${st}`)}
            </span>
          ))}
          <span className="faint">Drag map to pan · scroll to zoom · hover a node to read it · green line = parent done</span>
        </div>
      </div>
      <div
        className={`pn in treewrap${map.drag ? ' grabbing' : ''}`}
        ref={map.ref}
        onPointerDown={map.onPointerDown}
        onPointerMove={map.onPointerMove}
        onPointerUp={map.endPan}
        onPointerLeave={map.endPan}
      >
        <div
          className="tree-in"
          style={{ transform: `translate(${map.cam.x}px, ${map.cam.y}px) scale(${map.cam.z})` } as CSSProperties}
        >
          <div className="world" style={{ width: `${W}px`, height: `${H}px` }}>
            <svg className="lines" width={W} height={H} aria-hidden="true">
              {lines}
            </svg>
            {ACH.map((a) => (
              <Node key={a.id} a={a} list={ACH} x={cx(pos[a.id])} y={cy(pos[a.id])} lang={lang} onOpen={onOpen} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
