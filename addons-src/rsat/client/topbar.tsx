/**
 * RSA/T topbar — port dari design/split/rsat-panel-topbar.html, versi backend:
 * crumb + tombol toggle sidebar host + toggle dock RSAT + kontrol tema/accent
 * host. Kontrol demo (acting-as, Simulate Agent B, Reset demo) DIHAPUS —
 * aksi agent kini nyata: mereka bekerja lewat tool rsat_* di sesi chat.
 */
import { useState } from 'react';
import { getAppearance, navigate, setAccent as hostSetAccent, setTheme as hostSetTheme, toggleSidebar } from '@moriko/host';
import { Ic } from './icon.tsx';

const ACCENTS = ['ember', 'sakura', 'matcha', 'ocean', 'violet'] as const;
const THEMES = ['light', 'dark', 'mocha'] as const;

/** Kontrol tampilan host (tema/accent) — preferensi nyata, bukan demo. */
function Appearance() {
  const [ap, setAp] = useState(() => getAppearance());
  const pickTheme = (m: (typeof THEMES)[number]) => {
    hostSetTheme(m);
    setAp(getAppearance());
  };
  const pickAccent = (a: (typeof ACCENTS)[number]) => {
    hostSetAccent(a);
    setAp(getAppearance());
  };

  return (
    <div className="demo" role="group" aria-label="Appearance">
      <span className="seg-ctl" role="group" aria-label="Theme">
        {THEMES.map((m) => (
          <button key={m} type="button" aria-pressed={ap.theme === m} onClick={() => pickTheme(m)}>
            {m}
          </button>
        ))}
      </span>
      {ACCENTS.map((a) => (
        <button
          key={a}
          className="sw"
          type="button"
          data-accent={a}
          aria-pressed={ap.accent === a}
          aria-label={`Accent ${a}`}
          onClick={() => pickAccent(a)}
        />
      ))}
    </div>
  );
}

/** Label crumb per view (desain: #crumbView dinamis). */
const VIEW_LABELS: Record<string, string> = {
  overview: 'Overview',
  board: 'Quest board',
  tree: 'Skill tree',
  interlinked: 'Interlinked',
  activity: 'Live feed',
  files: 'Inventory',
  settings: 'Options',
  create: 'Create agent',
};

export default function Topbar({
  view,
  dockOpen,
  onToggleDock,
}: {
  view: string;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  return (
    <header className="topbar">
      {/* Tombol back: kembali ke percakapan yang membuka board ini. */}
      <button
        className="icon-btn host-toggle"
        type="button"
        aria-label="Back to conversation"
        onClick={() => navigate('playground')}
      >
        <Ic name="chev-l" />
      </button>
      <div className="crumb">
        Addons <b>›</b> RSA/T <b>›</b> <b>{VIEW_LABELS[view] ?? 'Overview'}</b>
        {/* Tombol sidebar: DOM di dalam .crumb, visual absolut di pojok kanan topbar. */}
        <button
          className="icon-btn"
          type="button"
          aria-label="Toggle dock"
          aria-expanded={dockOpen}
          onClick={onToggleDock}
        >
          <Ic name="panel" />
        </button>
      </div>
      <Appearance />
    </header>
  );
}
