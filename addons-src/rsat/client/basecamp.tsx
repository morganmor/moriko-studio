/**
 * RSA/T Base camp — port 1:1 dari design/split/rsat-panel-basecamp.html,
 * versi backend: data dari store (rpc state), Start/Pause via rpc,
 * create/edit PRD via rpc createPrd/updatePrd, export via rpc exportDoc
 * (file juga tersimpan di .moriko/rsat/exports/). Party dari presence server.
 */
import { useState } from 'react';
import { rpc, tr } from './shared.tsx';
import { toast, useNow } from './toast.tsx';
import { Spr, sa } from './sprites.tsx';
import { Ic } from './icon.tsx';
import PrdForm from './prdform.tsx';
import { AgentFace, useAgents } from './agentstore.tsx';
import {
  createPrd, eff, isStale, prog, setLang, togglePrd, ttlMs, updatePrd, useRsat, who,
  type Ach, type Claim, type Prd,
} from './store.tsx';

const LV = 40;

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

/** Wajah holder: logo agent custom bila ada (AgentFace), selain itu sprite. */
function Face({ by, ag }: { by: string; ag?: string | null }) {
  return <AgentFace by={by} ag={ag} />;
}

/** 5 hati proporsional sisa heartbeat claim (jendela = claimTtlSec server). */
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

function Holder({ claim, stale, lang }: { claim: Claim; stale: boolean; lang: string }) {
  return (
    <span className="holder">
      <Face by={claim.by} ag={claim.ag} />
      <b>{who(claim.by)}</b>
      <Hearts beat={claim.beat} />
      {stale ? <span className="pill st-warn">{tr(lang, 'stale')}</span> : null}
    </span>
  );
}

function Medal({ a, list, sz }: { a: Ach; list: Ach[]; sz?: 'sm' | 'lg' }) {
  const e = eff(list, a);
  const lock = e === 'locked';
  const badge =
    e === 'done' ? (
      <span className="bdg">
        <Spr name="check" style={sa('rgb(var(--c-rsat-done))')} />
      </span>
    ) : ['claimed', 'in_progress', 'review', 'blocked'].includes(e) ? (
      <span className={`pip st-${e}`} />
    ) : null;
  return (
    <span className={sz ? `mw ${sz}` : 'mw'}>
      <span className={`medal t-${a.tier}${lock ? ' lock' : ''}${sz ? ` ${sz}` : ''}${e === 'available' ? ' glow' : ''}`}>
        <Spr name={lock ? 'lock' : 'ore'} style={sa(lock ? 'rgb(var(--c-rsat-locked))' : `rgb(var(--c-rsat-${a.tier}))`)} />
      </span>
      {badge}
    </span>
  );
}

function Qrow({ a, list, lang, onOpen }: { a: Ach; list: Ach[]; lang: string; onOpen: (id: string) => void }) {
  const now = useNow();
  return (
    <div
      className="qrow pn in hov" role="button" tabIndex={0}
      onClick={() => onOpen(a.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(a.id); } }}
    >
      <Medal a={a} list={list} sz="sm" />
      <div className="grow">
        <div className="trunc">
          <b>{a.id}</b> {a.title}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {a.claim ? <Holder claim={a.claim} stale={isStale(a, now)} lang={lang} /> : tr(lang, 'none')}
        </div>
      </div>
      <div className="qseg">
        <Seg pct={prog(a)} n={8} cls="thin" />
      </div>
    </div>
  );
}

function Hero({ prd, lang, xp, all, onExport, onEdit }: {
  prd: Prd; lang: string; xp: number; all: number;
  onExport: () => void; onEdit: () => void;
}) {
  const t = (k: string) => tr(lang, k);
  const status = prd.status;
  const main: [string, string] = status === 'draft' ? ['start', 'play'] : status === 'running' ? ['pause', 'pause'] : ['resume', 'play'];
  return (
    <section className="pn hero">
      <div className="dropw">
        <div className="drop">
          <Spr name="gem" style={sa('rgb(var(--c-rsat-diamond))')} />
        </div>
      </div>
      <div className="grow">
        <div className="eyebrow">World · .moriko/rsat/prd.rsprd.json</div>
        <h1 style={{ marginTop: 8 }}>{prd.title}</h1>
        <p className="muted" style={{ margin: '6px 0 0', maxWidth: '62ch' }}>
          {prd.summary}
        </p>
        <div className="meta">
          <span className={`pill st-${status === 'running' ? 'ok' : status === 'paused' ? 'warn' : 'muted'}`}>{status}</span>
          <span className="tag">LV {1 + Math.floor(xp / LV)}</span>
          <span className="tag">
            {xp}/{all} {t('points')}
          </span>
          <span className="tag">lang: {lang}</span>
        </div>
      </div>
      <div className="acts col" style={{ alignItems: 'stretch' }}>
        <button className="btn pri" type="button" onClick={togglePrd}>
          <Ic name={main[1]} /> {t(main[0])}
        </button>
        <div className="row">
          <button className="btn sm" type="button" onClick={onEdit}>
            <Ic name="file-edit" sm /> {t('editPrd')}
          </button>
          <button className="btn sm" type="button" onClick={onExport}>
            <Ic name="download" sm /> {t('exportL')}
          </button>
          <button className="btn sm" type="button" onClick={() => setLang(lang === 'en' ? 'id' : 'en')}>
            {lang.toUpperCase()}
          </button>
        </div>
      </div>
    </section>
  );
}

function Stats({ list, lang }: { list: Ach[]; lang: string }) {
  const t = (k: string) => tr(lang, k);
  const total = list.length || 1;
  const done = list.filter((a) => a.state === 'done').length;
  const avail = list.filter((a) => eff(list, a) === 'available').length;
  const active = list.filter((a) => ['claimed', 'in_progress'].includes(a.state)).length;
  const review = list.filter((a) => a.state === 'review').length;
  const xp = list.filter((a) => a.state === 'done').reduce((s, a) => s + a.pts, 0);
  return (
    <div className="stats">
      <div className="pn stat">
        <span className="eyebrow">Done</span>
        <b>
          {done}
          <span className="faint" style={{ fontSize: 15 }}>
            /{list.length}
          </span>
        </b>
        <Seg pct={(done / total) * 100} n={10} cls="done" />
      </div>
      <div className="pn stat">
        <span className="eyebrow">{t('s_available')}</span>
        <b>{avail}</b>
      </div>
      <div className="pn stat">
        <span className="eyebrow">{t('s_in_progress')}</span>
        <b>{active}</b>
      </div>
      <div className="pn stat">
        <span className="eyebrow">{t('s_review')}</span>
        <b>{review}</b>
      </div>
      <div className="pn stat">
        <span className="eyebrow">{t('points')}</span>
        <b className="row" style={{ gap: 8 }}>
          <span style={{ width: 26, height: 23 }}>
            <Spr name="gem" style={sa('rgb(var(--c-rsat-done))')} />
          </span>
          {xp}
        </b>
      </div>
    </div>
  );
}

function ScopeCard({ prd, lang }: { prd: Prd; lang: string }) {
  const t = (k: string) => tr(lang, k);
  return (
    <div className="card col">
      <h2>{t('scopeGlobal')}</h2>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {prd.inc.map((g) => (
          <span className="tag in" key={`in:${g}`}>
            {g}
          </span>
        ))}
        {prd.exc.map((g) => (
          <span className="tag ex" key={`ex:${g}`}>
            {g}
          </span>
        ))}
      </div>
      <h3 style={{ marginTop: 6 }}>{t('constraints')}</h3>
      {prd.cons.length ? (
        prd.cons.map((k) => (
          <div className="row" key={k.t}>
            <span className={`pill st-${k.m === 'strict' ? 'danger' : 'muted'}`}>{k.m}</span>
            <span>{k.t}</span>
          </div>
        ))
      ) : (
        <span className="muted">None</span>
      )}
    </div>
  );
}

/** Arsitektur + modul + milestone + NFR + risiko (PRD skala arsitektur). */
function ArchCard({ prd, list }: { prd: Prd; list: Ach[] }) {
  const modMeta = (id: string) => {
    const tagged = list.filter((a) => a.moduleId === id);
    const done = tagged.filter((a) => a.state === 'done').length;
    return { n: tagged.length, done };
  };
  const mileMeta = (id: string) => {
    const tagged = list.filter((a) => a.milestoneId === id);
    const done = tagged.filter((a) => a.state === 'done').length;
    return { n: tagged.length, done };
  };
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Architecture & Layer Matrix</h2>
        <span className="chip">Anti-Blindness Guard</span>
      </div>
      {prd.architecture ? <p className="muted" style={{ margin: '0 0 6px', maxWidth: '62ch' }}>{prd.architecture}</p> : null}
      {prd.modules && prd.modules.length ? (
        <>
          <div className="eyebrow">Modules & Allowed Layer Imports</div>
          {prd.modules.map((m, idx) => {
            const meta = modMeta(m.id);
            const defaultLayer = m.layer || (idx === 0 ? 'domain' : idx === 1 ? 'presentation' : 'application');
            const allowed = m.allowedImports?.length ? m.allowedImports : [m.id, 'm01'];
            return (
              <div className="qrow pn in" key={m.id}>
                <span className="mono muted" style={{ fontSize: 11, width: 34 }}>{m.id}</span>
                <div className="grow">
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <b>{m.name}</b>
                    <span className="layer-pill">{defaultLayer}</span>
                    <span className="mono muted" style={{ fontSize: 10.5 }}>
                      → allows [{allowed.join(', ')}]
                    </span>
                  </div>
                  {m.desc ? <div className="muted" style={{ fontSize: 12 }}>{m.desc}</div> : null}
                  {m.inc.length ? <div className="muted mono" style={{ fontSize: 11 }}>{m.inc.join(', ')}</div> : null}
                </div>
                {meta.n > 0 ? <span className="pill st-muted">{meta.done}/{meta.n}</span> : <span className="pill st-muted">0</span>}
              </div>
            );
          })}
        </>
      ) : null}
      {prd.milestones && prd.milestones.length ? (
        <>
          <div className="eyebrow">Milestones</div>
          {prd.milestones.map((m) => {
            const meta = mileMeta(m.id);
            const complete = meta.n > 0 && meta.done === meta.n;
            return (
              <div className="qrow pn in" key={m.id}>
                <span className="mono muted" style={{ fontSize: 11, width: 34 }}>{m.id}</span>
                <div className="grow">
                  <b>{m.title}</b>
                  {m.goal ? <div className="muted" style={{ fontSize: 12 }}>{m.goal}</div> : null}
                </div>
                <span className={`pill st-${complete ? 'done' : 'muted'}`}>{complete ? 'done' : `${meta.done}/${meta.n}`}</span>
              </div>
            );
          })}
        </>
      ) : null}
      {prd.nonFunctional && prd.nonFunctional.length ? (
        <>
          <div className="eyebrow">Non-functional</div>
          {prd.nonFunctional.map((n, idx) => (
            <div className="row" key={`${n.id}-${idx}`}>
              <span>{n.text}</span>
              {n.metric ? <span className="tag">{n.metric}</span> : null}
            </div>
          ))}
        </>
      ) : null}
      {prd.risks && prd.risks.length ? (
        <>
          <div className="eyebrow">Risks</div>
          {prd.risks.map((r, idx) => (
            <div className="row" key={`${r.id}-${idx}`}>
              <span className={`pill st-${r.severity === 'high' ? 'danger' : r.severity === 'low' ? 'done' : 'warn'}`}>{r.severity}</span>
              <div className="grow">
                <span>{r.text}</span>
                {r.mitigation ? <div className="muted" style={{ fontSize: 12 }}>→ {r.mitigation}</div> : null}
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** Roster agent yang dibuat user (registry) — identitas persisten per workspace. */
function AgentsCard({ list }: { list: Ach[] }) {
  const agents = useAgents();
  return (
    <div className="card col">
      <h2>Agents</h2>
      {agents.length ? agents.map((ag) => {
        const held = list.find((a) => a.claim?.ag === ag.id);
        return (
          <div className="qrow pn in" key={ag.id}>
            <span className="avatar"><AgentFace ag={ag.id} /></span>
            <div className="grow">
              <b>{ag.name}</b>{' '}
              <span className="faint mono" style={{ fontSize: 11 }}>{ag.id}</span>
              <div className="muted" style={{ fontSize: 12 }}>
                {ag.providerId} · {ag.model} · {ag.memory.length} memories{held ? ` · ${held.id}` : ''}
              </div>
            </div>
            <span className={`pill st-${held ? 'claimed' : 'muted'}`}>{held ? 'working' : 'idle'}</span>
          </div>
        );
      }) : (
        <div className="empty">No agents yet — create one in the Create agent panel (sidebar), then dispatch quests from a quest drawer.</div>
      )}
    </div>
  );
}

function PartyCard({ list, presence }: { list: Ach[]; presence: Array<{ sessionId: string; model: string | null; label: string; isSelf?: boolean; agentId?: string | null }> }) {
  const s = useRsat();
  return (
    <div className="card col">
      <h2>Party</h2>
      {presence.length ? presence.map((p) => {
        const held = list.find((a) => a.claim && a.claim.sid === p.sessionId);
        return (
          <div className="qrow pn in" key={p.sessionId}>
            <span className="avatar">
              <Face by={p.isSelf ? 'U' : p.label} ag={p.agentId} />
            </span>
            <div className="grow">
              <b>{p.isSelf ? `${s.displayName} (user)` : p.label}</b>{' '}
              <span className="faint mono" style={{ fontSize: 11 }}>
                {p.sessionId.slice(0, 8)}
              </span>
              <div className="muted" style={{ fontSize: 12 }}>
                {p.isSelf ? 'you' : p.model ?? 'session'}{held ? ` · ${held.id}` : ''}
                {held?.claim ? (
                  <>
                    {' '}
                    <Hearts beat={held.claim.beat} />
                  </>
                ) : null}
              </div>
            </div>
            <span className="pill st-ok">running</span>
          </div>
        );
      }) : (
        <div className="empty">No live sessions. {s.displayName} is working solo.</div>
      )}
    </div>
  );
}

export default function Basecamp({ onOpen }: { onOpen: (id: string) => void }) {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);
  const [editing, setEditing] = useState(false);
  const list = s.achs;
  const xp = list.filter((a) => a.state === 'done').reduce((x, a) => x + a.pts, 0);
  const all = list.reduce((x, a) => x + a.pts, 0);
  const act = list.filter((a) => ['claimed', 'in_progress', 'review'].includes(a.state));
  const next = list.filter((a) => eff(list, a) === 'available');

  const onExport = () => {
    void (async () => {
      try {
        const r = (await rpc('exportDoc', {})) as { content?: string; name?: string } | null;
        if (!r?.content) return;
        const el = document.createElement('a');
        el.href = URL.createObjectURL(new Blob([r.content], { type: 'application/json' }));
        el.download = r.name ?? 'export.rsprd.json';
        el.click();
        URL.revokeObjectURL(el.href);
        toast('ok', 'PRD exported', 'Saved to .moriko/rsat/exports/ and downloaded.');
      } catch (err) {
        toast('error', 'Export failed', err instanceof Error ? err.message : 'RPC error.');
      }
    })();
  };

  if (!s.prd || editing) {
    return (
      <PrdForm
        lang={lang}
        prd={s.prd}
        onSave={(p) => {
          const fields = {
            title: p.title, summary: p.summary, inc: p.inc, exc: p.exc, cons: p.cons, goals: p.goals,
            architecture: p.architecture, modules: p.modules, milestones: p.milestones,
            nonFunctional: p.nonFunctional, risks: p.risks, technicalDecisions: p.technicalDecisions,
          };
          if (s.prd) updatePrd(fields);
          else createPrd(fields, lang);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <>
      <Hero prd={s.prd} lang={lang} xp={xp} all={all} onExport={onExport} onEdit={() => setEditing(true)} />
      <Stats list={list} lang={lang} />
      <div className="two">
        <div className="col" style={{ gap: 22 }}>
          <div className="card col">
            <h2>{t('activeNow')}</h2>
            {act.length ? act.map((a) => <Qrow key={a.id} a={a} list={list} lang={lang} onOpen={onOpen} />) : <div className="empty">Nothing in progress.</div>}
          </div>
          <div className="card col">
            <h2>{t('nextUp')}</h2>
            {next.length ? next.map((a) => <Qrow key={a.id} a={a} list={list} lang={lang} onOpen={onOpen} />) : <div className="empty">No quest is available right now.</div>}
          </div>
        </div>
        <div className="col" style={{ gap: 22 }}>
          <ScopeCard prd={s.prd} lang={lang} />
          <ArchCard prd={s.prd} list={list} />
          <PartyCard list={list} presence={s.presence} />
          <AgentsCard list={list} />
        </div>
      </div>
    </>
  );
}
