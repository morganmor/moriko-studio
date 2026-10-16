/**
 * RSA/T Create Agent panel (view 'create') — seperti membuat karakter game:
 * nama, logo custom (upload gambar), provider/model (bisa di-swap kapan saja
 * tanpa ganti identitas), catatan pembuka → memory terstruktur.
 * API key TIDAK disentuh di sini — tetap di konfigurasi host (backend).
 */
import { useEffect, useRef, useState } from 'react';
import { getProviders } from '@moriko/host';
import { Ic } from './icon.tsx';
import { toast } from './toast.tsx';
import {
  AgentFace, EFFORTS, createAgent, deleteAgent, updateAgent, useAgents, type AgentRec,
} from './agentstore.tsx';

type Prov = { id: string; label: string; models: string[] };

const LOGO_MAX = 128; // px — preview & storage sanity

/** Baca file gambar → data URL (dipakai sebagai logo agent, disimpan server). */
function readLogo(file: File, cb: (url: string) => void) {
  if (!/^image\//.test(file.type) || file.size > 200_000) {
    toast('error', 'Logo rejected', 'Use an image under 200 KB.');
    return;
  }
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, LOGO_MAX / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/png'));
    };
    img.onerror = () => toast('error', 'Logo rejected', 'Unreadable image.');
    img.src = String(rd.result);
  };
  rd.readAsDataURL(file);
}

/** Seed hash sederhana (djb2) — logo generator deterministik dari string. */
function seedOf(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Logo generator prosedural: blok 4×4 (identicon pixel-art, ala skin Minecraft)
 *  deterministik dari nama agent — tidak ada upload pun tetap punya wajah unik. */
function generateLogo(seed: string, palette: number): string {
  const P = ['#c0392b', '#d35400', '#e6a919', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#7f5539'];
  const h = seedOf(seed);
  const fg = P[palette % P.length];
  const bg = '#3b3b3b';
  const c = document.createElement('canvas');
  const px = LOGO_MAX / 5;
  c.width = LOGO_MAX;
  c.height = LOGO_MAX;
  const g = c.getContext('2d');
  if (!g) return '';
  g.fillStyle = bg;
  g.fillRect(0, 0, LOGO_MAX, LOGO_MAX);
  g.fillStyle = fg;
  let bits = h;
  const bit = () => {
    bits = (bits * 1103515245 + 12345) & 0x7fffffff;
    return bits;
  };
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 3; x++) {
      if (bit() % 5 < 3) {
        g.fillRect(px + x * px, px + y * px, px, px);
        g.fillRect(px + (5 - x) * px, px + y * px, px, px);
      }
    }
  }
  return c.toDataURL('image/png');
}

/** Tombol logo: upload gambar ATAU generate prosedural (cycle palet per klik). */
function LogoPicker({ name, logo, onPick }: { name: string; logo: string | null; onPick: (url: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [gen, setGen] = useState(0);
  return (
    <div className="col alogo-col">
      <button className="alogo" type="button" aria-label="Upload logo" onClick={() => fileRef.current?.click()}>
        {logo ? <img src={logo} alt="" /> : <Ic name="image" />}
      </button>
      <button
        className="btn sm" type="button"
        aria-label="Generate procedural logo"
        onClick={() => { onPick(generateLogo(name.trim() || 'agent', gen)); setGen((v) => v + 1); }}
      >
        <Ic name="spark" sm /> Generate
      </button>
      {logo ? (
        <button className="btn sm" type="button" aria-label="Clear logo" onClick={() => onPick(null)}>
          <Ic name="x" sm /> Clear
        </button>
      ) : null}
      <input
        ref={fileRef} type="file" accept="image/*" hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) readLogo(f, onPick);
        }}
      />
    </div>
  );
}

/** Form create (fieldset pixel) — juga dipakai edit via prop edit. */
function AgentForm({ providers, edit, onDone }: {
  providers: Prov[];
  edit?: AgentRec | null;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const models = providers.find((p) => p.id === providerId)?.models ?? [];
  const invalid = !name.trim() || !providerId || !model;

  useEffect(() => {
    if (!edit) return;
    setName(edit.name);
    setLogo(edit.logo);
    setProviderId(edit.providerId);
    setModel(edit.model);
    setEffort(edit.thinkingLevel);
  }, [edit]);
  useEffect(() => {
    if (!edit && !providerId && providers.length) {
      setProviderId(providers[0].id);
      setModel(providers[0].models[0] ?? '');
    }
  }, [edit, providers, providerId]);

  const blank = () => {
    setName('');
    setLogo(null);
    setProviderId(providers[0]?.id ?? '');
    setModel(providers[0]?.models[0] ?? '');
    setEffort('');
    setNote('');
  };

  const save = async () => {
    if (invalid || busy) return;
    setBusy(true);
    const done = edit
      ? await updateAgent(edit.id, { name: name.trim(), logo, providerId, model, thinkingLevel: effort })
      : await createAgent({ name: name.trim(), logo, providerId, model, thinkingLevel: effort, note: note.trim() });
    setBusy(false);
    if (!done) return;
    blank();
    onDone();
  };

  const cancel = () => {
    blank();
    onDone();
  };

  return (
    <section className="pn pform">
      <h2>{edit ? `Edit ${edit.id}` : 'Create agent'}</h2>
      <div className="col">
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <LogoPicker name={name} logo={logo} onPick={setLogo} />
          <label className="col grow">
            <span className="eyebrow">Name *</span>
            <input className="field" value={name} placeholder="Ruby the Refactorer" aria-label="Agent name" onChange={(e) => setName(e.target.value)} />
            <span className="hint">Identity persists across sessions — even across provider/model swaps. Generate draws a unique pixel logo from the name; upload overrides it.</span>
          </label>
        </div>
        <RuntimeRow
          providers={providers} models={models} providerId={providerId} model={model} effort={effort}
          onProvider={setProviderId} onModel={setModel} onEffort={setEffort}
        />
        <span className="hint">Effort rides every dispatch: new sessions for this agent start at this level (the model clamps to its own ladder when it lacks one).</span>
        <span className="hint">API keys stay in the host configuration — this form never sees or stores them.</span>
        {edit ? null : (
          <label className="col">
            <span className="eyebrow">Opening note (first memory entry)</span>
            <textarea
              className="field" rows={2} value={note} aria-label="Opening note"
              placeholder="What this agent is for — one durable fact."
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        )}
      </div>
      <div className="row">
        <button className="btn pri" type="button" disabled={invalid || busy} onClick={() => void save()}>
          <Ic name="check" sm /> {edit ? 'Save agent' : 'Create agent'}
        </button>
        <button className="btn" type="button" onClick={cancel}>Cancel</button>
      </div>
    </section>
  );
}

/** Provider + model + reasoning effort — satu baris (dipakai form create & edit). */
function RuntimeRow({ providers, models, providerId, model, effort, onProvider, onModel, onEffort }: {
  providers: Prov[]; models: string[]; providerId: string; model: string; effort: string;
  onProvider: (v: string) => void; onModel: (v: string) => void; onEffort: (v: string) => void;
}) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
      <label className="col grow">
        <span className="eyebrow">Provider *</span>
        <select
          className="field" value={providerId} aria-label="Provider"
          onChange={(e) => {
            onProvider(e.target.value);
            onModel(providers.find((p) => p.id === e.target.value)?.models[0] ?? '');
          }}
        >
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label className="col grow">
        <span className="eyebrow">Model *</span>
        <select className="field" value={model} aria-label="Model" onChange={(e) => onModel(e.target.value)}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label className="col grow">
        <span className="eyebrow">Reasoning effort</span>
        <select className="field" value={effort} aria-label="Reasoning effort" onChange={(e) => onEffort(e.target.value)}>
          {EFFORTS.map(([v, label]) => <option key={v || 'inherit'} value={v}>{label}</option>)}
        </select>
      </label>
    </div>
  );
}

/** Baris roster: logo, nama, model (pill), memory count, edit/delete two-step.
 *  Agent yang sedang diedit TETAP tampil di sini — diberi pill "editing". */
function AgentRow({ a, editing, onEdit }: { a: AgentRec; editing: boolean; onEdit: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <div className={`qrow pn in${editing ? ' editing' : ''}`}>
      <span className="avatar"><AgentFace ag={a.id} /></span>
      <div className="grow">
        <b>{a.name}</b> <span className="faint mono" style={{ fontSize: 11 }}>{a.id}</span>
        <div className="muted" style={{ fontSize: 12 }}>
          {a.providerId} · {a.model || '—'} · effort {a.thinkingLevel || 'inherit'} · {a.memory.length} memories
          {a.activeSessionId ? ` · session ${a.activeSessionId.slice(0, 8)}` : ''}
        </div>
      </div>
      <button className="btn sm" type="button" disabled={editing} onClick={onEdit}><Ic name="file-edit" sm /> Edit</button>
      <button
        className={`btn sm ${armed ? 'dng' : ''}`} type="button"
        onClick={() => {
          if (armed) void deleteAgent(a.id);
          else setArmed(true);
        }}
      >
        <Ic name="trash" sm /> {armed ? 'Confirm?' : 'Delete'}
      </button>
    </div>
  );
}

export default function CreateAgent() {
  const agents = useAgents();
  const [providers, setProviders] = useState<Prov[]>([]);
  const [editing, setEditing] = useState<AgentRec | null>(null);
  useEffect(() => {
    setProviders(getProviders());
  }, []);

  return (
    <div className="row" style={{ gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 340px', maxWidth: 460 }}>
        <AgentForm providers={providers} edit={editing} onDone={() => setEditing(null)} />
      </div>
      <div className="card col" style={{ flex: '1.4 1 420px' }}>
        <h2>Roster</h2>
        {agents.length ? agents.map((a) => (
          <AgentRow key={a.id} a={a} editing={editing?.id === a.id} onEdit={() => setEditing(a)} />
        )) : <div className="empty">No agents yet — create one above, then dispatch quests from a quest's drawer.</div>}
      </div>
    </div>
  );
}
