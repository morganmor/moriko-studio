/**
 * RSA/T HUD — port 1:1 dari design/split/rsat-panel-hud.html.
 * .hud = .xpw (level + XP bar 24 segmen) + .hotbar.pn (7 slot view, kbd 1-7, badge).
 * Tooltip title desain diganti aria-label (aturan workspace: dilarang tooltip native).
 */
import { type KeyboardEvent } from 'react';
import { Ic } from './icon.tsx';
import { eff, useRsat } from './store.tsx';

const VIEWS: Array<[string, string, string]> = [
  ['overview', 'grid', 'Base camp'],
  ['board', 'trophy', 'Quest board'],
  ['tree', 'tree', 'Skill tree'],
  ['interlinked', 'nodes', 'Interlinked'],
  ['activity', 'activity', 'Live feed'],
  ['files', 'folder', 'Inventory'],
  ['settings', 'gear', 'Options'],
  ['create', 'spark', 'Create agent'],
];

function Seg({ pct, n, cls = '' }: { pct: number; n: number; cls?: string }) {
  const on = Math.round((pct / 100) * n);
  return (
    <div className={`seg ${cls}`} role="img" aria-label={`${Math.round(pct)}%`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < on ? 'on' : undefined} />
      ))}
    </div>
  );
}

export default function Hud({ view, onView }: { view: string; onView: (view: string) => void }) {
  const s = useRsat();
  const xp = s.achs.filter((a) => a.state === 'done').reduce((x, a) => x + a.pts, 0);
  const lv = 1 + Math.floor(xp / 40);
  const cur = xp % 40;
  const avail = s.achs.filter((a) => eff(s.achs, a) === 'available').length;

  const onKey = (e: KeyboardEvent) => {
    if (!/^[1-8]$/.test(e.key)) return;
    onView(VIEWS[+e.key - 1][0]);
  };

  return (
    <div className="hud">
      <div className="xpw" aria-label={`${cur} / 40 emeralds to next level`}>
        <span className="lvn">{lv}</span>
        <Seg pct={(cur / 40) * 100} n={24} cls="xp" />
      </div>
      <div className="hotbar pn" role="group" aria-label="Views (keys 1-8)" onKeyDown={onKey}>
        {VIEWS.map(([v, icon, label], n) => (
          <button
            key={v}
            className="slot"
            type="button"
            aria-label={label}
            aria-current={view === v ? 'page' : undefined}
            onClick={() => onView(v)}
          >
            <Ic name={icon} />
            <kbd>{n + 1}</kbd>
            {v === 'board' && avail ? <span className="badge">{avail}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
