/**
 * RSA/T LangGate — layar pemilihan bahasa (RSAT.txt butir 0).
 * Papan tertutup sampai user MEMILIH bahasa: default English, bahasa lokal
 * hanya aktif lewat persetujuan eksplisit (tombol Bahasa Indonesia).
 */
import { Spr, sa } from './sprites.tsx';

export default function LangGate({ onPick }: { onPick: (lang: string) => void }) {
  return (
    <div className="gate">
      <section className="pn gcard">
        <div className="dropw">
          <div className="drop">
            <Spr name="gem" style={sa('rgb(var(--c-rsat-diamond))')} />
          </div>
        </div>
        <div className="eyebrow">RSA/T · Realtime Shared Achievement Tracker</div>
        <h1 style={{ margin: '2px 0 0' }}>Choose your language</h1>
        <p className="muted" style={{ margin: 0, maxWidth: '48ch' }}>
          English is the default. Bahasa lokal hanya dipakai jika Anda memilihnya —
          your local language is used only with your explicit consent.
        </p>
        <div className="row">
          <button className="btn pri" type="button" onClick={() => onPick('en')}>
            English
          </button>
          <button className="btn" type="button" onClick={() => onPick('id')}>
            Bahasa Indonesia
          </button>
        </div>
      </section>
    </div>
  );
}
