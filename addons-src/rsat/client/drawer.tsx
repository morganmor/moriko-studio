/**
 * RSA/T Drawer (achievement detail) — port dari design/split/rsat-panel-drawer.html
 * + integrasi rsat-panel-pixel.html: markup .scrim/.drawer (baris 439-440),
 * openDrawer/renderDrawer/focus+Escape (882-952), actionsFor (928-944).
 * Versi backend: SEMUA aksi → RPC server (aktor = user); guard test memakai
 * rules engine nyata via rpc guardTest — tanpa replika lokal.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tr } from './shared.tsx';
import { toast, useNow } from './toast.tsx';
import { Spr, sa } from './sprites.tsx';
import { Ic } from './icon.tsx';
import {
  approveScope, byId, changeScope, comment, eff, guardTest, isStale, prog,
  questAction, setFileSummary, toggleAcceptance, ttlMs, useRsat, who,
  type Ach, type FileRow,
} from './store.tsx';
import { openConversation } from '@moriko/host';
import { AgentFace, dispatchQuest, useAgents, type AgentRec } from './agentstore.tsx';

const OP: Record<string, [string, string]> = {
  add: ['file-plus', 'add'], mod: ['file-edit', ''], del: ['file-minus', 'del'],
  ref: ['refactor', 'ref'], ren: ['rename', 'ren'],
};

const effScope = (a: Ach) => {
  const inc = new Set(a.scope.inc), exc = new Set(a.scope.exc);
  a.sc.forEach((s) => { if (s.approved) (s.op === 'widen' ? inc : exc).add(s.path); });
  return { inc: [...inc], exc: [...exc] };
};

function Seg({ pct, n = 10, cls = '' }: { pct: number; n?: number; cls?: string }) {
  const on = Math.round((pct / 100) * n);
  return (
    <div className={`seg ${cls}`} role="img" aria-label={`${pct}%`}>
      {Array.from({ length: n }, (_, i) => (<i key={i} className={i < on ? 'on' : undefined} />))}
    </div>
  );
}

function Medal({ a, e, sz }: { a: Ach; e: string; sz?: string }) {
  const lock = e === 'locked';
  return (
    <span className={sz ? `mw ${sz}` : 'mw'}>
      <span className={`medal t-${a.tier}${lock ? ' lock' : ''}${sz ? ` ${sz}` : ''}${e === 'available' ? ' glow' : ''}`}>
        <Spr name={lock ? 'lock' : 'ore'} style={sa(lock ? 'rgb(var(--c-rsat-locked))' : `rgb(var(--c-rsat-${a.tier}))`)} />
      </span>
      {e === 'done' ? (
        <span className="bdg"><Spr name="check" style={sa('rgb(var(--c-rsat-done))')} /></span>
      ) : ['claimed', 'in_progress', 'review', 'blocked'].includes(e) ? (
        <span className={`pip st-${e}`} />
      ) : null}
    </span>
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

const Holder = ({ a }: { a: Ach }) => {
  const now = useNow();
  return a.claim ? (
    <span className="holder">
      <Face by={a.claim.by} ag={a.claim.ag} />
      <b>{who(a.claim.by)}</b>
      <Hearts beat={a.claim.beat} />
      {isStale(a, now) ? <span className="pill st-warn">stale</span> : null}
    </span>
  ) : null;
};

function DetailTab({ a, list, lang, onAc, onOpen }: {
  a: Ach; list: Ach[]; lang: string;
  onAc: (i: number) => void; onOpen: (id: string) => void;
}) {
  const t = (k: string) => tr(lang, k);
  return (
    <>
      <p style={{ margin: 0 }}>{a.desc}</p>
      <div className="row muted" style={{ flexWrap: 'wrap', fontSize: 12.5 }}>
        {t('holder')}: {a.claim ? (<><Holder a={a} /> · {a.claim.at}</>) : t('none')}
      </div>
      <div className="col">
        <div className="eyebrow">{t('tech')}</div>
        <div className="note"><Ic name="gear" sm /><span>{a.tech}</span></div>
      </div>
      <div className="col">
        <div className="eyebrow">{t('contracts')} & {t('blastRadius')}</div>
        <div className="pn in" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="chip">PROVIDES</span>
            {(a.contracts?.provides?.length ? a.contracts.provides : [`${a.id}::PublicContract`, 'export default']).map((sym) => (
              <span className="tag in mono" key={`p:${sym}`}>{sym}</span>
            ))}
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="chip">CONSUMES</span>
            {(a.contracts?.consumes?.length ? a.contracts.consumes : ['useRsat()', 'BoardState']).map((sym) => (
              <span className="tag mono" key={`c:${sym}`}>{sym}</span>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            <Ic name="nodes" sm /> Module: <b>{a.moduleId ?? 'm01 (core)'}</b> · Downstream dependents guarded in <b>Interlinked</b>.
          </div>
        </div>
      </div>
      <div className="col">
        <div className="eyebrow">{t('accept')} · {prog(a)}%</div>
        <Seg pct={prog(a)} cls={a.state === 'done' ? 'done' : ''} />
        {a.ac.map((c, i) => (
          <div className="check" key={c.t}>
            <button
              className="cbx" type="button" role="checkbox" aria-checked={c.d} aria-label={c.t}
              onClick={() => onAc(i)}
            >
              <Spr name="check" style={sa('rgb(var(--c-rsat-done))')} />
            </button>
            <span>{c.t}</span>
          </div>
        ))}
      </div>
      <div className="col">
        <div className="eyebrow">{t('deps')}</div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {a.dep.length ? a.dep.map((d) => {
            const x = byId(list, d);
            return (
              <button className="chip" type="button" key={d} onClick={() => onOpen(d)}>
                {d}{x ? ` · ${t(`s_${eff(list, x)}`)}` : ''}
              </button>
            );
          }) : <span className="muted">None</span>}
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {a.tags.map((g) => (<span className="tag" key={g}>#{g}</span>))}
        <span className="tag">{a.kind}</span>
        <span className="tag">{a.pts} pts</span>
      </div>
    </>
  );
}

function ScopeHist({ a, lang, onApprove }: { a: Ach; lang: string; onApprove: (i: number) => void }) {
  const t = (k: string) => tr(lang, k);
  if (!a.sc.length) return null;
  return (
    <div className="col">
      {a.sc.map((s, i) => (
        <div className="gres" key={`${s.op}:${s.path}`}>
          <span className={`pill st-${s.op === 'widen' ? 'ok' : 'warn'}`}>{s.op}</span>
          <div className="grow">
            <span className="mono">{s.path}</span>
            <div className="hint">{who(s.by)} · {s.at}{s.why ? ` · ${s.why}` : ''}</div>
          </div>
          {s.approved ? (
            <span className="pill st-done">approved</span>
          ) : (
            <button className="btn sm pri" type="button" onClick={() => onApprove(i)}>
              Approve
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Guard test — rules engine nyata via rpc guardTest (tanpa write). */
function GuardTest({ a, lang, guard, gpath, setGpath, gres, onTest }: {
  a: Ach; lang: string; guard: string; gpath: string;
  setGpath: (v: string) => void; gres: { kind: string; actor: string; msg: string } | null; onTest: () => void;
}) {
  return (
    <div className="col">
      <div className="eyebrow">Guard test</div>
      <div className="row">
        <input
          className="field grow mono" value={gpath} onChange={(e) => setGpath(e.target.value)}
          placeholder="src/api/client.ts" aria-label="Path to test"
        />
        <button className="btn sm" type="button" onClick={onTest}>
          <Ic name="shield" sm /> Try edit
        </button>
      </div>
      <span className="hint">
        Checks a path against the real scope guard (no file is touched). Mode: {guard}. Quest {a.id}.
      </span>
      {gres ? (
        <div className="gres">
          <span className={`dot st-${gres.kind}`} />
          <div><b>{gres.actor}</b><div>{gres.msg}</div></div>
        </div>
      ) : null}
    </div>
  );
}

function ScopeTab(props: {
  a: Ach; lang: string; guard: string; spath: string; setSpath: (v: string) => void;
  gpath: string; setGpath: (v: string) => void;
  gres: { kind: string; actor: string; msg: string } | null;
  onWiden: (op: string) => void; onGtest: () => void; onApprove: (i: number) => void;
}) {
  const { a, lang, spath, setSpath } = props;
  const t = (k: string) => tr(lang, k);
  const sc = effScope(a);
  return (
    <>
      <div className="col">
        <div className="eyebrow">Include</div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {sc.inc.map((g) => (<span className="tag in" key={`i:${g}`}>{g}</span>))}
        </div>
        <div className="eyebrow">Exclude</div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {sc.exc.map((g) => (<span className="tag ex" key={`e:${g}`}>{g}</span>))}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="tag">max {a.scope.max} files</span>
          <span className="tag">create: {a.scope.create ? 'yes' : 'no'}</span>
          <span className="tag">delete: {a.scope.del ? 'yes' : 'no'}</span>
        </div>
      </div>
      <div className="col">
        <div className="eyebrow">Change scope</div>
        <div className="row">
          <input
            className="field grow mono" value={spath} onChange={(e) => setSpath(e.target.value)}
            placeholder="src/lib/**" aria-label="Scope path"
          />
          <button className="btn sm" type="button" onClick={() => props.onWiden('widen')}>
            <Ic name="plus" sm /> {t('widen')}
          </button>
          <button className="btn sm" type="button" onClick={() => props.onWiden('narrow')}>
            {t('narrow')}
          </button>
        </div>
        <span className="hint">
          {props.guard === 'strict'
            ? 'Applied immediately — agent requests in strict mode wait for your approval below.'
            : 'Applied immediately and written to the history.'}
        </span>
        <ScopeHist a={a} lang={lang} onApprove={props.onApprove} />
      </div>
      <GuardTest a={a} lang={lang} guard={props.guard} gpath={props.gpath} setGpath={props.setGpath} gres={props.gres} onTest={props.onGtest} />
    </>
  );
}

function CommentsTab({ a, lang, draft, setDraft, onSend }: {
  a: Ach; lang: string; draft: string; setDraft: (v: string) => void; onSend: () => void;
}) {
  const t = (k: string) => tr(lang, k);
  return (
    <>
      <div className="col">
        {a.cm.length ? a.cm.map((c, i) => (
          <div className={`cmt ${c.by === 'U' ? 'user' : 'agent'}`} key={`${c.at}:${i}`}>
            <span className="avatar"><Face by={c.by} /></span>
            <div className="bub">
              <div className="row" style={{ gap: 6 }}>
                <b style={{ fontSize: 12.5 }}>{who(c.by)}</b>
                <span className="muted" style={{ fontSize: 11 }}>{c.at}</span>
              </div>
              <div>{c.t}</div>
            </div>
          </div>
        )) : <div className="empty">No comments yet.</div>}
      </div>
      <div className="col">
        <textarea
          className="field" value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={t('comment')} aria-label={t('comment')}
        />
        <div className="row">
          <span className="hint grow">Posted as {who('U')}</span>
          <button className="btn pri sm" type="button" onClick={onSend}>
            <Ic name="send" sm /> {t('send')}
          </button>
        </div>
      </div>
    </>
  );
}

function FileRowView({ f, i, lang, onSave }: {
  f: FileRow; i: number; lang: string; onSave: (i: number, v: string) => void;
}) {
  const t = (k: string) => tr(lang, k);
  const [v, setV] = useState('');
  return (
    <div className={`lrow${f.pending ? ' pending' : ''}`}>
      <span className={`op ${OP[f.op][1]}`}><Ic name={OP[f.op][0]} sm /></span>
      <div className="grow">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <b>{t(`op_${f.op}`)}</b>
          <span className="mono" style={{ fontSize: 12 }}>{f.p}</span>
        </div>
        {f.from ? <div className="muted mono" style={{ fontSize: 11 }}>from {f.from}</div> : null}
        {f.pending ? (
          <div className="row" style={{ marginTop: 6 }}>
            <input
              className="field grow" value={v} onChange={(e) => setV(e.target.value)}
              placeholder="One-line summary…" aria-label={`Summary for ${f.p}`}
            />
            <button className="btn sm pri" type="button" onClick={() => onSave(i, v)}>
              Save
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 13 }}>{f.s}</div>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{who(f.by)} · {f.at}</div>
      </div>
    </div>
  );
}

function FilesTab({ a, lang, onSave }: { a: Ach; lang: string; onSave: (i: number, v: string) => void }) {
  return (
    <>
      <div className="ledger">
        {a.files.length ? a.files.map((f, i) => (
          <FileRowView key={`${f.p}:${i}`} f={f} i={i} lang={lang} onSave={onSave} />
        )) : <div className="empty">No file changes recorded yet.</div>}
      </div>
      <span className="hint">Entries are recorded automatically by the harness. The agent adds the one-line summary.</span>
    </>
  );
}

/** Tombol aksi per state — board dijalankan sebagai USER (aktor RPC). */
function actionButtons(
  a: Ach, e: string, mine: boolean, t: (k: string) => string,
  btn: (name: string, label: string, cls: string, ico: string, dis?: boolean) => ReactNode,
): ReactNode[] {
  const out: ReactNode[] = [];
  if (e === 'available') out.push(btn('claim', t('claim'), 'pri', 'flag'));
  if (['claimed', 'in_progress'].includes(a.state)) {
    if (mine) {
      out.push(btn('beat', 'Progress', '', 'activity'));
      out.push(btn('submit', t('approve'), 'pri', 'send'));
      out.push(btn('release', t('release'), '', 'x'));
    } else {
      out.push(btn('release', isStale(a, Date.now()) ? t('takeover') : t('release'), '', 'x'));
    }
  }
  if (a.state === 'review') {
    out.push(btn('approve', t('approve'), 'pri', 'check'));
    out.push(btn('reopen', t('reopen'), '', 'refactor'));
  }
  if (a.state === 'dropped') out.push(btn('restore', 'Restore', '', 'refactor'));
  if (!['done', 'dropped'].includes(a.state)) out.push(btn('drop', t('drop'), 'dng', 'trash'));
  return out;
}

/** Hint kontekstual di atas action bar. */
function actionHint(a: Ach, e: string, mine: boolean, t: (k: string) => string, now: number): string {
  if (e === 'available') return 'Claim it to work on it — while you hold it the guard fences its scope.';
  if (!mine && a.claim && ['claimed', 'in_progress'].includes(a.state))
    return `Held by ${who(a.claim.by)}${isStale(a, now) ? ' — the claim went stale, you can take it over.' : '. Choose another quest to avoid a collision.'}`;
  if (a.state === 'review') return 'Accept to award the points, or send it back with changes.';
  return '';
}

function ActionsRow({ a, list, lang, notice, onAct }: {
  a: Ach; list: Ach[]; lang: string; notice: string | null; onAct: (name: string) => void;
}) {
  const t = (k: string) => tr(lang, k);
  const e = eff(list, a);
  const mine = !!a.claim && a.claim.by === 'U';
  const btn = (name: string, label: string, cls: string, ico: string, dis = false) => (
    <button className={`btn ${cls}`} type="button" disabled={dis} onClick={() => onAct(name)}>
      <Ic name={ico} sm /> {label}
    </button>
  );
  const out = actionButtons(a, e, mine, t, btn);
  const now = useNow();
  const hint = actionHint(a, e, mine, t, now);

  return (
    <>
      {notice ? (
        <div className="gres" style={{ width: '100%' }}>
          <span className="dot st-warn" />
          <span>{notice}</span>
        </div>
      ) : null}
      {hint ? (
        <div className="gres" style={{ width: '100%' }}>
          <span className="dot st-claimed" />
          <span>{hint}</span>
        </div>
      ) : null}
      {out}
      {e === 'available' ? <DispatchBlock a={a} /> : null}
    </>
  );
}

/** Pilih agent dari roster → dispatchQuest → host membuat sesi chat baru. */
function DispatchBlock({ a }: { a: Ach }) {
  const agents = useAgents();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rebind, setRebind] = useState<string | null>(null);
  const fire = (ag: AgentRec) => {
    setBusy(ag.id);
    dispatchQuest(ag, a);
    setBusy(null);
    setRebind(null);
    setOpen(false);
  };
  return (
    <div className="col" style={{ width: '100%' }}>
      <button
        className="btn" type="button" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Ic name="send" sm /> Dispatch to agent…
      </button>
      {open ? (
        agents.length ? (
          <div className="col" style={{ gap: 6 }}>
            {agents.map((ag) => {
              const taken = Boolean(ag.activeSessionId);
              return (
                <button
                  key={ag.id} className="qrow pn in" type="button"
                  disabled={busy !== null}
                  onClick={() => (taken && rebind !== ag.id ? setRebind(ag.id) : fire(ag))}
                >
                  <span className="avatar"><AgentFace ag={ag.id} /></span>
                  <span className="grow">
                    <b>{ag.name}</b>
                    <div className="muted" style={{ fontSize: 11 }}>{ag.providerId} · {ag.model}</div>
                  </span>
                  {busy === ag.id ? (
                    <span className="pill st-muted">…</span>
                  ) : taken ? (
                    <span
                      className={`pill ${rebind === ag.id ? 'st-warn' : 'st-claimed jump'}`}
                      role={rebind === ag.id ? undefined : 'button'}
                      tabIndex={rebind === ag.id ? undefined : 0}
                      onClick={rebind === ag.id ? undefined : (e) => {
                        e.stopPropagation();
                        if (ag.activeSessionId) openConversation(ag.activeSessionId);
                      }}
                      onKeyDown={rebind === ag.id ? undefined : (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          if (ag.activeSessionId) openConversation(ag.activeSessionId);
                        }
                      }}
                    >
                      {rebind === ag.id ? 'Rebind?' : 'in session ↗'}
                    </span>
                  ) : (
                    <Ic name="send" sm />
                  )}
                </button>
              );
            })}
            <span className="hint">
              A new conversation opens with this agent — its claims, guard scope and memory bind to this identity.
              {agents.some((ag) => ag.activeSessionId)
                ? ' "in session ↗" = click to open that session; dispatching again rebinds the agent (the old session is released).'
                : ''}
            </span>
          </div>
        ) : (
          <span className="hint">No agents yet — create one in the Create agent panel (sidebar).</span>
        )
      ) : null}
    </div>
  );
}

type Gres = { kind: string; actor: string; msg: string } | null;

/** Efek fokus: capture opener saat buka, restore saat tutup, Escape menutup (pixel 883–891, 347). */
function useDrawerFocus(
  sel: string | null,
  onClose: () => void,
  drawerRef: { current: HTMLElement | null },
  closeRef: { current: HTMLButtonElement | null },
  openerRef: { current: HTMLElement | null },
  reset: () => void,
) {
  useEffect(() => {
    if (!sel) {
      const o = openerRef.current;
      openerRef.current = null;
      if (o && o.isConnected && !drawerRef.current?.contains(o)) o.focus({ preventScroll: true });
      return;
    }
    const cur = document.activeElement as HTMLElement | null;
    if (cur && !drawerRef.current?.contains(cur)) openerRef.current = cur;
    reset();
    const tm = setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(tm);
  }, [sel]);
  useEffect(() => {
    if (!sel) return undefined;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [sel, onClose]);
}

/** Kepala drawer: medal lg + id/pill + judul + tombol close. */
function DrawerHead({ a, e, t, onClose, closeRef }: {
  a: Ach; e: string; t: (k: string) => string;
  onClose: () => void; closeRef: { current: HTMLButtonElement | null };
}) {
  return (
    <div className="d-head">
      <Medal a={a} e={e} sz="lg" />
      <div className="grow">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="mono muted">{a.id}</span>
          <span className={`pill st-${e}`}>{t(`s_${e}`)}</span>
          <span className="pill st-muted">{a.tier}</span>
        </div>
        <h2 style={{ marginTop: 8, textTransform: 'none', fontSize: 16 }}>{a.title}</h2>
      </div>
      <button className="icon-btn" type="button" aria-label="Close" onClick={onClose} ref={closeRef}>
        <Ic name="x" />
      </button>
    </div>
  );
}

/** Tab bar drawer (Detail/Scope/Comments/Files). */
function DrawerTabs({ tabs, tab, setTab }: {
  tabs: Array<[string, string]>; tab: string; setTab: (v: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, n]) => (
        <button className="tab" type="button" role="tab" key={k} aria-selected={tab === k} onClick={() => setTab(k)}>
          {n}
        </button>
      ))}
    </div>
  );
}

/** Isi body per tab (Detail/Scope/Comments/Files). */
function DrawerBody(props: {
  a: Ach; tab: string; ach: Ach[]; lang: string; guard: string;
  spath: string; setSpath: (v: string) => void; gpath: string; setGpath: (v: string) => void; gres: Gres;
  draft: string; setDraft: (v: string) => void;
  run: (name: string, i?: number) => void; saveFile: (i: number, v: string) => void; onOpen: (id: string) => void;
}) {
  const { a, tab, ach, lang, guard, run } = props;
  return (
    <div className="d-body">
      {tab === 'detail' ? (
        <DetailTab a={a} list={ach} lang={lang} onAc={(i) => run('ac', i)} onOpen={props.onOpen} />
      ) : tab === 'scope' ? (
        <ScopeTab
          a={a} lang={lang} guard={guard} spath={props.spath} setSpath={props.setSpath}
          gpath={props.gpath} setGpath={props.setGpath} gres={props.gres}
          onWiden={(op) => run(op)} onGtest={() => run('gtest')} onApprove={(i) => run('sapprove', i)}
        />
      ) : tab === 'comments' ? (
        <CommentsTab a={a} lang={lang} draft={props.draft} setDraft={props.setDraft} onSend={() => run('send')} />
      ) : (
        <FilesTab a={a} lang={lang} onSave={props.saveFile} />
      )}
    </div>
  );
}

/** Label tab + hitungan comments/files (pixel renderDrawer baris 948). */
const buildTabs = (a: Ach | null, t: (k: string) => string): Array<[string, string]> =>
  a
    ? [['detail', t('detail')], ['scope', t('scope')], ['comments', `${t('comments')} ${a.cm.length}`], ['files', `${t('filesT')} ${a.files.length}`]]
    : [];

export default function Drawer({ sel, onClose, onOpen }: {
  sel: string | null; onClose: () => void; onOpen: (id: string) => void;
}) {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);
  const guard = s.guardMode;
  const ach = s.achs;
  const [tab, setTab] = useState('detail');
  const [spath, setSpath] = useState('');
  const [gpath, setGpath] = useState('');
  const [draft, setDraft] = useState('');
  const [gres, setGres] = useState<Gres>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const a = sel ? byId(ach, sel) ?? null : null;

  const reset = () => {
    setTab('detail');
    setSpath('');
    setGpath('');
    setDraft('');
    setGres(null);
    setNotice(null);
  };
  useDrawerFocus(sel, onClose, drawerRef, closeRef, openerRef, reset);

  /** Semua aksi drawer → RPC server (aktor user); store me-refresh penuh. */
  const run = (name: string, i?: number) => {
    if (!a) return;
    setNotice(null);
    switch (name) {
      case 'ac': {
        const c = a.ac[i ?? 0];
        if (c) toggleAcceptance(a.id, i ?? 0, !c.d);
        break;
      }
      case 'claim':
        questAction('claim', a.id);
        toast('ach', `${a.id} · ${a.title}`, `${who('U')} · ${a.pts} pts`, { tier: a.tier });
        break;
      case 'beat':
        questAction('beat', a.id);
        break;
      case 'submit': {
        const open = a.ac.filter((cj) => !cj.d).length;
        if (open) {
          setNotice(`${open} criteria still open — tick them or explain why in a comment.`);
          toast('warn', `${a.id} blocked`, `${open} criteria still open.`);
        } else {
          questAction('submit', a.id);
          toast('ok', `${a.id} done`, `${a.pts} pts awarded to ${who('U')}`);
        }
        break;
      }
      case 'approve':
        questAction('approve', a.id);
        break;
      case 'reopen':
        questAction('reopen', a.id);
        break;
      case 'release':
        questAction('release', a.id);
        break;
      case 'restore':
        questAction('restore', a.id);
        break;
      case 'drop':
        questAction('drop', a.id);
        break;
      case 'widen':
      case 'narrow': {
        const p = spath.trim();
        if (!p) break;
        setSpath('');
        changeScope(a.id, name, [p], 'changed from the board');
        break;
      }
      case 'sapprove':
        if (typeof i === 'number') approveScope(a.id, i);
        break;
      case 'gtest': {
        const p = gpath.trim();
        if (!p) {
          setGres({ kind: 'warn', actor: who('U'), msg: 'Enter a path to test. Example: src/api/client.ts' });
          break;
        }
        void guardTest(a.id, p).then((r) => {
          if (r) {
            setGres({
              kind: r.ok ? 'ok' : 'danger', actor: who('U'),
              msg: r.ok ? r.reason : `${r.reason}${r.holder ? ` (holder: ${r.holder})` : ''}`,
            });
          }
        });
        break;
      }
      case 'send': {
        const d = draft.trim();
        if (!d) break;
        setDraft('');
        comment(a.id, d);
        break;
      }
    }
  };
  const saveFile = (i: number, v: string) => {
    const f = a?.files[i];
    if (f) setFileSummary(a.id, f.p, v.trim() || '—');
  };
  const tabs = buildTabs(a, t);

  return (
    <div className={`dwrap${sel ? ' on' : ''}`}>
      <div className={`scrim${sel ? ' on' : ''}`} onClick={onClose} />
      <aside
        className={`drawer${sel ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Achievement detail"
        ref={drawerRef}
        {...(sel ? {} : { inert: '' })}
      >
        {a ? (
          <>
            <DrawerHead a={a} e={eff(ach, a)} t={t} onClose={onClose} closeRef={closeRef} />
            <DrawerTabs tabs={tabs} tab={tab} setTab={setTab} />
            <DrawerBody
              a={a} tab={tab} ach={ach} lang={lang} guard={guard}
              spath={spath} setSpath={setSpath} gpath={gpath} setGpath={setGpath} gres={gres}
              draft={draft} setDraft={setDraft} run={run} saveFile={saveFile} onOpen={onOpen}
            />
            <div className="d-act">
              <ActionsRow a={a} list={ach} lang={lang} notice={notice} onAct={(n) => run(n)} />
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
