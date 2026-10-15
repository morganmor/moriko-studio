/**
 * RSA/T dock — port 1:1 dari design/split/rsat-panel-dock.html.
 * aside.dock = 3 dock-card: status PRD (+seg done), Live sessions (presence
 * server), Latest feed. Semua dari store bersama (useRsat) — data backend.
 */
import { Spr, sa } from './sprites.tsx';
import { Ic } from './icon.tsx';
import { AgentFace } from './agentstore.tsx';
import { eff, useRsat, who, type Ach } from './store.tsx';
/** 5 hati: i<n terisi (danger), sisanya .off (locked). */
function Hearts({ n }: { n: number }) {
  return (
    <span className="hearts" role="img" aria-label="Heartbeat">
      {Array.from({ length: 5 }, (_, i) => (
        <Spr key={i} name="heart" cls={i < n ? '' : 'off'} style={sa(i < n ? 'rgb(var(--c-danger))' : 'rgb(var(--c-rsat-locked))')} />
      ))}
    </span>
  );
}

/** Wajah holder: logo agent custom bila ada (AgentFace), selain itu sprite. */
function Face({ by, ag }: { by: string; ag?: string | null }) {
  return <AgentFace by={by} ag={ag} />;
}

function SegDone({ pct, n }: { pct: number; n: number }) {
  const on = Math.round((pct / 100) * n);
  return (
    <div className="seg done" role="img" aria-label={`${Math.round(pct)}%`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < on ? 'on' : undefined} />
      ))}
    </div>
  );
}

const hh = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function Dock({ open = true, dockRef }: { open?: boolean; dockRef?: React.RefObject<HTMLElement | null> }) {
  const s = useRsat();
  const list = s.achs;
  const prd = s.prd;
  const total = list.length || 1;
  const done = list.filter((a) => a.state === 'done').length;
  const avail = list.filter((a) => eff(list, a) === 'available').length;
  const tone = prd?.status === 'running' ? 'ok' : prd?.status === 'paused' ? 'warn' : 'muted';
  const feed = s.feed.slice(-4).reverse();

  return (
    <aside ref={dockRef} className="dock" data-open={open} aria-label="RSA/T dock">
      <div className="dock-card col">
        <div className="row">
          <span className="ag-ic"><Spr name="gem" style={sa('rgb(var(--c-rsat-gold))')} /></span>
          <div className="grow">
            <b>RSA/T</b>
            <div className="muted" style={{ fontSize: 12 }}>{prd ? prd.title : 'No PRD'}</div>
          </div>
          <span className={`pill st-${tone}`}>{prd ? prd.status : '—'}</span>
        </div>
        <SegDone pct={(done / total) * 100} n={12} />
        <div className="row muted" style={{ fontSize: 12 }}>
          <span>{done}/{list.length} done</span>
          <span className="grow" />
          <span>{avail} available</span>
        </div>
      </div>
      <div className="dock-card col">
        <div className="eyebrow">Live sessions</div>
        {s.presence.length === 0 ? (
          <span className="muted">No live sessions</span>
        ) : (
          s.presence.map((p) => {
            const h = list.find((a: Ach) => a.claim && a.claim.sid === p.sessionId);
            return (
              <div className="row" key={p.sessionId}>
                <Face by={p.isSelf ? 'U' : p.label} ag={p.agentId} />
                <span className="grow trunc">{p.isSelf ? who('U') : p.label}</span>
                {h ? <Hearts n={3} /> : null}
                <span className="mono muted" style={{ fontSize: 11 }}>{h ? h.id : '—'}</span>
              </div>
            );
          })
        )}
      </div>
      <div className="dock-card col">
        <div className="eyebrow">Latest feed</div>
        {feed.length === 0 ? (
          <span className="muted">No activity yet</span>
        ) : (
          feed.map((f, i) => (
            <div className="row" key={`${f.at}:${i}`} style={{ alignItems: 'flex-start', gap: 8 }}>
              <span className="fi" style={{ color: 'rgb(var(--c-accent))', marginTop: 2 }}><Ic name={f.ic} sm /></span>
              <div className="grow">
                <div style={{ fontSize: 12 }}>{f.text.replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1')}</div>
                <div className="muted" style={{ fontSize: 11 }}>{hh(f.at)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
