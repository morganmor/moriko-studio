/**
 * Council panel — the sidebar view (addon:council/panel).
 *
 * Reads the active council from the host store (useCouncil), pushes a
 * membership projection to the server (so agent tools + the prompt fragment
 * know the roster), edits the shared brief, and lets the user turn the active
 * chat into a council, add a sub session, or dispatch an RSA/T agent into one.
 *
 * Creation of conversations is HOST-OWNED (the store is the only writer), so
 * the panel dispatches DOM events (moriko:council-create / -sub-create) that
 * App.tsx handles; it never touches the store directly.
 */
import { useEffect, useState } from 'react';
import { useCouncil, openConversation, createCouncil, createSubSession, deleteSubSession, useAddonBus, invoke, notify } from '@moriko/host';

type Member = { id: string; title: string; agentId?: string };
type RsatAgent = { id: string; name: string; providerId: string; model: string; thinkingLevel?: string };

export default function Panel() {
  const council = useCouncil();
  const frame = useAddonBus('council.changed');
  const [brief, setBrief] = useState('');
  const [dirty, setDirty] = useState(false);
  const [agents, setAgents] = useState<RsatAgent[]>([]);
  const [pickAgent, setPickAgent] = useState<string | null>(null);
  const [pickOrchestrator, setPickOrchestrator] = useState<string | null>(null);
  const [orchestratorAgentId, setOrchestratorAgentId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [task, setTask] = useState('');

  const councilId = council.councilId ?? '';
  const isMain = council.main?.id === council.activeId;
  const subCount = council.subs.length;
  const boundIds = new Set([
    ...council.subs.map((s: Member) => s.agentId).filter(Boolean),
    ...(orchestratorAgentId ? [orchestratorAgentId] : []),
  ]);
  const freeAgents = agents.filter((ag) => !boundIds.has(ag.id));

  const refresh = async () => {
    if (!councilId) { setBrief(''); setOrchestratorAgentId(''); return; }
    try {
      const s = await invoke<{ brief: string; rsatAgents: RsatAgent[]; orchestratorAgentId?: string }>('council', 'state', { councilId });
      setBrief(s.brief ?? '');
      setAgents(s.rsatAgents ?? []);
      setOrchestratorAgentId(s.orchestratorAgentId ?? '');
      await invoke('council', 'syncSessions', {
        projection: {
          councilId,
          councilTitle: council.main?.title ?? '',
          members: [
            ...(council.main ? [{ sessionId: council.main.id, role: 'main', label: '', agentId: council.main.agentId ?? '', agentName: council.main.title ?? '' }] : []),
            ...council.subs.map((sub: Member, i: number) => ({
              sessionId: sub.id, role: 'sub', label: String(i + 1),
              agentId: sub.agentId ?? '', agentName: sub.title,
            })),
          ],
        },
      });
    } catch {  }
  };
  useEffect(() => { void refresh(); }, [councilId, frame]);

  const save = async () => {
    if (!councilId) return;
    try {
      await invoke('council', 'saveBrief', { councilId, brief });
      setDirty(false);
      notify('Council brief saved.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Save failed.', 'error');
    }
  };

  const onDispatchAgent = () => {
    const ag = agents.find((a) => a.id === pickAgent);
    if (!ag) return;
    window.dispatchEvent(new CustomEvent('moriko:council-dispatch', {
      detail: {
        providerId: ag.providerId, model: ag.model, agentId: ag.id, agentName: ag.name,
        thinkingLevel: ag.thinkingLevel, directive: task.trim() || undefined,
      },
    }));
    setPickAgent(null);
    setTask('');
  };

  /** User designates an RSAT agent as this council's ORCHESTRATOR: the main
   *  session gets bound to that agent's identity and the council doc records
   *  the id — that binding is what the council_dispatch/council_stop gate
   *  checks server-side. */
  const onDesignateOrchestrator = () => {
    const ag = agents.find((a) => a.id === pickOrchestrator);
    if (!ag) return;
    window.dispatchEvent(new CustomEvent('moriko:set-orchestrator', {
      detail: {
        agentId: ag.id, agentName: ag.name,
        providerId: ag.providerId, model: ag.model,
        thinkingLevel: ag.thinkingLevel,
      },
    }));
    setPickOrchestrator(null);
  };

  const onClearOrchestrator = () => {
    const active = council;
    if (!active.councilId) return;
    window.dispatchEvent(new CustomEvent('moriko:set-orchestrator', {
      detail: {
        agentId: '', agentName: '', providerId: '', model: '',
      },
    }));
  };

  // NOTE: the bus→window bridge lives in App.tsx (always mounted). A bridge

  return (
    <div className="council">
      <div className="page">
        <h2>Council Agent</h2>
        <p className="sub">
          {councilId
            ? `Council "${council.main?.title ?? 'untitled'}" — ${subCount} sub session${subCount === 1 ? '' : 's'}. Switch members from the dropdown below the chat title.`
            : 'Group many agent sessions under one conversation — one sidebar row, each agent keeps its own context.'}
        </p>

        {!councilId ? (
          <div className="sec">
            <div className="empty">
              The active chat is not a council yet. Turning it into a council keeps it as the Main Session
              (the visible row); agents you dispatch land in hidden Sub Sessions you switch between from the
              TopBar dropdown.
            </div>
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => { createCouncil(); }}>
              Turn this chat into a council
            </button>
          </div>
        ) : (
          <>
            <div className="cols">
              <div className="col">
                <div className="sec">
                  <div className="sec-h">Members</div>
                  <div className="members">
                    {council.main ? (
                      <div className="member">
                        <span className="tag main">Main</span>
                        {council.main.agentId && council.main.agentId === orchestratorAgentId ? (
                          <span className="tag main">Orch</span>
                        ) : null}
                        <span className="who">
                          <b>{council.main.title}</b>
                          <span>
                            {council.main.agentId && council.main.agentId === orchestratorAgentId
                              ? `Orchestrator agent ${council.main.agentId} is bound here`
                              : 'Main Session — the shared hub'}
                          </span>
                        </span>
                        <button type="button" className="btn ghost sm" onClick={() => openConversation(council.main.id)}>Open</button>
                      </div>
                    ) : null}
                {council.subs.map((sub: Member, i: number) => (
                  <div className="member" key={sub.id}>
                    <span className="tag">Sub {i + 1}</span>
                    <span className="who">
                      <b>{sub.title}</b>
                      <span>{sub.agentId ? `agent ${sub.agentId}` : 'no agent bound'}</span>
                    </span>
                    {council.activeId === sub.id ? null : (
                      <button type="button" className="btn ghost sm" onClick={() => openConversation(sub.id)}>Open</button>
                    )}
                    {confirmDelete === sub.id ? (
                      <span className="confirm-del">
                        <button type="button" className="btn ghost sm" onClick={() => { deleteSubSession(sub.id); setConfirmDelete(null); }}>Delete</button>
                        <button type="button" className="btn ghost sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Delete ${sub.title}`}
                        onClick={() => setConfirmDelete(sub.id)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button type="button" className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => createSubSession({ title: `Sub Session ${subCount + 1}` })}>
                + New sub session
              </button>
            </div>

            <div className="sec">
              <div className="sec-h">Shared brief</div>
              <textarea
                className="brief"
                value={brief}
                placeholder="One paragraph every agent in this council shares — the goal, the split, the open questions."
                onChange={(e) => { setBrief(e.target.value); setDirty(true); }}
              />
              <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!dirty} onClick={() => void save()}>
                Save brief
              </button>
            </div>
              </div>

              <div className="col">
            {agents.length > 0 ? (
              <div className="sec">
                <div className="sec-h">Orchestrator</div>
                {orchestratorAgentId ? (
                  <div className="member">
                    <span className="tag main">Orch</span>
                    <span className="who">
                      <b>{agents.find((a) => a.id === orchestratorAgentId)?.name ?? orchestratorAgentId}</b>
                      <span>Main Session is bound to this agent — it can council_send and council_stop.</span>
                    </span>
                    <button type="button" className="btn ghost sm" onClick={onClearOrchestrator}>Clear</button>
                  </div>
                ) : (
                  <>
                    <div className="empty">Designate an RSAT agent as the orchestrator: its identity binds to the Main Session and it gains tools to dispatch and stop the other agents.</div>
                    <div className="members" style={{ marginTop: 8 }}>
                      {freeAgents.map((ag) => (
                        <div className="member" key={ag.id}>
                          <span className="who">
                            <b>{ag.name}</b>
                            <span>{ag.providerId} · {ag.model}</span>
                          </span>
                          <button
                            type="button"
                            className={pickOrchestrator === ag.id ? 'btn' : 'btn ghost sm'}
                            onClick={() => setPickOrchestrator(pickOrchestrator === ag.id ? null : ag.id)}
                          >
                            {pickOrchestrator === ag.id ? 'Selected' : 'Select'}
                          </button>
                        </div>
                      ))}
                      {freeAgents.length === 0 ? (
                        <div className="empty">Every RSAT agent is already a member of this council.</div>
                      ) : null}
                    </div>
                    <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!pickOrchestrator} onClick={onDesignateOrchestrator}>
                      Designate as orchestrator
                    </button>
                  </>
                )}
              </div>
            ) : null}

            {agents.length > 0 ? (
              <div className="sec">
                <div className="sec-h">Dispatch an RSA/T agent into this council</div>
                <div className="members">
                  {freeAgents.map((ag) => (
                    <div className="member" key={ag.id}>
                      <span className="who">
                        <b>{ag.name}</b>
                        <span>{ag.providerId} · {ag.model}</span>
                      </span>
                      <button
                        type="button"
                        className={pickAgent === ag.id ? 'btn' : 'btn ghost sm'}
                        onClick={() => setPickAgent(pickAgent === ag.id ? null : ag.id)}
                      >
                        {pickAgent === ag.id ? 'Selected' : 'Select'}
                      </button>
                    </div>
                  ))}
                  {freeAgents.length === 0 ? (
                    <div className="empty">Every RSAT agent is already a member of this council.</div>
                  ) : null}
                </div>
                <textarea
                  className="brief"
                  style={{ minHeight: 56, marginTop: 10 }}
                  value={task}
                  placeholder="First task for this agent — it will be bound to the new sub session and start working."
                  onChange={(e) => setTask(e.target.value)}
                />
                <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!pickAgent} onClick={onDispatchAgent}>
                  Dispatch into a new sub session
                </button>
              </div>
            ) : null}

            {council.subs.length > 0 ? (
              <div className="sec">
                <div className="sec-h">Send message to a sub-session</div>
                <div className="empty" style={{ marginBottom: 8 }}>
                  The orchestrator uses council_send to message sub-sessions directly. You can also send a message here — it will be injected at the target's next round boundary.
                </div>
                <textarea
                  className="brief"
                  style={{ minHeight: 56 }}
                  value={task}
                  placeholder="Message to send to the selected sub-session..."
                  onChange={(e) => setTask(e.target.value)}
                />
                <div className="members" style={{ marginTop: 8 }}>
                  {council.subs.map((sub: Member, i: number) => (
                    <div className="member" key={sub.id}>
                      <span className="who">
                        <b>{sub.title}</b>
                        <span>{sub.agentId ? `agent ${sub.agentId}` : 'no agent'}</span>
                      </span>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={!task.trim()}
                        onClick={() => {
                          void invoke('council', 'sendMessage', { sessionId: sub.id, councilId, text: task.trim() });
                          setTask('');
                        }}
                      >
                        Send
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
