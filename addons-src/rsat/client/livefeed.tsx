/**
 * RSA/T Live feed — port 1:1 dari design/split/rsat-panel-live-feed.html.
 * Dua kolom: .chat aria-live (baris .fe + animasi fin) · kartu injD + Heartbeat.
 * Kini feed dari store bersama (useRsat) — setiap aksi (claim/done/import/…)
 * tercatat real time (RSAT.txt butir 6.3).
 */
import { tr } from './shared.tsx';
import { Ic } from './icon.tsx';
import { ttlMs, useRsat } from './store.tsx';

const hh = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Teks feed: `*bold*` dan `mono` di-highlight. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*]+\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('*') && p.endsWith('*') ? (
          <b key={i}>{p.slice(1, -1)}</b>
        ) : p.startsWith('`') && p.endsWith('`') ? (
          <span className="mono" key={i}>{p.slice(1, -1)}</span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function LiveFeed() {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);
  const feed = s.feed;
  const inj = s.injected;
  return (
    <div className="two">
      <div className="col">
        <h2>{t('activity')}</h2>
        <div className="chat" aria-live="polite">
          {feed.length ? (
            feed.map((f, i) => (
              <div className="fe" key={`${f.at}:${i}`}>
                <span className="ts">{`<${hh(f.at)}>`}</span>
                <span className="fi">
                  <Ic name={f.ic} />
                </span>
                <div className="grow">
                  <RichText text={f.text} />
                </div>
              </div>
            ))
          ) : (
            <div className="empty">No activity yet.</div>
          )}
        </div>
      </div>
      <div className="col" style={{ gap: 22 }}>
        <div className="card col">
          <h2>{t('injD')}</h2>
          {inj ? (
            <div className="gres">
              <span className="dot st-claimed" />
              <div>
                <div className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {inj.text}
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  Delivered to {inj.n} active sessions at {hh(inj.at)} · visible to the user as a harness notice
                </div>
              </div>
            </div>
          ) : (
            <div className="empty">No notices injected yet.</div>
          )}
        </div>
        <div className="card col">
          <h2>Heartbeat</h2>
          <p className="muted" style={{ margin: 0 }}>
            Each claim shows 5 hearts. They drain over the configured heartbeat timeout ({Math.round(ttlMs() / 60000)} min); with no hearts left the claim is marked{' '}
            <span className="pill st-warn">{t('stale')}</span> and the user can take it over.
          </p>
        </div>
      </div>
    </div>
  );
}
