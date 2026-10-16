/**
 * RSA/T PRD form — Guided Workbench (design/prd_form_d_guided_workbench.html).
 * Menulis PRD seperti dokumen korporat terpandu: rail section bernomor dengan
 * dot status live (kosong/sebagian/lengkap), satu section per langkah,
 * editor baris terstruktur, pratinjau dokumen + Teks Agent, publish gate.
 * Kontrak data TIDAK berubah — tetap PrdFields (store.tsx).
 */
import { useMemo, useState } from 'react';
import { tr } from './shared.tsx';
import { Ic } from './icon.tsx';
import type { Prd } from './store.tsx';

type Con = { t: string; m: string };
type Mod = { layer: string; name: string; desc: string; links: number[] };
type Pair = { a: string; b: string };
type Risk = { sev: string; text: string; mit: string };
type Draft = {
  title: string; summary: string; inc: string; exc: string; arch: string;
  goals: string[]; cons: Con[]; mods: Mod[]; miles: Pair[]; nfr: Pair[];
  risks: Risk[]; tech: Pair[];
};

const LAYERS = ['domain', 'presentation', 'application', 'infrastructure', 'shared'] as const;
const SEV_KEYS: Record<string, string> = { high: 'sevHigh', medium: 'sevMedium', low: 'sevLow' };
const LAY: Record<string, string> = {
  domain: 'Domain', presentation: 'Presentation', application: 'Application',
  infrastructure: 'Infrastructure', shared: 'Shared',
};

const SEC = [
  { k: 'sum', n: '00', hk: 'secSum', wk: 'whySum' },
  { k: 'goals', n: '01', hk: 'secGoals', wk: 'whyGoals' },
  { k: 'cons', n: '02', hk: 'secCons', wk: 'whyCons' },
  { k: 'arch', n: '03', hk: 'secArch', wk: 'whyArch' },
  { k: 'mods', n: '04', hk: 'secMods', wk: 'whyMods' },
  { k: 'miles', n: '05', hk: 'secMiles', wk: 'whyMiles' },
  { k: 'nfr', n: '06', hk: 'secNfr', wk: 'whyNfr' },
  { k: 'risks', n: '07', hk: 'secRisks', wk: 'whyRisks' },
  { k: 'tech', n: '08', hk: 'secTech', wk: 'whyTech' },
] as const;

function fromPrd(p: Prd | null): Draft {
  const mods = p?.modules ?? [];
  return {
    title: p?.title ?? '',
    summary: p?.summary ?? '',
    inc: (p?.inc ?? ['src/**']).join('\n'),
    exc: (p?.exc ?? ['**/*.env*', '.data/**']).join('\n'),
    arch: (p as Record<string, unknown>)?.architecture as string ?? '',
    goals: (p?.goals ?? []).map((g) => ({ t: g, m: 'advisory' } as Con).t),
    cons: (p?.cons ?? []).map((c) => ({ t: c.t, m: c.m === 'strict' ? 'strict' : 'advisory' })),
    mods: mods.map((m) => ({
      layer: m.layer ?? 'presentation',
      name: m.name,
      desc: m.desc,
      links: (m.allowedImports ?? []).map((a) => mods.findIndex((x) => x.id === a)).filter((i) => i >= 0),
    })),
    miles: (p?.milestones ?? []).map((m) => ({ a: m.title, b: m.goal })),
    nfr: (p?.nonFunctional ?? []).map((n) => ({ a: n.text, b: n.metric })),
    risks: (p?.risks ?? []).map((r) => ({ sev: r.severity, text: r.text, mit: r.mitigation })),
    tech: ((p as Record<string, unknown>)?.technicalDecisions as Array<{ text: string; reason?: string }> ?? []).map((td) => ({ a: td.text, b: td.reason ?? '' })),
  };
}

type Stat = 'e' | 'p' | 'd';

/** Status kelengkapan per section (dot rail + publish gate). */
function secStats(d: Draft): Stat[] {
  const filled = (xs: { a: string; b: string }[]) => {
    const full = xs.filter((x) => x.a.trim() && x.b.trim()).length;
    const half = xs.filter((x) => x.a.trim() && !x.b.trim()).length;
    return full >= 1 ? 'd' : half >= 1 ? 'p' : 'e';
  };
  const g = d.goals.filter((x) => x.trim()).length;
  const c = d.cons.filter((x) => x.t.trim()).length;
  const named = d.mods.filter((m) => m.name.trim());
  return [
    !d.title.trim() && !d.summary.trim() ? 'e' : d.title.trim() && d.summary.trim().length >= 20 ? 'd' : 'p',
    g >= 1 ? 'd' : 'e',
    c >= 1 ? 'd' : 'e',
    d.arch.trim().length >= 30 ? 'd' : d.arch.trim() ? 'p' : 'e',
    named.length >= 1 && named.every((m) => LAYERS.includes(m.layer as never)) ? 'd' : named.length >= 1 ? 'p' : 'e',
    filled(d.miles),
    filled(d.nfr),
    d.risks.filter((r) => r.text.trim()).length >= 1 ? 'd' : 'e',
    filled(d.tech),
  ];
}

/** Teks Agent: dokumen dalam sintaks kontrak RSAT yang mentah. */
function agentText(d: Draft, t: (k: string) => string): string {
  const L: string[] = [`# ${d.title.trim() || t('prdwUntitledL')}`];
  if (d.summary.trim()) L.push(d.summary.trim());
  const gl = d.goals.filter((x) => x.trim());
  if (gl.length) { L.push('', 'GOALS:'); gl.forEach((g) => L.push(`- ${g.trim()}`)); }
  const co = d.cons.filter((x) => x.t.trim());
  if (co.length) { L.push('', 'CONSTRAINTS:'); co.forEach((c) => L.push(`${c.m === 'strict' ? '!' : ' '} ${c.t.trim()}`)); }
  if (d.arch.trim()) L.push('', 'ARCHITECTURE:', d.arch.trim());
  const mo = d.mods.filter((m) => m.name.trim());
  if (mo.length) {
    L.push('', 'MODULES:');
    mo.forEach((m, i) => {
      const id = `m${String(i + 1).padStart(2, '0')}`;
      const links = m.links.map((li) => `m${String(li + 1).padStart(2, '0')}`).join(', ');
      L.push(`[${m.layer}] ${m.name.trim()}${m.desc.trim() ? ` — ${m.desc.trim()}` : ''}${links ? ` -> ${links}` : ''} (${id})`);
    });
  }
  const mi = d.miles.filter((x) => x.a.trim());
  if (mi.length) { L.push('', 'MILESTONES:'); mi.forEach((m) => L.push(`${m.a.trim()}${m.b.trim() ? ` — ${m.b.trim()}` : ''}`)); }
  const nf = d.nfr.filter((x) => x.a.trim());
  if (nf.length) { L.push('', 'NON-FUNCTIONAL:'); nf.forEach((n) => L.push(`${n.a.trim()}${n.b.trim() ? ` — ${n.b.trim()}` : ''}`)); }
  const ri = d.risks.filter((r) => r.text.trim());
  if (ri.length) { L.push('', 'RISKS:'); ri.forEach((r) => L.push(`[${r.sev}] ${r.text.trim()}${r.mit.trim() ? ` — ${r.mit.trim()}` : ''}`)); }
  const td = d.tech.filter((x) => x.a.trim());
  if (td.length) { L.push('', 'TECH DECISIONS:'); td.forEach((x) => L.push(`${x.a.trim()}${x.b.trim() ? ` — ${x.b.trim()}` : ''}`)); }
  return L.join('\n');
}

const EXAMPLES: Record<string, Partial<Draft>> = {
  sum: { title: 'Interlinked — Architectural Perception', summary: 'Panel node ComfyUI-style + format @RSLK agar agent memahami arsitektur workspace secara nyata sebelum menulis kode.' },
  goals: { goals: ['Agent memahami layer & ketergantungan antar file sebelum edit', 'Blast radius perubahan terlihat dari panel arsitektur'] },
  cons: { cons: [{ t: 'Addon tidak boleh mengimpor modul host server', m: 'strict' }, { t: 'Scan workspace selesai di bawah 2 detik', m: 'advisory' }] },
  arch: { arch: 'SPA React + proxy Express. Store terpusat di client; server berisi engine, guard, dan scanner arsitektur yang berdiri sendiri.' },
  mods: { mods: [{ layer: 'domain', name: 'Core Store', desc: 'State PRD & quest', links: [] }, { layer: 'presentation', name: 'Canvas UI', desc: 'Kanvas node & inspector', links: [0] }] },
  miles: { miles: [{ a: 'Prototype UI', b: 'Kanvas node bisa di-pan/zoom dengan mock data' }, { a: 'Scanner live', b: 'Graph merefleksikan workspace nyata' }] },
  nfr: { nfr: [{ a: 'Pan/zoom mulus', b: '<16ms per frame' }] },
  risks: { risks: [{ sev: 'high', text: 'Scanner regex miskin', mit: 'Batasi ke .ts/.tsx dan uji di workspace besar' }] },
  tech: { tech: [{ a: 'Parser regex ringan', b: 'Tanpa dependency AST eksternal — cukup untuk import/export' }] },
};

export default function PrdForm({ lang, prd, onSave, onCancel }: {
  lang: string;
  prd: Prd | null;
  onSave: (p: Prd) => void;
  onCancel: () => void;
}) {
  const t = (k: string) => tr(lang, k);
  const [d, setD] = useState<Draft>(() => fromPrd(prd));
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<'w' | 'v'>('w');
  const [raw, setRaw] = useState(false);
  const [warn, setWarn] = useState<number[] | null>(null);

  const stats = useMemo(() => secStats(d), [d]);
  const doneCount = stats.filter((s) => s === 'd').length;
  const pct = Math.round((doneCount / SEC.length) * 100);
  const patch = (p: Partial<Draft>) => setD((v) => ({ ...v, ...p }));
  const cur = SEC[step];

  const save = () => {
    const incomplete = SEC.map((_, i) => i).filter((i) => stats[i] !== 'd');
    if (incomplete.length) { setWarn(incomplete); return; }
    doSave();
  };
  const doSave = () => {
    if (!d.title.trim()) return;
    const mods = d.mods.filter((m) => m.name.trim());
    onSave({
      id: prd?.id ?? `prd_${Date.now().toString(36)}`,
      title: d.title.trim(),
      summary: d.summary.trim(),
      status: prd?.status ?? 'draft',
      inc: d.inc.split('\n').map((x) => x.trim()).filter(Boolean),
      exc: d.exc.split('\n').map((x) => x.trim()).filter(Boolean),
      cons: d.cons.filter((c) => c.t.trim()).map((c) => ({ t: c.t.trim(), m: c.m })),
      goals: d.goals.map((g) => g.trim()).filter(Boolean),
      createdAt: prd?.createdAt ?? new Date().toISOString(),
      architecture: d.arch.trim(),
      modules: mods.map((m, i) => ({
        id: `m${String(i + 1).padStart(2, '0')}`,
        name: m.name.trim(),
        desc: m.desc.trim(),
        layer: LAYERS.includes(m.layer as never) ? m.layer : undefined,
        allowedImports: m.links.length ? m.links.map((li) => `m${String(li + 1).padStart(2, '0')}`) : undefined,
        inc: ['src/**'], exc: [],
      })),
      milestones: d.miles.filter((x) => x.a.trim()).map((x, i) => ({ id: `M${String(i + 1).padStart(2, '0')}`, title: x.a.trim(), goal: x.b.trim() })),
      nonFunctional: d.nfr.filter((x) => x.a.trim()).map((x, i) => ({ id: `nf${i + 1}`, text: x.a.trim(), metric: x.b.trim() })),
      risks: d.risks.filter((r) => r.text.trim()).map((r, i) => ({ id: `r${i + 1}`, text: r.text.trim(), mitigation: r.mit.trim(), severity: r.sev })),
      technicalDecisions: d.tech.filter((x) => x.a.trim()).map((x) => ({ text: x.a.trim(), reason: x.b.trim() })),
    } as Prd);
  };

  const statChip = (s: Stat) => s === 'd' ? `● ${t('prdwDone')}` : s === 'p' ? `◐ ${t('prdwPartial')}` : `○ ${t('prdwEmpty')}`;
  const fillExample = () => patch(EXAMPLES[cur.k] as Partial<Draft>);
  const copyAgent = () => { void navigator.clipboard?.writeText(agentText(d, t)); };

  const listEditor = (key: 'goals' | 'cons') => {
    if (key === 'goals') {
      return (
        <>
          {d.goals.map((g, i) => (
            <div className="prdw-row" key={`g${i}`}>
              <span className="prdw-idx">{i + 1}</span>
              <input className="field" value={g} placeholder={t('prdwGoalPh')}
                aria-label={`${t('secGoals')} ${i + 1}`}
                onChange={(e) => patch({ goals: d.goals.map((x, j) => (j === i ? e.target.value : x)) })} />
              <button className="btn sm" type="button" aria-label={t('prdwDelete')} onClick={() => patch({ goals: d.goals.filter((_, j) => j !== i) })}>
                <Ic name="x" sm />
              </button>
            </div>
          ))}
          <button className="btn sm" type="button" onClick={() => patch({ goals: [...d.goals, ''] })}><Ic name="plus" sm /> {t('prdwAddGoal')}</button>
        </>
      );
    }
    return (
      <>
        {d.cons.map((c, i) => (
          <div className="prdw-row" key={`c${i}`}>
            <span className="prdw-idx">{i + 1}</span>
            <input className="field" value={c.t} placeholder={t('prdwConPh')} aria-label={`${t('secCons')} ${i + 1}`}
              onChange={(e) => patch({ cons: d.cons.map((x, j) => (j === i ? { ...x, t: e.target.value } : x)) })} />
            <button className="btn sm" type="button" aria-pressed={c.m === 'strict'}
              title={c.m === 'strict' ? `${t('prdwStrictT')} — blocks the agent` : `${t('prdwAdvisory')} — reminder only`}
              onClick={() => patch({ cons: d.cons.map((x, j) => (j === i ? { ...x, m: x.m === 'strict' ? 'advisory' : 'strict' } : x)) })}>
              <Ic name={c.m === 'strict' ? 'lock' : 'unlock'} sm /> {c.m === 'strict' ? t('prdwStrictT') : t('prdwAdvisory')}
            </button>
            <button className="btn sm" type="button" aria-label={t('prdwDelete')} onClick={() => patch({ cons: d.cons.filter((_, j) => j !== i) })}>
              <Ic name="x" sm />
            </button>
          </div>
        ))}
        <button className="btn sm" type="button" onClick={() => patch({ cons: [...d.cons, { t: '', m: 'advisory' }] })}><Ic name="plus" sm /> {t('prdwAddCon')}</button>
        <div className="prdw-hint">{t('prdwStrictHint')}</div>
      </>
    );
  };

  const pairEditor = (key: 'miles' | 'nfr' | 'tech', ph: [string, string]) => {
    const val = d[key] as Pair[];
    const set = (nx: Pair[]) => patch({ [key]: nx } as Partial<Draft>);
    return (
      <>
        <div className="prdw-ph"><span className="h2">{ph[0]}</span><span>{ph[1]}</span><span /></div>
        {val.map((p, i) => (
          <div className="prdw-row" key={`${key}${i}`}>
            <span className="prdw-idx">{i + 1}</span>
            <div className="prdw-pair">
              <input className="field" value={p.a} placeholder={ph[0]} aria-label={`${ph[0]} ${i + 1}`} onChange={(e) => set(val.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} />
              <input className="field" value={p.b} placeholder={ph[1]} aria-label={`${ph[1]} ${i + 1}`} onChange={(e) => set(val.map((x, j) => (j === i ? { ...x, b: e.target.value } : x)))} />
            </div>
            <button className="btn sm" type="button" aria-label={t('prdwDelete')} onClick={() => set(val.filter((_, j) => j !== i))}><Ic name="x" sm /></button>
          </div>
        ))}
        <button className="btn sm" type="button" onClick={() => set([...val, { a: '', b: '' }])}><Ic name="plus" sm /> {t('prdwAddRow')}</button>
      </>
    );
  };

  const modEditor = () => (
    <>
      {d.mods.map((m, i) => (
        <div className="prdw-mod" key={`m${i}`}>
          <div className="prdw-row" style={{ marginBottom: 6 }}>
            <span className="prdw-mid">M-{String(i + 1).padStart(2, '0')}</span>
            <select className="field prdw-sel" value={m.layer} aria-label={t('prdwLayer')}
              onChange={(e) => patch({ mods: d.mods.map((x, j) => (j === i ? { ...x, layer: e.target.value } : x)) })}>
              {LAYERS.map((l) => <option key={l} value={l}>{LAY[l]}</option>)}
            </select>
            <input className="field" value={m.name} placeholder={t('prdwModNamePh')} aria-label={`${t('prdwModName')} ${i + 1}`}
              onChange={(e) => patch({ mods: d.mods.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <button className="btn sm" type="button" aria-label={t('prdwDelMod')} onClick={() => patch({ mods: d.mods.filter((_, j) => j !== i) })}><Ic name="x" sm /></button>
          </div>
          <input className="field" style={{ width: '100%' }} value={m.desc} placeholder={t('prdwModDescPh')} aria-label={`${t('prdwModDesc')} ${i + 1}`}
            onChange={(e) => patch({ mods: d.mods.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })} />
          <div className="prdw-lkl">{t('prdwAllows')}</div>
          <div className="prdw-chips">
            {d.mods.map((o, oi) => oi === i ? null : (
              <button key={`lk${i}-${oi}`} type="button" className="chip" aria-pressed={m.links.includes(oi)}
                onClick={() => patch({ mods: d.mods.map((x, j) => (j === i ? { ...x, links: x.links.includes(oi) ? x.links.filter((z) => z !== oi) : [...x.links, oi].sort((a, b) => a - b) } : x)) })}>
                M-{String(oi + 1).padStart(2, '0')} {o.name.trim() || t('prdwUnnamed')}
              </button>
            ))}
            {d.mods.length <= 1 ? <span className="prdw-hint" style={{ margin: 0 }}>{t('prdwOther')}</span> : null}
          </div>
        </div>
      ))}
      <button className="btn sm" type="button" onClick={() => patch({ mods: [...d.mods, { layer: 'presentation', name: '', desc: '', links: [] }] })}><Ic name="plus" sm /> {t('prdwAddMod')}</button>
      {d.mods.some((m) => m.name.trim()) ? (
        <>
          <div className="prdw-lkl">{t('prdwMatrix')}</div>
          <div className="prdw-mx">
            {d.mods.map((m, i) => m.name.trim() ? (
              <div className="prdw-mxr" key={`mx${i}`}>
                <div className="nm">M-{String(i + 1).padStart(2, '0')} {m.name.trim()}</div>
                <div className="im">
                  <span className={`prdw-lay ${m.layer}`}>{m.layer}</span>
                  <span>allows {m.links.length ? m.links.map((li) => `M-${String(li + 1).padStart(2, '0')}`).join(', ') : t('prdwAll')}</span>
                </div>
              </div>
            ) : null)}
          </div>
        </>
      ) : null}
    </>
  );

  const riskEditor = () => (
    <>
      {d.risks.map((r, i) => (
        <div className="prdw-mod" key={`r${i}`}>
          <div className="prdw-row" style={{ marginBottom: 6 }}>
            <span className="prdw-idx" style={{ width: 'auto', padding: '0 8px' }}>{i + 1}</span>
            <div className="prdw-seg">
              {['high', 'medium', 'low'].map((v) => (
                <button key={v} type="button" className={`chip prdw-sev ${v}`} data-v={v} aria-pressed={r.sev === v}
                  onClick={() => patch({ risks: d.risks.map((x, j) => (j === i ? { ...x, sev: v } : x)) })}>
                  {t(SEV_KEYS[v])}
                </button>
              ))}
            </div>
            <input className="field" value={r.text} placeholder={t('prdwRiskPh')} aria-label={`${t('prdwRiskL')} ${i + 1}`}
              onChange={(e) => patch({ risks: d.risks.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
            <button className="btn sm" type="button" aria-label={t('prdwDelRisk')} onClick={() => patch({ risks: d.risks.filter((_, j) => j !== i) })}><Ic name="x" sm /></button>
          </div>
          <input className="field" style={{ width: '100%' }} value={r.mit} placeholder={t('prdwMitPh')} aria-label={`${t('prdwMit')} ${i + 1}`}
            onChange={(e) => patch({ risks: d.risks.map((x, j) => (j === i ? { ...x, mit: e.target.value } : x)) })} />
        </div>
      ))}
      <button className="btn sm" type="button" onClick={() => patch({ risks: [...d.risks, { sev: 'medium', text: '', mit: '' }] })}><Ic name="plus" sm /> {t('prdwAddRisk')}</button>
    </>
  );

  const editor = (k: string) => {
    if (k === 'sum') return (
      <>
        <label className="prdw-lb" htmlFor="prdw-t">{t('prdwTitleL')}</label>
        <input id="prdw-t" className="field" style={{ width: '100%' }} value={d.title} placeholder={t('prdwTitlePh')}
          onChange={(e) => patch({ title: e.target.value })} />
        <div className="prdw-hint">{t('prdwTitleHint')}</div>
        <label className="prdw-lb" htmlFor="prdw-s">{t('prdwSummaryL')}</label>
        <textarea id="prdw-s" className="field" style={{ width: '100%' }} value={d.summary} rows={3} placeholder={t('prdwSumPh')}
          onChange={(e) => patch({ summary: e.target.value })} />
        <div className="prdw-hint">{t('prdwSumHint')}</div>
        <label className="prdw-lb" htmlFor="prdw-i">{t('prdwScopeInc')}</label>
        <textarea id="prdw-i" className="field mono" style={{ width: '100%', minHeight: 48 }} value={d.inc} rows={2} onChange={(e) => patch({ inc: e.target.value })} />
        <label className="prdw-lb" htmlFor="prdw-e">{t('prdwScopeExc')}</label>
        <textarea id="prdw-e" className="field mono" style={{ width: '100%', minHeight: 48 }} value={d.exc} rows={2} onChange={(e) => patch({ exc: e.target.value })} />
      </>
    );
    if (k === 'goals') return listEditor('goals');
    if (k === 'cons') return listEditor('cons');
    if (k === 'arch') return (
      <>
        <label className="prdw-lb" htmlFor="prdw-a">{t('prdwArchL')}</label>
        <textarea id="prdw-a" className="field" style={{ width: '100%' }} value={d.arch} rows={4} placeholder={t('prdwArchPh')}
          onChange={(e) => patch({ arch: e.target.value })} />
        <div className="prdw-hint">{t('prdwArchHint')}</div>
      </>
    );
    if (k === 'mods') return modEditor();
    if (k === 'miles') return pairEditor('miles', [t('prdwPairPh1'), t('prdwPairPh2')]);
    if (k === 'nfr') return pairEditor('nfr', [t('prdwNfrPh1'), t('prdwNfrPh2')]);
    if (k === 'tech') return pairEditor('tech', [t('prdwTechPh1'), t('prdwTechPh2')]);
    return riskEditor();
  };

  const jump = (i: number) => { setStep(i); setMode('w'); setWarn(null); };

  const preview = () => {
    const sec = (i: number, body: React.ReactNode) => (
      <h3><span className="no">{SEC[i].n}</span>{t(SEC[i].hk)}
        <button className="btn sm ed" type="button" onClick={() => jump(i)}><Ic name="file-edit" sm /> {t('prdwEdit')}</button>
      </h3>
    );
    const ul = (xs: string[]) => xs.length ? <ul>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="prdw-hint">{t('prdwEmptyL')}</p>;
    return (
      <div className="prdw-doc">
        {sec(0, null)}
        <p><b>{d.title.trim() || t('prdwUntitledL')}</b></p>
        <p>{d.summary.trim() || <span className="prdw-hint">{t('prdwEmptyL')}</span>}</p>
        <p className="prdw-hint">{t('prdwScope')} {d.inc.split('\n').map((x) => x.trim()).filter(Boolean).join(', ') || '—'}</p>
        {sec(1, null)}{ul(d.goals.map((g) => g.trim()).filter(Boolean))}
        {sec(2, null)}{ul(d.cons.filter((c) => c.t.trim()).map((c) => `${c.m === 'strict' ? '🔒 ' : ''}${c.t.trim()}`))}
        {sec(3, null)}<p>{d.arch.trim() || <span className="prdw-hint">{t('prdwEmptyL')}</span>}</p>
        {sec(4, null)}
        {d.mods.some((m) => m.name.trim()) ? (
          <div className="prdw-mx">
            {d.mods.map((m, i) => m.name.trim() ? (
              <div className="prdw-mxr" key={`pv${i}`}>
                <div className="nm">M-{String(i + 1).padStart(2, '0')} {m.name.trim()}</div>
                <div className="im"><span className={`prdw-lay ${m.layer}`}>{m.layer}</span><span>{m.desc.trim() || '—'}</span></div>
              </div>
            ) : null)}
          </div>
        ) : <p className="prdw-hint">{t('prdwEmptyL')}</p>}
        {sec(5, null)}{ul(d.miles.filter((x) => x.a.trim()).map((x) => `${x.a.trim()}${x.b.trim() ? ` — ${x.b.trim()}` : ''}`))}
        {sec(6, null)}{ul(d.nfr.filter((x) => x.a.trim()).map((x) => `${x.a.trim()}${x.b.trim() ? ` — ${x.b.trim()}` : ''}`))}
        {sec(7, null)}{ul(d.risks.filter((r) => r.text.trim()).map((r) => `[${t(SEV_KEYS[r.sev] ?? r.sev)}] ${r.text.trim()}${r.mit.trim() ? ` — ${r.mit.trim()}` : ''}`))}
        {sec(8, null)}{ul(d.tech.filter((x) => x.a.trim()).map((x) => `${x.a.trim()}${x.b.trim() ? ` — ${x.b.trim()}` : ''}`))}
      </div>
    );
  };

  return (
    <section className="prdw">
      {}
      <div className="prdw-top">
        <div className="prdw-brand">
          <div className="prdw-seal">RSA/T</div>
          <div>
            <div className="prdw-title">{prd ? t('editPrd') : t('newPrd')}</div>
            <div className="prdw-meta"><span>DOC <b>{prd?.id ?? 'NEW'}</b></span><span>REV <b>v1</b></span><span className="prdw-stamp">{(prd?.status ?? 'draft') === 'draft' ? t('prdwDraftL') : (prd?.status ?? '')}</span></div>
          </div>
        </div>
        <div className="grp">
          <button className="btn sm" type="button" aria-pressed={mode === 'w'} onClick={() => setMode('w')}><Ic name="file-edit" sm /> {t('prdwWrite')}</button>
          <button className="btn sm" type="button" aria-pressed={mode === 'v'} onClick={() => setMode('v')}><Ic name="eye" sm /> {t('prdwPreview')}</button>
          <button className="btn sm" type="button" onClick={onCancel}><Ic name="x" sm /> {t('prdwClose')}</button>
        </div>
      </div>

      <div className="prdw-body">
        {}
        <aside className="prdw-rail">
          <div className="prdw-rail-h">{t('prdwSections')}</div>
          {SEC.map((s, i) => (
            <button key={s.k} type="button" className={`prdw-si${mode === 'w' && i === step ? ' on' : ''}`} onClick={() => jump(i)}>
              <span className={`prdw-dot ${stats[i]}`} /> {s.n} {t(s.hk)}
            </button>
          ))}
          <div className="prdw-prog">{t('prdwComplete')} {doneCount}/{SEC.length}
            <div className="prdw-bar"><i style={{ width: `${pct}%` }} /></div>
          </div>
        </aside>

        {}
        <div className="prdw-main">
          {mode === 'v' ? (
            <div className="prdw-prev">
              {preview()}
              <div className="prdw-lkl" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn sm" type="button" aria-pressed={raw} onClick={() => setRaw((v) => !v)}><Ic name="code" sm /> {t('prdwAgentText')}</button>
                {raw ? <button className="btn sm" type="button" onClick={copyAgent}><Ic name="copy" sm /> {t('prdwCopy')}</button> : null}
              </div>
              {raw ? <div className="prdw-raw">{agentText(d, t)}</div> : null}
              <div className="prdw-nav">
                <span />
                <button className="btn" type="button" onClick={() => setMode('w')}><Ic name="file-edit" sm /> {t('prdwBack')}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="prdw-step">{t('prdwStep')} {step + 1} {t('prdwOf')} {SEC.length}</div>
              <div className="prdw-sh">
                <span className="prdw-no">{cur.n}</span>
                <span className="prdw-stt">{t(cur.hk)}</span>
                <span className="chip">{statChip(stats[step])}</span>
              </div>
              <div className="prdw-why">
                <Ic name="bulb" />
                <div className="grow">{t(cur.wk)}</div>
                <button className="btn sm" type="button" onClick={fillExample}><Ic name="wand" sm /> {t('prdwExample')}</button>
              </div>
              {editor(cur.k)}
              <div className="prdw-nav">
                <button className="btn" type="button" disabled={step === 0} onClick={() => setStep(step - 1)}><Ic name="chev-l" sm /> {t('prdwPrev')}</button>
                {step < SEC.length - 1 ? (
                  <button className="btn pri" type="button" onClick={() => setStep(step + 1)}>{t('prdwNext')} <Ic name="chev-r" sm /></button>
                ) : (
                  <button className="btn pri" type="button" onClick={() => setMode('v')}><Ic name="eye" sm /> {t('prdwSeePrev')}</button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {}
      {warn ? (
        <div className="prdw-warn">
          <b>{warn.length} {t('prdwIncomplete')}</b>{' '}
          {warn.map((i) => <button key={i} type="button" className="chip" onClick={() => jump(i)}>{SEC[i].n} {t(SEC[i].hk)}</button>)}
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            <button className="btn sm" type="button" onClick={() => setWarn(null)}>{t('prdwFix')}</button>
            <button className="btn sm" type="button" onClick={doSave}>{t('prdwSaveAnyway')}</button>
          </div>
        </div>
      ) : null}

      {}
      <div className="prdw-foot">
        <span className="prdw-auto">{t('prdwAuto')} {doneCount}/{SEC.length}</span>
        <span className="grp">
          <button className="btn" type="button" onClick={onCancel}>{t('prdwCancel')}</button>
          <button className="btn pri" type="button" disabled={!d.title.trim()} onClick={save}><Ic name="check" sm /> {t('prdwSave')}</button>
        </span>
      </div>
    </section>
  );
}
