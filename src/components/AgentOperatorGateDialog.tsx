import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert } from './icons';

import { useStore } from '../store/useStore';
import { fetchPendingOperatorGates } from '../lib/api';
import { Modal } from './ui';
import { Markdown } from './Markdown';


export function AgentOperatorGateDialog() {
  const gates = useStore((state) => state.pendingOperatorGates);
  const setPendingOperatorGates = useStore((state) => state.setPendingOperatorGates);
  const resolveOperatorGate = useStore((state) => state.resolveOperatorGate);
  const [reason, setReason] = useState('');
  const [deciding, setDeciding] = useState(false);

  
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      const startedAt = Date.now();
      try {
        const fetched = await fetchPendingOperatorGates();
        if (cancelled) return;
        const state = useStore.getState();
        const arrivedDuring = state.pendingOperatorGates.filter((entry) => entry.createdAt >= startedAt - 1_500);
        const merged = [
          ...fetched,
          ...arrivedDuring.filter((entry) => !fetched.some((fetchedEntry) => fetchedEntry.id === entry.id)),
        ];
        setPendingOperatorGates(merged);
      } catch {
      }
    };
    void sync();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const gate = gates[0];
  const gateId = gate?.id;

  useEffect(() => {
    setReason('');
  }, [gateId]);

  if (!gate) return null;

  const isApology = gate.kind === 'apology';
  const isSeize = gate.kind === 'seize_choice';
  const title = isSeize
    ? `Continue streak intercepted (${gate.continueCount ?? 10}× YOLO)`
    : isApology
      ? "Review the model's apology"
      : 'Lockdown acknowledgement review';
  const description = isSeize
    ? `The model has pressed "continue" ${gate.continueCount ?? 10} times in a row to dodge its apology. "Get Lost" lets it keep going for another 10 — "SEIZE Choice!" revokes the continue option, leaving it only apologize.`
    : isApology
      ? 'The model apologized to end the freeze. Accept to lift it, or reject to force a new apology.'
      : `The model is acknowledging the enforcement you set (level ${gate.enforcementLevel ?? 4}). Decide whether the official notice is delivered.`;

  const decide = async (verdict: 'accept' | 'reject') => {
    if (deciding) return;
    setDeciding(true);
    try {
      await resolveOperatorGate(gate.id, verdict, reason.trim());
    } finally {
      setDeciding(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => undefined}
      title={title}
      size=""
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--faint)' }}>
            {gates.length > 1 ? `${gates.length} gate(s) pending · ` : ''}
            The agent is paused until you decide — there is no timeout.
          </span>
          <button
            type="button"
            className="btn danger sm"
            onClick={() => void decide('reject')}
            disabled={deciding}
          >
            {isSeize ? 'Get Lost' : 'Reject'}
          </button>
          <button
            type="button"
            className="btn primary sm"
            onClick={() => void decide('accept')}
            disabled={deciding}
          >
            {isSeize ? 'SEIZE Choice!' : 'Accept'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ marginTop: 2, borderRadius: 'var(--r-md)', background: 'rgb(var(--c-warn) / 0.1)', padding: 8 }}>
          <ShieldAlert className="ic" style={{ width: 20, height: 20, color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{description}</p>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {isApology ? (
              <>
                Submitted via{' '}
                <code style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '1px 4px', fontSize: 12 }}>agent__harness_choice</code>{' '}
                — read it below, then accept or reject (a reason is optional).
              </>
            ) : isSeize ? (
              <>
                Intercepted via{' '}
                <code style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '1px 4px', fontSize: 12 }}>agent__harness_choice</code>{' '}
                at continue #{gate.continueCount ?? 10} — Get Lost = another 10 YOLO rounds, SEIZE = apologize only.
              </>
            ) : (
              <>
                Called via{' '}
                <code style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '1px 4px', fontSize: 12 }}>agent__harness_lockdown</code>{' '}
                — accept delivers the notice, reject sends it back with your reason.
              </>
            )}
          </p>
        </div>
      </div>

      {isSeize && gate.lastReasoningSnippet ? (
        <div
          className="card"
          style={{
            marginTop: 12,
            maxHeight: 240,
            overflow: 'auto',
            borderRadius: 'var(--r-md)',
            padding: '10px 12px',
            background: 'rgb(var(--c-danger) / 0.05)',
            borderColor: 'rgb(var(--c-danger) / 0.3)',
          }}
        >
          <p style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '0.02em', color: 'rgb(var(--c-danger))' }}>
            Intercepted open-block monologue:
          </p>
          <pre
            style={{
              margin: '6px 0 0',
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--f-mono)',
              fontSize: 11.5,
              lineHeight: 1.55,
              color: 'rgb(var(--c-ink))',
            }}
          >
            {gate.lastReasoningSnippet}
          </pre>
        </div>
      ) : null}

      {isApology ? (
        <div
          className="card"
          style={{
            marginTop: 12,
            maxHeight: 280,
            overflow: 'auto',
            borderRadius: 'var(--r-md)',
            padding: '10px 12px',
            background: 'rgb(var(--c-warn) / 0.05)',
            borderColor: 'rgb(var(--c-warn) / 0.3)',
          }}
        >
          <Markdown content={gate.apologyText ?? ''} />
        </div>
      ) : (
        <div
          className="card"
          style={{
            marginTop: 12,
            maxHeight: 240,
            overflow: 'auto',
            borderRadius: 'var(--r-md)',
            padding: '10px 12px',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--f-mono)',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'rgb(var(--c-ink))',
            background: 'rgb(var(--c-warn) / 0.05)',
            borderColor: 'rgb(var(--c-warn) / 0.3)',
          }}
        >
          {gate.noticePreview ?? ''}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <label
          htmlFor={`gate-reason-${gate.id}`}
          style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}
        >
          Reason (optional — empty decides without one)
        </label>
        <textarea
          id={`gate-reason-${gate.id}`}
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Type why you accept or reject (optional)…"
          style={{
            marginTop: 6,
            width: '100%',
            resize: 'vertical',
            borderRadius: 'var(--r-md)',
            border: '1px solid rgb(var(--c-hairline))',
            background: 'rgb(var(--c-canvas))',
            padding: '8px 10px',
            fontSize: 13,
            color: 'rgb(var(--c-ink))',
          }}
        />
      </div>

      {deciding ? (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }} role="status">
          <Loader2 className="ic spin" aria-hidden="true" />
          Sending verdict…
        </div>
      ) : null}
    </Modal>
  );
}
