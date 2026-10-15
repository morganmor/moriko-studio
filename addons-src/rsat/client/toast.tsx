/**
 * RSA/T popup notification (toast) — mekanisme 1:1 dari
 * design/split/rsat-panel-popup-notification.html, dipasang sebagai PROVIDER
 * GLOBAL (bukan halaman): board.tsx memuat <ToastHost/>, panel mana pun
 * memanggil toast(). Juga mengekspor useNow — tick waktu global agar
 * heartbeat (5 hati) menyusut live dan pill stale muncul otomatis.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Spr, sa } from './sprites.tsx';
import { Ic } from './icon.tsx';

export type ToastKind = 'info' | 'ok' | 'warn' | 'error' | 'ach';
type ToastItem = {
  id: number;
  kind: ToastKind;
  title: string;
  sub?: string;
  dur: number;
  tier: string;
  icon?: string;
  label?: string;
  action?: { label: string; run: () => void };
};

/** Label kecil (desain baris 177); `label` opsional menimpanya. */
const LABEL: Record<ToastKind, string> = {
  ach: 'Achievement unlocked',
  info: 'Notice',
  ok: 'Notice',
  warn: 'Guard',
  error: 'Blocked',
};

/** S.toasts desain: ach/info disembunyikan saat off; warn/error SELALU tampil. */
let toastsEnabled = true;
export function setToastsEnabled(on: boolean) {
  toastsEnabled = on;
}

/** Context toast global — diisi ToastHost saat mount, dipakai panel mana pun. */
let pushToast: ((t: Omit<ToastItem, 'id'>) => void) | null = null;
/** toast(kind, title, sub, o) — desain baris 178. Maks 3 tampil; tertua dibuang. */
export function toast(
  kind: ToastKind,
  title: string,
  sub?: string,
  o: { ms?: number; tier?: string; icon?: string; label?: string; action?: ToastItem['action'] } = {},
) {
  if (!toastsEnabled && (kind === 'ach' || kind === 'info' || kind === 'ok')) return;
  pushToast?.({
    kind,
    title,
    sub,
    dur: o.ms ?? 5000,
    tier: o.tier ?? 'gold',
    icon: o.icon,
    label: o.label,
    action: o.action,
  });
}

/** Tick waktu (default 1s) — re-render pemanggil agar hitungan live. */
export function useNow(step = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tm = setInterval(() => setNow(Date.now()), step);
    return () => clearInterval(tm);
  }, [step]);
  return now;
}

/** Kartu toast (desain baris 184–193): medal/ikon + label kecil + judul + sub + bar. */
function ToastCard({ t, out, kill }: { t: ToastItem; out: boolean; kill: (id: number) => void }) {
  const ch = t.kind === 'ach' && t.tier === 'diamond';
  const act = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    t.action?.run();
    kill(t.id);
  };
  return (
    <div
      className={`toast ${t.kind === 'ach' ? 'ach' : t.kind}${ch ? ' ch' : ''}${out ? ' out' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${t.label ?? LABEL[t.kind]}: ${t.title}`}
      onClick={() => kill(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          kill(t.id);
        }
      }}
      style={{ '--dur': `${t.dur}ms` } as CSSProperties}
    >
      <span className={`mw${t.kind === 'ach' ? '' : ' sm'}`}>
        <span
          className={`medal ${t.kind === 'ach' ? `t-${t.tier} shine` : 'sm'}`}
          style={t.kind === 'ach' ? undefined : ({ '--mc': 'rgb(var(--tc))' } as CSSProperties)}
        >
          {t.kind === 'ach' ? (
            <Spr name="ore" style={sa(`rgb(var(--c-rsat-${t.tier}))`)} />
          ) : (
            <Ic name={t.icon ?? (t.kind === 'error' ? 'x' : t.kind === 'warn' ? 'shield' : 'bell')} />
          )}
        </span>
      </span>
      <span className="grow">
        <small>{t.label ?? LABEL[t.kind]}</small>
        <b>{t.title}</b>
        {t.sub ? <span className="s">{t.sub}</span> : null}
      </span>
      {t.action ? (
        <span className="tbtn" role="button" tabIndex={0} onClick={act} onKeyDown={act}>
          {t.action.label}
        </span>
      ) : null}
      <i className="bar" />
    </div>
  );
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [dying, setDying] = useState<Set<number>>(new Set());
  const seq = useRef(0);
  const timers = useRef<Map<number, number>>(new Map());

  const kill = (id: number) => {
    setDying((p) => (p.has(id) ? p : new Set(p).add(id)));
    window.setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
      setDying((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
      const h = timers.current.get(id);
      if (h !== undefined) {
        clearTimeout(h);
        timers.current.delete(id);
      }
    }, 320);
  };

  useEffect(() => {
    pushToast = (t) => {
      const id = ++seq.current;
      // Desain baris 182: while (children >= 3) firstElementChild.remove()
      setItems((prev) => [...prev.slice(-2), { ...t, id }]);
      timers.current.set(id, window.setTimeout(() => kill(id), t.dur));
    };
    const pending = timers.current;
    return () => {
      pushToast = null;
      pending.forEach((h) => clearTimeout(h));
      pending.clear();
    };
  }, []);

  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <ToastCard key={t.id} t={t} out={dying.has(t.id)} kill={kill} />
      ))}
    </div>
  );
}
