/**
 * RSA/T quest form — create quest dari Quest board (RSAT.txt butir 1).
 * Form inline pixel-style; ID/no ditetapkan server (rpc createAchievement).
 */
import { useState } from 'react';
import { tr } from './shared.tsx';
import { Ic } from './icon.tsx';

const KINDS = ['feature', 'bugfix', 'refactor', 'chore', 'research', 'test'];
const TIERS = ['bronze', 'silver', 'gold', 'diamond'];

export type QuestFields = {
  title: string; kind: string; tier: string; pts: number; dep: string[];
  desc: string; tech: string; ac: string[]; inc: string[];
  provides?: string[]; consumes?: string[];
};

export default function QuestForm({ lang, deps, onSave, onCancel }: {
  lang: string;
  deps: string[];
  onSave: (q: QuestFields) => void;
  onCancel: () => void;
}) {
  const t = (k: string) => tr(lang, k);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('feature');
  const [tier, setTier] = useState('bronze');
  const [pts, setPts] = useState('10');
  const [dep, setDep] = useState('');
  const [desc, setDesc] = useState('');
  const [tech, setTech] = useState('');
  const [ac, setAc] = useState('');
  const [inc, setInc] = useState('src/**');
  const [provides, setProvides] = useState('');
  const [consumes, setConsumes] = useState('');
  const invalid = !title.trim();
  const save = () => {
    if (invalid) return;
    onSave({
      title: title.trim(),
      kind,
      tier,
      pts: Math.max(1, Number(pts) || 10),
      dep: dep.split(',').map((x) => x.trim()).filter(Boolean),
      desc: desc.trim(),
      tech: tech.trim(),
      ac: ac.split('\n').map((x) => x.trim()).filter(Boolean),
      inc: inc.split('\n').map((x) => x.trim()).filter(Boolean),
      provides: provides.split(',').map((x) => x.trim()).filter(Boolean),
      consumes: consumes.split(',').map((x) => x.trim()).filter(Boolean),
    });
  };
  return (
    <section className="pn pform">
      <h2>{t('newQuest')}</h2>
      <div className="col">
        <div className="eyebrow">Title *</div>
        <input className="field" value={title} placeholder="Payment form validation" aria-label="Quest title" onChange={(e) => setTitle(e.target.value)} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label className="col grow">
            <span className="eyebrow">Kind</span>
            <select className="field" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="col grow">
            <span className="eyebrow">Tier</span>
            <select className="field" value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier">
              {TIERS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="col" style={{ width: 110 }}>
            <span className="eyebrow">{t('points')}</span>
            <input className="field" value={pts} inputMode="numeric" aria-label="Points" onChange={(e) => setPts(e.target.value)} />
          </label>
        </div>
        <div className="eyebrow">{t('deps')} ({t('all').toLowerCase()}: {deps.join(', ') || '—'})</div>
        <input className="field mono" value={dep} placeholder="A-001, A-002" aria-label="Depends on" onChange={(e) => setDep(e.target.value)} />
        <div className="eyebrow">Description</div>
        <textarea className="field" value={desc} rows={2} placeholder="What must be true when this is done?" aria-label="Description" onChange={(e) => setDesc(e.target.value)} />
        <div className="eyebrow">{t('tech')}</div>
        <textarea className="field" value={tech} rows={2} placeholder="How to get there — files, endpoints, constraints." aria-label="Technical notes" onChange={(e) => setTech(e.target.value)} />
        <div className="eyebrow">{t('accept')} (one per line)</div>
        <textarea className="field" value={ac} rows={3} placeholder="Card number passes Luhn check" aria-label="Acceptance criteria" onChange={(e) => setAc(e.target.value)} />
        <div className="eyebrow">Scope · include (one glob per line)</div>
        <textarea className="field mono" value={inc} rows={2} placeholder="src/**" aria-label="Scope include" onChange={(e) => setInc(e.target.value)} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label className="col grow">
            <span className="eyebrow">Contract · Provides (comma-separated symbols)</span>
            <input className="field mono" value={provides} placeholder="useRsat(), InterlinkGraph" aria-label="Provides symbols" onChange={(e) => setProvides(e.target.value)} />
          </label>
          <label className="col grow">
            <span className="eyebrow">Contract · Consumes (comma-separated symbols)</span>
            <input className="field mono" value={consumes} placeholder="rpc(), ServerDoc" aria-label="Consumes symbols" onChange={(e) => setConsumes(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="row">
        <button className="btn pri" type="button" disabled={invalid} onClick={save}>
          <Ic name="check" sm /> Create quest
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
