/**
 * RSA/T Quest board — port 1:1 dari design/split/rsat-panel-quest-board.html.
 * Toolbar (search + chip state + tier/sort + New quest) → board grouped per state
 * (order desain baris 279) dengan kartu .pn.ach. Data dari store bersama;
 * "New quest" membuka QuestForm (RSAT.txt butir 1).
 */
import { useState } from 'react';
import { tr } from './shared.tsx';
import { useNow } from './toast.tsx';
import { Spr, sa } from './sprites.tsx';
import { Ic } from './icon.tsx';
import QuestForm from './questform.tsx';
import {
  byId, createQuest, eff, isStale, prog, ttlMs, useRsat, who,
  type Ach,
} from './store.tsx';
import { AgentFace } from './agentstore.tsx';

function Seg({ pct, n = 10, cls = '' }: { pct: number; n?: number; cls?: string }) {
  const on = Math.round((pct / 100) * n);
  return (
    <div className={`seg ${cls}`} role="img" aria-label={`${pct}%`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < on ? 'on' : undefined} />
      ))}
    </div>
  );
}

/** Wajah holder: logo agent custom bila ada (AgentFace), selain itu sprite. */
function Face({ by, ag }: { by: string; ag?: string | null }) {
  return <AgentFace by={by} ag={ag} />;
}

function Hearts({ beat }: { beat: number }) {
  const now = useNow();
  const r = 1 - (now - beat) / ttlMs();
  const n = Math.max(0, Math.min(5, Math.ceil(r * 5)));
  return (
    <span className="hearts" role="img" aria-label="Heartbeat">
      {Array.from({ length: 5 }, (_, i) => (
        <Spr key={i} name="heart" cls={i < n ? '' : 'off'} style={sa(i < n ? 'rgb(var(--c-danger))' : 'rgb(var(--c-rsat-locked))')} />
      ))}
    </span>
  );
}

function Medal({ a, e }: { a: Ach; e: string }) {
  const lock = e === 'locked';
  return (
    <span className="mw">
      <span className={`medal t-${a.tier}${lock ? ' lock' : ''}${e === 'available' ? ' glow' : ''}`}>
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

function Card({ a, list, lang, onOpen }: { a: Ach; list: Ach[]; lang: string; onOpen: (id: string) => void }) {
  const t = (k: string) => tr(lang, k);
  const now = useNow();
  const e = eff(list, a);
  const p = prog(a);
  const foot = a.claim ? (
    <span className="holder">
      <Face by={a.claim.by} ag={a.claim.ag} />
      <b>{who(a.claim.by)}</b>
      <Hearts beat={a.claim.beat} />
      {isStale(a, now) ? <span className="pill st-warn">{t('stale')}</span> : null}
    </span>
  ) : e === 'locked' ? (
    <span>
      {t('deps')} {a.dep.filter((d) => byId(list, d) && byId(list, d)!.state !== 'done').join(', ')}
    </span>
  ) : (
    <span>
      {t('holder')}: {t('none')}
    </span>
  );
  return (
    <article
      className={`pn ach hov st-${e}${e === 'locked' ? ' locked' : ''}`}
      role="button" tabIndex={0}
      onClick={() => onOpen(a.id)}
      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpen(a.id); } }}
    >
      <div className="top">
        <Medal a={a} e={e} />
        <div className="grow">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="mono muted" style={{ fontSize: 11 }}>
              {a.id}
            </span>
            <span className={`pill st-${e}`}>{t(`s_${e}`)}</span>
          </div>
          <h3 style={{ marginTop: 6 }}>{a.title}</h3>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {a.desc}
      </div>
      <Seg pct={p} cls={e === 'done' ? 'done' : ''} />
      <div className="foot">
        {foot}
        <span className="grow" />
        <span>{a.pts} pts</span>
        <span>{p}%</span>
      </div>
    </article>
  );
}

const ORDER = ['in_progress', 'claimed', 'review', 'available', 'locked', 'blocked', 'done', 'dropped'];
const STATE_CHIPS = ['all', 'in_progress', 'review', 'available', 'locked', 'done'];

function Toolbar({ lang, q, state, tier, sort, onQ, onState, onTier, onSort, onNew }: {
  lang: string;
  q: string;
  state: string;
  tier: string;
  sort: string;
  onQ: (v: string) => void;
  onState: (v: string) => void;
  onTier: (v: string) => void;
  onSort: (v: string) => void;
  onNew: () => void;
}) {
  const t = (k: string) => tr(lang, k);
  return (
    <div className="toolbar">
      <label className="search grow" style={{ maxWidth: 340 }}>
        <Ic name="search" sm />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
        />
      </label>
      {STATE_CHIPS.map((s) => (
        <button key={s} className="chip" type="button" aria-pressed={state === s} onClick={() => onState(s)}>
          {s === 'all' ? t('all') : t(`s_${s}`)}
        </button>
      ))}
      <select className="field" value={tier} onChange={(e) => onTier(e.target.value)} aria-label="Tier">
        {['all', 'bronze', 'silver', 'gold', 'diamond'].map((v) => (
          <option key={v} value={v}>
            {v === 'all' ? 'All tiers' : v}
          </option>
        ))}
      </select>
      <select className="field" value={sort} onChange={(e) => onSort(e.target.value)} aria-label="Sort">
        <option value="no">Order</option>
        <option value="points">Points</option>
      </select>
      <button className="btn pri" type="button" onClick={onNew}>
        <Ic name="plus" sm /> {t('newQuest')}
      </button>
    </div>
  );
}

export default function QuestBoard({ onOpen }: { onOpen: (id: string) => void }) {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);
  const [f, setF] = useState({ state: 'all', tier: 'all', q: '', sort: 'no' });
  const [creating, setCreating] = useState(false);
  const list = s.achs;

  const q = f.q.toLowerCase();
  const filtered = list
    .filter(
      (a) =>
        (f.state === 'all' || eff(list, a) === f.state) &&
        (f.tier === 'all' || a.tier === f.tier) &&
        (!q || `${a.id} ${a.title} ${a.tags.join(' ')}`.toLowerCase().includes(q)),
    )
    .sort((x, y) => (f.sort === 'points' ? y.pts - x.pts : x.no - y.no));

  if (creating) {
    return (
      <QuestForm
        lang={lang}
        deps={list.map((a) => a.id)}
        onSave={(q) => {
          createQuest({
            title: q.title, kind: q.kind, tier: q.tier, pts: q.pts, dep: q.dep,
            desc: q.desc, tech: q.tech, ac: q.ac, inc: q.inc,
          });
          setCreating(false);
        }}
        onCancel={() => setCreating(false)}
      />
    );
  }
  return (
    <>
      <Toolbar
        lang={lang}
        q={f.q}
        state={f.state}
        tier={f.tier}
        sort={f.sort}
        onQ={(v) => setF({ ...f, q: v })}
        onState={(v) => setF({ ...f, state: v })}
        onTier={(v) => setF({ ...f, tier: v })}
        onSort={(v) => setF({ ...f, sort: v })}
        onNew={() => setCreating(true)}
      />
      <div className="col" style={{ gap: 26 }}>
        {!filtered.length ? (
          <div className="empty">{t('emptyBoard')}</div>
        ) : (
          ORDER.map((st) => {
            const items = filtered.filter((a) => eff(list, a) === st);
            if (!items.length) return null;
            return (
              <section key={st}>
                <div className="group-h">
                  <span className={`dot st-${st}`} />
                  <h2>{t(`s_${st}`)}</h2>
                  <span className="cnt muted">{items.length}</span>
                  <span className="line" />
                </div>
                <div className="board">
                  {items.map((a) => (
                    <Card key={a.id} a={a} list={list} lang={lang} onOpen={onOpen} />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
