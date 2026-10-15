/**
 * RSA/T Inventory — port 1:1 dari design/split/rsat-panel-inventory.html.
 * Header .toolbar (h2 ledger + chip filter op ber-hitung) + tabel .pn.tblw
 * (kolom ikon op, File/from, Summary/awaiting, Quest, By, Time).
 * Kini ledger dari store bersama (useRsat) — setiap file quest tampil di sini
 * lengkap dengan summary agent (RSAT.txt butir 6.5).
 */
import { useState } from 'react';
import { tr } from './shared.tsx';
import { Ic } from './icon.tsx';
import { ttlMs, useRsat, who, type FileRow } from './store.tsx';

const OP: Record<string, [string, string]> = {
  add: ['file-plus', 'add'],
  mod: ['file-edit', ''],
  del: ['file-minus', 'del'],
  ref: ['refactor', 'ref'],
  ren: ['rename', 'ren'],
};

const KINDS = ['all', 'add', 'mod', 'del', 'ref', 'ren'];

export default function Inventory({ onOpen }: { onOpen: (id: string) => void }) {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);
  const [opF, setOpF] = useState('all');

  const rows: Array<{ id: string; f: FileRow }> = s.achs.flatMap((a) => a.files.map((f) => ({ id: a.id, f })));
  const n = (k: string) => (k === 'all' ? rows.length : rows.filter((r) => r.f.op === k).length);
  const list = rows.filter((r) => opF === 'all' || r.f.op === opF);

  return (
    <>
      <div className="toolbar">
        <h2 className="grow">
          {t('files')} <span className="muted">· file ledger · {rows.length}</span>
        </h2>
        {KINDS.map((k) => (
          <button key={k} className="chip" type="button" aria-pressed={opF === k} onClick={() => setOpF(k)}>
            {k === 'all' ? t('all') : t(`op_${k}`)} {n(k)}
          </button>
        ))}
      </div>
      <div className="pn tblw">
        {list.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th></th>
                <th>File</th>
                <th>Summary</th>
                <th>Quest</th>
                <th>By</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {list.map(({ id, f }, i) => (
                <tr key={`${id}:${f.p}:${i}`}>
                  <td>
                    <span className={`op ${OP[f.op]?.[1] ?? ''}`}>
                      <Ic name={OP[f.op]?.[0] ?? 'file-edit'} />
                    </span>
                  </td>
                  <td>
                    <span className="mono">{f.p}</span>
                    {f.from ? (
                      <div className="faint mono" style={{ fontSize: 11 }}>
                        from {f.from}
                      </div>
                    ) : null}
                  </td>
                  <td>{f.s ? f.s : <span className="pill st-warn">⋯ {t('awaiting')}</span>}</td>
                  <td>
                    <button className="btn sm ghost" type="button" onClick={() => onOpen(id)}>{id}</button>
                  </td>
                  <td>{who(f.by)}</td>
                  <td className="muted">{new Date(Date.parse(f.at) || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty" style={{ border: 0 }}>
            No file changes recorded.
          </div>
        )}
      </div>
    </>
  );
}
