/**
 * Mococraft panel — Design DNA picker (Foundry) + Slop Radar (auditor)
 * + macrostructure library (Asymmetry). Lives in the sidebar.
 */
import { useEffect, useState } from 'react';
import { invoke, useAddonBus, notify } from '@moriko/host';

type Dna = {
  id: string; name: string; tagline: string;
  displayFont: string; bodyFont: string;
  palette: Record<string, string>;
  macrostructures: string[]; antiTells: string[];
};
type ScanRow = {
  file: string; verdict: string; slopIndex: number; hits: number;
  radar: Record<string, number>;
};
type State = {
  activeDna: string; library: Dna[];
  macros: Array<{ id: string; name: string; sketch: string }>;
  scans: ScanRow[]; gateMode: string;
};

const VERDICT_COLOR: Record<string, string> = {
  clean: 'var(--c-ok, #3a9a5c)',
  watch: 'var(--c-warn, #c98a2b)',
  slop: 'var(--c-bad, #c94f4f)',
};

export default function Panel() {
  const [state, setState] = useState<State | null>(null);
  const bus = useAddonBus('mococraft.changed');

  const refresh = async () => {
    try { setState(await invoke<State>('mococraft', 'state', {})); } catch { /* silent */ }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { void refresh(); }, [bus]);

  const lockDna = async (id: string) => {
    try {
      await invoke('mococraft', 'setDna', { id });
      notify(`Design DNA locked: ${id}`, 'ok');
      void refresh();
    } catch (e) { notify(String(e), 'bad'); }
  };

  if (!state) return <div className="moco-root">Loading Mococraft…</div>;
  const active = state.library.find((d) => d.id === state.activeDna);

  return (
    <div className="moco-root">
      <h3 className="moco-h">Mococraft · Craft Lock</h3>
      <p className="moco-sub">Gate: <b>{state.gateMode}</b> · {active ? `DNA: ${active.name}` : 'No Design DNA locked'}</p>

      <div className="moco-dna-grid">
        {state.library.map((d) => (
          <button
            key={d.id}
            className={`moco-dna-card ${d.id === state.activeDna ? 'is-active' : ''}`}
            onClick={() => lockDna(d.id)}
            title={d.tagline}
          >
            <span className="moco-dna-swatch">
              {['--moco-canvas', '--moco-ink', '--moco-accent', '--moco-hairline'].map((k) => (
                <i key={k} style={{ background: d.palette[k] }} />
              ))}
            </span>
            <b>{d.name}</b>
            <small>{d.tagline}</small>
          </button>
        ))}
      </div>

      {active && (
        <div className="moco-active">
          <div><b>Display</b> {active.displayFont}</div>
          <div><b>Body</b> {active.bodyFont}</div>
          <div><b>Allowed</b> {active.macrostructures.join(' · ')}</div>
          <div className="moco-bans"><b>Bans</b> {active.antiTells.join(' · ')}</div>
        </div>
      )}

      <h3 className="moco-h">Slop Radar</h3>
      {state.scans.length === 0 ? (
        <p className="moco-sub">No scans yet — the gate fills this as agents write UI files, or call <code>mococraft_scan</code>.</p>
      ) : (
        <table className="moco-scans">
          <thead><tr><th>File</th><th>Verdict</th><th>Index</th><th>Tells</th></tr></thead>
          <tbody>
            {state.scans.map((s) => (
              <tr key={s.file}>
                <td className="moco-file">{s.file}</td>
                <td style={{ color: VERDICT_COLOR[s.verdict] ?? 'inherit' }}>{s.verdict}</td>
                <td className="moco-num">{s.slopIndex}</td>
                <td className="moco-num">{s.hits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="moco-h">Asymmetry Library</h3>
      <ul className="moco-macros">
        {state.macros.map((m) => (
          <li key={m.id}><b>{m.name}</b><small>{m.sketch}</small></li>
        ))}
      </ul>
    </div>
  );
}
