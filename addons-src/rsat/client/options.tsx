/**
 * RSA/T Options — port 1:1 dari design/split/rsat-panel-options.html.
 * Versi backend: guard mode & TTL via rpc (persist), export via rpc exportDoc,
 * import via rpc importDoc (dry-run + apply di server), danger zone rpc deletePrd.
 * confirm() browser DILARANG → konfirmasi hapus PRD inline two-step.
 */
import { useRef, useState, type ReactNode } from 'react';
import { setToastsEnabled, toast } from './toast.tsx';
import { tr } from './shared.tsx';
import { Ic } from './icon.tsx';
import { rpc } from './shared.tsx';
import { deletePrd, importDoc, setGuard, setIlQuality, setLang, setTtl, useRsat } from './store.tsx';

/** seg-ctl desain (baris 117): grup tombol bertekanan. */
function Seg({ vals, cur, onPick, label }: { vals: Array<[string, string]>; cur: string; onPick: (v: string) => void; label: string }) {
  return (
    <span className="seg-ctl" role="group" aria-label={label}>
      {vals.map(([v, n]) => (
        <button key={v} type="button" aria-pressed={cur === v} onClick={() => onPick(v)}>
          {n}
        </button>
      ))}
    </span>
  );
}

function Sw({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return <button className="switch" type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle} />;
}

/** Baris .set desain (baris 80): label kiri + kontrol kanan. */
function SetRow({ label, desc, note, control }: { label: ReactNode; desc: string; note?: string; control: ReactNode }) {
  return (
    <div className="set">
      <div className="grow">
        <b>{label}</b>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {desc}
        </div>
        {note ? (
          <div className="faint mono" style={{ fontSize: 12, marginTop: 4 }}>
            {note}
          </div>
        ) : null}
      </div>
      {control}
    </div>
  );
}

/** Ekspor PRD: rpc exportDoc (server simpan ke .moriko/rsat/exports/) + unduhan. */
function exportPrd() {
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
}

/** Kartu Danger zone (desain baris 126) — armed = konfirmasi inline (ganti confirm() browser). */
function DangerCard({ lang, hasPrd }: { lang: string; hasPrd: boolean }) {
  const t = (k: string) => tr(lang, k);
  const [armed, setArmed] = useState(false);
  const onDelete = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    deletePrd();
    setArmed(false);
  };
  return (
    <div className="card">
      <h3 style={{ color: 'rgb(var(--c-danger))' }}>{t('danger')}</h3>
      <div className="set">
        <div className="grow">
          <b>{t('delPrd')}</b>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Removes the PRD, achievements and ledger from this project.
          </div>
        </div>
        {armed ? (
          <div className="row">
            <button className="btn dng" type="button" onClick={onDelete}>
              Yes, delete
            </button>
            <button className="btn" type="button" onClick={() => setArmed(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn dng" type="button" disabled={!hasPrd} onClick={onDelete}>
            <Ic name="trash" sm /> {t('delPrd')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Options() {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);
  const [toasts, setToasts] = useState(true);
  const [sound, setSound] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // TTL efektif dari server (claimTtlSec) — seg pilihan 5/15/30 menit.
  const ttl = String(Math.max(1, Math.round(s.claimTtlSec / 60)));

  return (
    <>
      <h2>{t('settings')}</h2>
      <div className="card">
        <SetRow
          label={t('language')}
          desc="English is the default. Other languages need your consent."
          control={<Seg vals={[['en', 'English'], ['id', 'Bahasa Indonesia']]} cur={lang} onPick={setLang} label={t('language')} />}
        />
        <SetRow
          label={t('guard')}
          desc="Off: no checks. Advisory: allow with a note. Strict: deny edits outside the claimed scope."
          note="Shell commands are not path-checked; the ledger still records the file changes the harness sees."
          control={<Seg vals={[['off', 'Off'], ['advisory', 'Advisory'], ['strict', 'Strict']]} cur={s.guardMode} onPick={setGuard} label={t('guard')} />}
        />
        <SetRow
          label="Graphics quality (Interlinked)"
          desc="Very Low: no glows or heavy animations — best for laggy machines. High: everything full."
          control={<Seg vals={[['verylow', 'Very Low'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]} cur={s.ilQuality || 'high'} onPick={setIlQuality} label="Graphics quality" />}
        />
        <SetRow label={t('toastsL')} desc="Warnings and denials are always shown." control={<Sw on={toasts} label={t('toastsL')} onToggle={() => { setToastsEnabled(!toasts); setToasts(!toasts); }} />} />
        <SetRow label="Sound effects" desc="8-bit blips for clicks and achievements. Off by default." control={<Sw on={sound} label="Sound effects" onToggle={() => setSound((v) => !v)} />} />
        <SetRow
          label="Heartbeat timeout"
          desc="Minutes until a claim has no hearts left and is marked stale."
          control={<Seg vals={[['5', '5'], ['15', '15'], ['30', '30']]} cur={['5', '15', '30'].includes(ttl) ? ttl : '15'} onPick={(v) => setTtl(Number(v))} label="Heartbeat timeout" />}
        />
        <SetRow
          label="Storage"
          desc=".moriko/rsat/prd.rsprd.json · RS-PRD v1"
          control={
            <>
              <button className="btn" type="button" disabled={!s.prd} onClick={() => exportPrd()}>
                <Ic name="download" sm /> {t('exportL')}
              </button>
              <input
                ref={fileRef} type="file" accept=".json,.rsprd" hidden aria-label={t('importL')}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  const rd = new FileReader();
                  rd.onload = () => { void importDoc(String(rd.result ?? '')); };
                  rd.onerror = () => toast('error', 'Import failed', 'The file could not be read.');
                  rd.readAsText(f);
                }}
              />
              <button className="btn" type="button" onClick={() => fileRef.current?.click()}>
                <Ic name="upload" sm /> {t('importL')}
              </button>
            </>
          }
        />
      </div>
      <DangerCard lang={lang} hasPrd={!!s.prd} />
    </>
  );
}
