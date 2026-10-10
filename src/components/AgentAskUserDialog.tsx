import { useState, useEffect } from 'react';
import { CircleHelp, Loader2, Send } from './icons';

import type { AskAnswer, AskUserRequest } from '../types';
import { useStore } from '../store/useStore';
import { fetchPendingAskUser, extendAgentQuestion } from '../lib/api';
import { Modal } from './ui';

/**
 * ASK-USER card — the agent paused to ask the user 1..N questions
 * (agent__ask_user). Each question renders as text input or clickable choice
 * options; unanswered rows can be skipped explicitly. The answers resume the
 * paused tool call on the server.
 *
 * Mirrors AgentPermissionDialog: not dismissible via Escape/backdrop (the
 * agent is blocked waiting), and an unanswered batch auto-skips after the
 * wait window.
 */
export function AgentAskUserDialog() {
  const requests = useStore((state) => state.pendingAskUser);
  const submitAnswers = useStore((state) => state.submitAskUserAnswers);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);

  /**
   * C3 PERSISTENCE — the queue is SERVER-truth. The panel used to vanish on
   * a tab switch: the SSE frames that carry ask_user_request/result were
   * missed or replayed while hidden, and fetchPendingAskUser existed but was
   * never wired. Now: on mount AND whenever the tab becomes visible again,
   * reconcile against the server's pending list — a batch the server still
   * waits on is restored, a settled one is dropped honestly. Requests that
   * arrived DURING the fetch (newer than its start) are kept on top of the
   * fetched list so the race can never eat a fresh ask.
   */
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      const startedAt = Date.now();
      try {
        const fetched = await fetchPendingAskUser();
        if (cancelled) return;
        const state = useStore.getState();
        const arrivedDuring = state.pendingAskUser.filter((entry) => entry.createdAt >= startedAt - 1_500);
        const merged = [
          ...fetched,
          ...arrivedDuring.filter((entry) => !fetched.some((fetchedEntry) => fetchedEntry.id === entry.id)),
        ];
        state.setPendingAskUser(merged);
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

  /**
   * AUTO-SKIP PAUSE (C3) — the server's 10-min auto-skip cannot see browser
   * visibility: a tab switch used to let the batch time out unseen and the
   * panel vanished on return. While hidden, heartbeat each pending batch's
   * deadline forward (5-min interval < 10-min window, so it never lapses).
   * Visible tab: no heartbeat — ordinary behaviour, the clock runs normally.
   */
  useEffect(() => {
    if (requests.length === 0) return;
    let heartbeat: number | null = null;
    const extendAll = () => {
      for (const entry of useStore.getState().pendingAskUser) {
        void extendAgentQuestion(entry.id, 10 * 60 * 1000).catch(() => undefined);
      }
    };
    const start = () => {
      if (heartbeat !== null) return;
      extendAll();
      heartbeat = window.setInterval(extendAll, 5 * 60 * 1000);
    };
    const stop = () => {
      if (heartbeat === null) return;
      window.clearInterval(heartbeat);
      heartbeat = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') start();
      else stop();
    };
    if (document.visibilityState === 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [requests.length]);

  const request: AskUserRequest | undefined = requests[0];
  if (!request) return null;

  const buildPayload = (): AskAnswer[] =>
    request.questions.flatMap((question): AskAnswer[] => {
      const choiceIndex = selected[question.id];
      if (question.type === 'choice' && choiceIndex !== undefined) {
        return [{ id: question.id, answer: question.choices[choiceIndex] }];
      }
      const typed = texts[question.id]?.trim();
      if (typed) return [{ id: question.id, answer: typed }];
      return [{ id: question.id, skipped: true }];
    });

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitAnswers(request.id, buildPayload());
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Closing the card (X / Escape / backdrop / Skip) is an explicit SKIP-ALL:
   * the agent is paused waiting on this exact batch, so "just dismiss" must
   * still unblock it — the tool call resumes with every question marked
   * skipped and the model proceeds on stated assumptions. A bare
   * `onClose={() => undefined}` here made the X button dead: the card could
   * not be closed at all while the agent hung.
   */
  const skipAll = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitAnswers(request.id, request.questions.map((question) => ({ id: question.id, skipped: true })));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => void skipAll()}
      title="The agent has a question"
      size=""
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--faint)' }}>
            The agent is paused until you answer. Blank questions are skipped.
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void skipAll()}
            disabled={submitting}
          >
            Skip all
          </button>
          <button
            type="button"
            className="btn primary sm"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="ic spin" aria-hidden="true" />
            ) : (
              <Send className="ic" aria-hidden="true" />
            )}
            Send answers
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ marginTop: 2, borderRadius: 'var(--r-md)', background: 'rgb(var(--c-accent) / 0.1)', padding: 8 }}>
          <CircleHelp className="ic" style={{ width: 20, height: 20, color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
            {request.questions.length === 1
              ? 'The agent needs one answer to continue.'
              : `The agent needs ${request.questions.length} answers to continue.`}
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            It asked via <code style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '1px 4px', fontSize: 12 }}>agent__ask_user</code> —
            reply below, or leave a question blank to skip it.
          </p>
        </div>
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {request.questions.map((question, qIndex) => (
          <div key={question.id} className="card" style={{ borderRadius: 'var(--r-md)', padding: 12, background: 'rgb(var(--c-elev) / 0.4)' }}>
            <label
              htmlFor={`ask-${question.id}`}
              style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}
            >
              {qIndex + 1}. {question.question}
            </label>

            {question.type === 'choice' ? (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }} role="radiogroup" aria-label={question.question}>
                {question.choices.map((choice, cIndex) => {
                  const active = selected[question.id] === cIndex;
                  return (
                    <button
                      key={choice}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setSelected((prev) => ({ ...prev, [question.id]: cIndex }))}
                      className="btn ghost sm"
                      style={{
                        justifyContent: 'flex-start',
                        fontSize: 13,
                        fontWeight: 400,
                        borderColor: active ? 'rgb(var(--c-accent))' : 'var(--line)',
                        background: active ? 'var(--c-accent-soft)' : 'transparent',
                        color: active ? 'rgb(var(--c-ink))' : 'var(--muted)',
                      }}
                    >
                      {choice}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {(question.type === 'text' || question.allowCustom) && (
              <input
                id={`ask-${question.id}`}
                type="text"
                className="field"
                style={{ marginTop: 8, width: '100%', fontSize: 13 }}
                placeholder={question.type === 'choice' ? 'Or type your own answer...' : 'Your answer...'}
                value={texts[question.id] ?? ''}
                onChange={(event) => setTexts((prev) => ({ ...prev, [question.id]: event.target.value }))}
              />
            )}
          </div>
        ))}
      </div>

      {submitting ? (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }} role="status">
          <Loader2 className="ic spin" aria-hidden="true" />
          Sending answers...
        </div>
      ) : null}
    </Modal>
  );
}
