import { useCallback, useEffect, useRef } from 'react';

import { ApiError, coerceDelta, fetchConversationDetail, fetchJobRun, fetchLiveStreams, openBrowserPanelOnce, probeResume, streamChat, uploadAttachment } from '../lib/api';
import { ensureLivePolling, refreshLiveStreamsNow, subscribeLivePolls } from '../store/livePoller';
import {
  applyCompaction,
  COMPACT_INSTRUCTION,
  COMPACT_SYSTEM_INSTRUCTION,
  compactCandidate,
  contextPlan,
  estimateConversationContext,
  estimateTokens,
  isCheckpointShape,
  priceWireMessage,
  pruneRelieves,
  shouldAutoCompact,
  summarizationReplay,
  triggerForMeasuredTokens,
  wireUserContent,
  type CompactTrigger,
} from '../lib/compaction';
import { splitInlineThinking, stripInlineThinking } from '../lib/reasoning';
import { isGhostTurn } from '../lib/turns';
import { lookupModelMeta } from '../lib/modelMeta';
import { useStore, conversationsReady, providersReady } from '../store/useStore';
import type { ChatMessage, ChatSettings, Turn, TurnAttachment, TrustTier } from '../types';
import { storage, uid } from '../lib/storage';
import { scanOutput, tierCardContent, tierState, violationEvidence, violationsToTier } from '../lib/trust';

/**
 * MESSAGE ROUTING — the harness has ONE voice, and it is the catalog-backed
 * Notice Center (`showNotice`, the stack under the session name). Everything
 * the MACHINERY emits while it works goes there:
 * compaction (armed, folded, failed, busy), auto-resume of interrupted and
 * crashed runs, connection loss and provider retries, enforcement state.
 * Those messages are workspace-frame state — visible at a glance while a run
 * streams — and a corner toast that vanishes in two seconds is where
 * "Compacted 16 turns" went to die unnoticed.
 *
 * Validation of a DIRECT gesture ("pick a provider first", "already
 * generating — stop it first") rides the same surface (Fase A merged the old
 * Toast in): every message is a registered catalog id, so tone, ttl and
 * dedupe are decided once, in the catalog.
 */

/**
 * Mirrors the auto-title formula in `appendTurn` exactly.
 *
 * A degenerate first message (a stray keystroke like "t", an accidental Enter)
 * must never become a chat's permanent title. The retry ladder leaves dozens of
 * these in the sidebar after a stuck session: the empty ASSISTANT turn is
 * cleaned up, but the USER turn survives, its title sticks, and the record
 * syncs to the server as a real chat named "t". Require a little substance
 * before a message earns the title; otherwise keep the neutral placeholder the
 * user can rename.
 */
function autoTitleFor(firstUserMessage: string): string {
  const text = firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 52);
  if (text.length >= 4) return text;
  return 'New chat';
}

/**
 * Summarizes every turn except the newest protected window and stores
 * the result as the conversation's compaction. The primary call replays the
 * wire prefix (KV-cache-friendly) on the session model — or the dedicated
 * Summarizer Model when configured — with one degraded elided-transcript
 * retry as the safety net. Returns null when there is nothing to condense, or
 * a `CompactionFailure` when the summarization request itself was refused —
 * the two are NOT the same thing, and conflating them made a provider that
 * rejects an oversized transcript answer "Nothing to compact yet" while the
 * context stayed 95% full.
 */
export interface CompactionFailure {
  /** The provider's refusal, verbatim — enough to tell the user what to fix. */
  message: string;
}

async function runCompaction(input: {
  conversationId: string;
  providerId: string;
  model: string;
  settings: ChatSettings;
  apiKey?: string;
  trigger: Exclude<CompactTrigger, null>;
  /** /compact [instructions] — user-supplied focus for the checkpoint. */
  focus?: string;
  /** MODEL-FREE PRE-PASS armed: build the replay from a pruned wire. */
  prune?: boolean;
  /** Wired from the generation's controller so Stop works during the
   * pre-send summarization too. */
  signal?: AbortSignal;
}): Promise<
  { covered: number; replacedTokens: number; prePassed?: boolean } | CompactionFailure | null
> {
  if (useStore.getState().compactingId) return null;
  useStore.getState().setCompacting(input.conversationId);
  try {
    return await runCompactionInner(input);
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    return { message: message || 'The summarization request failed.' };
  } finally {
    useStore.getState().setCompacting(null);
  }
}

async function runCompactionInner(input: {
  conversationId: string;
  providerId: string;
  model: string;
  settings: ChatSettings;
  apiKey?: string;
  trigger: Exclude<CompactTrigger, null>;
  /** /compact [instructions] — user-supplied focus for the checkpoint. */
  focus?: string;
  /** MODEL-FREE PRE-PASS armed: build the replay from a pruned wire. */
  prune?: boolean;
  /** Wired from the generation's controller so Stop works during the
   * pre-send summarization too. */
  signal?: AbortSignal;
}): Promise<
  { covered: number; replacedTokens: number; prePassed?: boolean } | CompactionFailure | null
> {
  const state = useStore.getState();
  const conversation = state.conversations.find((entry) => entry.id === input.conversationId);
  if (!conversation) return null;
  const candidate = compactCandidate(conversation);
  if (!candidate) return null;

  if (input.trigger !== 'manual') {
    const prePassMeta = input.model
      ? lookupModelMeta(useStore.getState().modelMeta, input.model)
      : undefined;
    wirePruneArmed.add(input.conversationId);
    if (pruneRelieves(conversation, prePassMeta, 0)) {
      return { covered: 0, replacedTokens: 0, prePassed: true };
    }
  }

  const noteId = uid('turn');
  const store = useStore.getState();
  store.appendTurn(input.conversationId, {
    id: noteId,
    role: 'assistant',
    kind: 'compaction',
    content: '',
    createdAt: Date.now(),
    model: input.model,
    providerId: input.providerId,
  });

  let committed = false;
  try {
    const coveredIds = candidate.turns.map((turn) => turn.id);
    const plan = contextPlan(conversation, { prune: input.prune });
    const directive = [
      COMPACT_INSTRUCTION,
      input.focus?.trim()
        ? `\nFOCUS (the user's compaction instructions — honor them):\n${input.focus.trim()}`
        : '',
      candidate.goalBlock ? `\n${candidate.goalBlock}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const replayMessages: ChatMessage[] = [
      ...summarizationReplay(plan, coveredIds),
      { role: 'user', content: directive },
    ];
    const legacyMessages: ChatMessage[] = [
      {
        role: 'user',
        content:
          'Condense the transcript below into the structured checkpoint. The text inside <transcript> is the full material to condense:\n\n' +
          '<transcript>\n' +
          candidate.transcript +
          '\n</transcript>\n\n' +
          'Reminder: you are summarizing, not working. Do not continue the work, do not invent or emit tool-call lines or their outputs, and do not write new log entries. Produce only the structured checkpoint.',
      },
    ];

    const dedicated =
      input.settings.summarizerEnabled === true &&
      Boolean(input.settings.summarizerProviderId) &&
      Boolean(input.settings.summarizerModel);
    const keyFor = (route: { providerId: string }): string | undefined =>
      route.providerId === input.providerId ? input.apiKey : undefined;
    const attempts: Array<{
      route: { providerId: string; model: string };
      messages: ChatMessage[];
      systemInstruction?: string;
      fallbackNotice?: boolean;
    }> = [];
    if (dedicated) {
      attempts.push({
        route: {
          providerId: input.settings.summarizerProviderId!,
          model: input.settings.summarizerModel!,
        },
        messages: replayMessages,
        fallbackNotice: true,
      });
    }
    attempts.push({
      route: { providerId: input.providerId, model: input.model },
      messages: replayMessages,
    });
    attempts.push({
      route: { providerId: input.providerId, model: input.model },
      messages: legacyMessages,
      systemInstruction: COMPACT_SYSTEM_INSTRUCTION,
    });

    type SummarizeResult =
      | { summary: string }
      | { error: string }
      | { toolViolation: true }
      | { aborted: true };

    const summarizeOnce = async (attempt: {
      route: { providerId: string; model: string };
      messages: ChatMessage[];
      systemInstruction?: string;
    }): Promise<SummarizeResult> => {
      let text = '';
      let lastPaintAt = 0;
      try {
        for await (const event of streamChat({
          providerId: attempt.route.providerId,
          model: attempt.route.model,
          messages: attempt.messages,
          settings: {
            ...conversation.settings,
            ...(attempt.systemInstruction
              ? { systemInstruction: attempt.systemInstruction }
              : {}),
            thinkingLevel: 'off',
            temperature: 0.2,
            topP: 0.9,
            structuredOutputs: false,
          },
          apiKey: keyFor(attempt.route),
          signal: input.signal,
          compaction: true,
        })) {
          if (input.signal?.aborted) return { aborted: true };
          if (event.type === 'text') {
            text += event.delta ?? '';
            const now = Date.now();
            if (now - lastPaintAt > 120) {
              lastPaintAt = now;
              useStore.getState().updateTurn(input.conversationId, noteId, { content: text });
            }
          } else if (event.type === 'error') {
            return { error: event.message ?? 'The summarization request failed.' };
          } else if (event.type === 'tool_call' || event.type === 'tool_result') {
            return { toolViolation: true };
          }
        }
        return { summary: text };
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return { aborted: true };
        }
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };

    let summary = '';
    let resolved = false;
    let lastError = '';
    for (const attempt of attempts) {
      const result = await summarizeOnce(attempt);
      if ('aborted' in result) return null;
      if ('summary' in result) {
        const trimmed = stripInlineThinking(result.summary).trim();
        if (trimmed) {
          summary = trimmed;
          resolved = true;
          break;
        }
        lastError = 'The model returned an empty checkpoint.';
      } else if ('toolViolation' in result) {
        lastError = 'The model tried to call a tool during summarization.';
      } else {
        lastError = result.error;
      }
      if (attempt.fallbackNotice) {
        useStore.getState().showNotice('compact.summarizerFallback');
      }
    }
    if (!resolved) {
      return { message: lastError || 'The summarization request failed.' };
    }

    if (!isCheckpointShape(summary)) {
      return {
        message:
          'The model did not return a structured checkpoint (required sections missing — it likely replayed the transcript instead of condensing it). Nothing was replaced; compact again or switch models.',
      };
    }
    const summaryTokens = estimateTokens(summary);
    if (summaryTokens >= candidate.replacedTokens) {
      return {
        message: `The checkpoint did not shrink the covered material (~${summaryTokens} vs ~${candidate.replacedTokens} source tokens) — nothing was replaced. Compact again or switch models.`,
      };
    }

    committed = true;
    useStore.getState().setCompaction(
      input.conversationId,
      applyCompaction(conversation, {
        summary,
        coveredTurnIds: coveredIds,
        replacedTokens: candidate.replacedTokens,
      }, input.trigger).compaction,
    );
    useStore.getState().updateTurn(input.conversationId, noteId, {
      content: summary,
      compactionMeta: {
        covered: candidate.turns.length,
        replacedTokens: candidate.replacedTokens,
        trigger: input.trigger,
      },
    });
    return { covered: candidate.turns.length, replacedTokens: candidate.replacedTokens };

  } finally {
    if (!committed) useStore.getState().deleteTurn(input.conversationId, noteId);
  }
}

/**
 * finishReason values that mean "the run was cut short" — a harness-forced
 * wrap-up (context budget / stall) or a provider output cut.
 * Surfaced on the turn: a cut run must never masquerade as a natural end.
 * (`tool_errors` is surfaced too, but it is NOT in this set — it marks a run
 * that stopped naturally with failed tools aboard, not a cut run.)
 */
const FORCED_FINISH_REASONS = new Set([
  'context_budget',
  'stalled',
  'length',
  'max_tokens',
  'MAX_TOKENS',
]);

/**
 * Asks the model for a short conversation title and applies it. Runs in the
 * background after the first exchange; failures are silent because the
 * first-message fallback title is already in place. The rename only lands if
 * the thread still carries the expected auto title — an explicit user rename
 * always wins, no matter when it happened.
 */
async function generateConversationTitle(input: {
  conversationId: string;
  providerId: string;
  model: string;
  settings: ChatSettings;
  apiKey?: string;
  userMessage: string;
  assistantReply: string;
  expectedTitle: string;
}): Promise<void> {
  try {
    let raw = '';
    for await (const event of streamChat({
      providerId: input.providerId,
      model: input.model,
      messages: [
        {
          role: 'user',
          content:
            'Buat judul singkat untuk percakapan berikut: maksimal 6 kata, tanpa tanda kutip, ' +
            'tanpa titik di akhir, dalam bahasa yang sama dengan pesan pengguna. ' +
            'Balas HANYA judulnya, tanpa teks lain.\n\n' +
            `Pengguna: ${input.userMessage.replace(/\s+/g, ' ').slice(0, 500)}\n` +
            `Asisten: ${stripInlineThinking(input.assistantReply).replace(/\s+/g, ' ').slice(0, 300)}`,
        },
      ],
      settings: {
        ...input.settings,
        systemInstruction: '',
        thinkingLevel: 'off',
        temperature: 0.3,
        topP: 0.9,
        maxOutputTokens: 2048,
      },
      apiKey: input.apiKey,
    })) {
      if (event.type === 'text') raw += event.delta ?? '';
      if (event.type === 'error') return;
    }

    const title = stripInlineThinking(raw)
      .split('\n')[0]
      .replace(/^["'“”\s]+|["'“”.\s]+$/g, '')
      .trim()
      .slice(0, 60);
    if (!title) return;

    const state = useStore.getState();
    const conversation = state.conversations.find((entry) => entry.id === input.conversationId);
    if (!conversation || conversation.title !== input.expectedTitle) return;
    state.renameConversation(input.conversationId, title);
  } catch {
  }
}

/**
 * TURN ID OWNERSHIP — adopt the server-echoed turn id for this run.
 *
 * The stream_id frame (the first frame, and part of the replay buffer) echoes
 * the run's assistant turn id. Every consumer of the run must paint into THAT
 * id: the originating tab already holds it; a re-attaching tab (reload boot
 * resume, live-loop sweep in a second tab) replays the frame and adopts it —
 * so its patches REPLACE the original turn instead of APPENDING a duplicate
 * reply to the shared record.
 *
 * `current` is the turn this tab is about to paint into. When it already
 * matches the echoed id (the original tab, or a re-attach that found the run's
 * own trailing turn), the id stands. When this tab minted its own empty turn
 * (a fresh send pre-creating the reply card, a continue-only reuse) it is
 * swapped: the empty husk is tombstoned + dropped and a fresh turn under the
 * SERVER id is appended — a turn with real content already painted is kept
 * (that cannot be the shape at stream start; the guard only stops the
 * pathological case from losing work).
 *
 * Returns the id every subsequent updateTurn/flush must address. The caller
 * assigns the return value to its `assistantTurn` reference immediately — the
 * stream's text/reasoning/tool handlers and the flush schedule read that
 * reference on every event.
 */
function adoptServerTurnId(
  conversationId: string,
  turnId: string | undefined,
  current: { id: string },
): string {
  if (!turnId || turnId === current.id) return current.id;
  const state = useStore.getState();
  const conversation = state.conversations.find((entry) => entry.id === conversationId);
  const local = conversation?.turns.find((turn) => turn.id === current.id);
  const empty =
    !local ||
    (local.role === 'assistant' &&
      !local.content &&
      !local.reasoning &&
      !(local.segments && local.segments.length) &&
      !local.error &&
      !local.usage);
  if (!empty) return current.id;
  if (local) state.dropTurns(conversationId, [local.id]);
  const adopted: import('../types').Turn = {
    id: turnId,
    role: 'assistant',
    content: '',
    reasoning: '',
    createdAt: Date.now(),
    model: local?.model,
    providerId: local?.providerId,
  };
  state.appendTurn(conversationId, adopted);
  return turnId;
}

/**
 * Owns the request lifecycle for the chat thread.
 *
 * Generations are tracked PER CONVERSATION (store.genRunning + one abort
 * controller each), so several chats can generate at once — the limit is the
 * provider's, not the UI's. Stop cancels whichever conversation is active;
 * a conversation with a generation in flight refuses new sends until it
 * finishes or is stopped.
 */
/**
 * Module-level abort registry. The controller hook is instantiated by MORE
 * than one component (App for the composer, Thread for the continue action),
 * and every instance must see the SAME controllers — a per-hook useRef would
 * register a generation under one instance while `stop()` looked it up in
 * another, leaving Stop unable to cancel anything.
 */
const abortsRef: { current: Map<string, AbortController> } = {
  current: new Map<string, AbortController>(),
};

/**
 * TRANSIENT CONNECTION LOSS — the signatures of a proxy that died or is
 * restarting UNDER the user (supervisor reload, crash, network blip), as
 * opposed to a provider rejecting the request. Only these earn the one-shot
 * automatic resume; provider errors never retry themselves.
 */
const CONNECTION_LOSS_PATTERN =
  /cannot reach the local moriko proxy|failed to fetch|fetch failed|networkerror|network error|socket hang up|econn(?:refused|reset|aborted)|premature close|other side closed|terminated/i;

function isConnectionLoss(message: string): boolean {
  return CONNECTION_LOSS_PATTERN.test(message);
}

/**
 * One automatic resume per conversation, shared by every hook instance.
 * Set while a reconnect-resume is in flight; cleared once a stream ends
 * without a connection loss, so the budget never chains retries.
 */
const autoRetryPending: { current: Set<string> } = {
  current: new Set<string>(),
};

/**
 * MODEL-FREE PRE-PASS state: conversations whose wire is currently rendered
 * in pruned form (tighter tool digests, images offloaded). Armed when
 * pressure trips and a reduced wire is what keeps the context under the
 * trigger; disarmed on a send where the FULL wire fits again.
 */
const wirePruneArmed = new Set<string>();

/**
 * One RESUME attempt per conversation at a time, shared across hook
 * instances (StrictMode double-mount, HMR remounts): two concurrent
 * re-attaches would each reset the turn and replay the same frames twice.
 */
const resumeInFlight = new Set<string>();

/**
 * Conversations with a stream THIS TAB is currently consuming (the original
 * POST or a resume replay). Maintained by send() around the whole stream
 * lifecycle; the live-loop below reads it so its re-attach and honesty
 * sweeps never fight a stream that is already attached here.
 */
const attachedConversations = new Set<string>();

/**
 * Conversations the user pressed STOP on, with the stream id they stopped
 * (`null` when the resume handle never arrived).
 *
 * STOP MUST BE STICKY. An abort is a fire-and-forget POST, and the registry
 * deliberately keeps a run alive inside its grace window when nobody is
 * attached — which is exactly the orphan the re-attach sweep below exists to
 * heal. Without this record the sweep faithfully re-attached to the run the
 * user had just cancelled: measured, six seconds after Stop the client was
 * consuming the stream again, the badge was back, and the provider was still
 * being billed for a generation the user had ended.
 *
 * An entry is dropped once the registry no longer lists that stream (the run
 * really is gone) or once a DIFFERENT, newer stream owns the conversation, so
 * the next generation in that chat is never blocked.
 */
const stoppedStreams = new Map<string, string | null>();

/**
 * A compaction asked for WHILE the run was streaming.
 *
 * A request already in flight cannot have its context rewritten — the model is
 * reading the very tokens a summary would replace — so the only honest moment
 * to compact is the NEXT round. The ask is recorded here, the current round is
 * closed, and the run continues on the compacted context as soon as the turn
 * settles. Refusing instead (the old behaviour) made the user stop the work
 * they were trying to keep, and let a run finish on a context that was already
 * over its limit.
 */
const pendingMidRunCompaction = new Map<string, Exclude<CompactTrigger, null>>();

/**
 * ONE mid-run compaction per generation. A compaction that cannot get the
 * context back under the limit — reasoning is never pruned, and a window can
 * be smaller than the turns that must stay — would otherwise re-arm on the
 * very next round and burn a summarization request every round, forever.
 * Cleared when a NEW user message starts a generation.
 */
const midRunCompactedThisRun = new Set<string>();

/**
 * Conversations the user explicitly STOPPED. Distinct from `genRunning`, which
 * a mid-run compaction clears too: a Stop pressed while the summarizer runs
 * must never be answered with "continuing…".
 */
const userStoppedRuns = new Set<string>();

/**
 * Set at the very END of a stream's finally — after the turn is written and
 * every post-processing branch has run. A mid-run compaction waits for THIS
 * rather than for `attachedConversations` to empty (that happens ~370 lines
 * earlier, while the finally still has a turn to finish writing) or for
 * `genRunning` to clear (same problem). Only set when a compaction is actually
 * waiting, so it never accumulates.
 */
const runSettled = new Set<string>();

/**
 * Report the outcome of one compaction on the Notice Center, whichever path
 * asked for it. MESSAGE ROUTING (contract at the top of this file): compaction
 * is machinery, so its outcome rides the stack under the session name. The old
 * corner toast here is exactly how "Compacted 16 turns" went unseen at the
 * bottom of the workspace while the run kept streaming.
 */
async function compactAndReport(
  conversationId: string,
  providerId: string,
  model: string,
  trigger: Exclude<CompactTrigger, null>,
  focus?: string,
): Promise<void> {
  const conversation = useStore.getState().conversations.find((entry) => entry.id === conversationId);
  if (!conversation) return;
  const outcome = await runCompaction({
    conversationId,
    providerId,
    model,
    settings: conversation.settings,
    trigger,
    focus,
    prune: wirePruneArmed.has(conversationId),
  });
  const showNotice = useStore.getState().showNotice;
  if (outcome && 'covered' in outcome) {
    if (outcome.prePassed) {
      showNotice('compact.prePassed');
    } else {
      showNotice('compact.manualDone', { turns: outcome.covered });
    }
  } else if (outcome && 'message' in outcome) {
    showNotice('compact.failedReason', { message: outcome.message });
  } else if (trigger === 'manual') {
    showNotice('compact.nothing');
  }
}

/**
 * Ask for a compaction that lands on the NEXT round: close the current round
 * now and continue on the compacted context once the turn settles.
 *
 * This is what makes "Compact now" work mid-generation, and what lets the
 * context-limit trigger fire the moment a ROUND reports it is over the limit
 * instead of waiting for the next send.
 */
function requestMidRunCompaction(
  conversationId: string,
  trigger: Exclude<CompactTrigger, null>,
): void {
  if (pendingMidRunCompaction.has(conversationId)) return;
  if (midRunCompactedThisRun.has(conversationId)) {
    if (trigger === 'manual') {
      useStore
        .getState()
        .showNotice('compact.alreadyCompacted');
    }
    return;
  }
  const current = useStore.getState().conversations.find((entry) => entry.id === conversationId);
  if (!current || !compactCandidate(current)) {
    if (trigger === 'manual') {
      useStore.getState().showNotice('compact.nothing');
    }
    return;
  }
  pendingMidRunCompaction.set(conversationId, trigger);
  midRunCompactedThisRun.add(conversationId);
  useStore
    .getState()
    .showNotice(trigger === 'manual' ? 'compact.scheduledManual' : 'compact.scheduledAuto');

  const record = storage.loadStreamIds()[conversationId];
  if (record) {
    void fetch(`/api/chat/stream/${encodeURIComponent(record.streamId)}/abort`, {
      method: 'POST',
    }).catch(() => undefined);
    storage.clearStreamId(conversationId);
  }
  autoRetryPending.current.delete(conversationId);
  useStore.getState().setGenRunning(conversationId, false);
  abortsRef.current.get(conversationId)?.abort();

  void settleMidRunCompaction(conversationId);
}

/** Waits for the turn to settle, compacts, then continues the run. */
async function settleMidRunCompaction(conversationId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!runSettled.has(conversationId) && Date.now() < deadline) {
    const state = useStore.getState();
    if (!attachedConversations.has(conversationId) && !state.genRunning[conversationId]) {
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      const settled = useStore.getState();
      if (!attachedConversations.has(conversationId) && !settled.genRunning[conversationId]) break;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  runSettled.delete(conversationId);
  const trigger = pendingMidRunCompaction.get(conversationId);
  if (!trigger) return;
  pendingMidRunCompaction.delete(conversationId);

  const state = useStore.getState();
  const conversation = state.conversations.find((entry) => entry.id === conversationId);
  const providerId = conversation?.providerId || state.providerId;
  const provider = state.providers.find((entry) => entry.id === providerId);
  const model = conversation?.model || state.model;
  if (!conversation || !provider || !model) return;

  const busyDeadline = Date.now() + 90_000;
  while (useStore.getState().compactingId && Date.now() < busyDeadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  await compactAndReport(conversationId, provider.id, model, trigger).catch(() => undefined);

  if (userStoppedRuns.has(conversationId)) return;
  if (useStore.getState().genRunning[conversationId]) return;
  if (!(await serverRunGone(conversationId))) {
    useStore
      .getState()
      .showNotice('compact.continueHint');
    return;
  }
  await sendForLiveLoop?.('', conversationId, undefined, { continueOnly: true });
}

/** Polls the server registry until this conversation has no live run (bounded). */
async function serverRunGone(conversationId: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const streams = await fetchLiveStreams();
    if (streams === null) return true;
    if (!streams.some((entry) => entry.conversationId === conversationId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}

/**
 * When a conversation has been locally flagged "generating" while the
 * server's registry lists NO live stream for it, remember when we FIRST saw
 * that condition. Only a flag that stays orphaned past ORPHANED_FLAG_MS is
 * cleared by the honesty sweep — a brief registry gap (the instant between
 * one agent goal-loop round ending and the next starting) must never flick
 * the badge off, and a single failed poll must not be trusted either.
 */
const orphanedSince = new Map<string, number>();
const ORPHANED_FLAG_MS = 9_000;

/**
 * P3 DISIPLIN RE-ATTACH — a cooldown and an attempt BUDGET per conversation.
 *
 * The audit's waterfall showed the re-attach sweep re-firing against the same
 * stubborn stream on every poll tick (each attempt = a full resume replay:
 * the server re-sends the frame buffer from frame one). A stream that keeps
 * refusing the replay (grace-window expiry mid-replay, a wedged run) must not
 * become a request generator of its own.
 *
 *   COOLDOWN   — one attempt per REATTACH_COOLDOWN_MS per conversation.
 *   BUDGET     — after REATTACH_MAX_ATTEMPTS the sweep gives up on that
 *                stream; the user's explicit Continue is the recovery path.
 *                The registry dropping the stream (or a fresh user send in
 *                that chat) resets the counters.
 */
const REATTACH_COOLDOWN_MS = 8_000;
const REATTACH_MAX_ATTEMPTS = 3;
const resumeAttemptAt = new Map<string, number>();
const resumeAttempts = new Map<string, number>();

/**
 * LIVE-FOLLOW — convergence WITHOUT local mutation.
 *
 * A tab that never mutates never syncs, and the fold (the only mechanism that
 * pulls another writer's record into this tab) only runs inside a sync
 * response — so an idle second browser stayed frozen on a pre-run thread even
 * though the server's record was current (the turn patches kept landing; the
 * server's turn mirror now guarantees they land). The live-loop's snapshot
 * closes this: while the registry lists a stream for a conversation this tab
 * HOLDS but is not consuming, the body is refreshed on a bounded cadence; when
 * the stream LEAVES the snapshot (the run finished or died), one final refresh
 * pulls the terminal state. This is what makes the frozen thread heal —
 * refresh, budget-given-up re-attach, or simply watching from another tab —
 * without the user sending a message first.
 */
const FOLLOW_CADENCE_MS = 5_000;
const followRefreshAt = new Map<string, number>();
/** Conversations listed live on the PREVIOUS tick but not the current one. */
const followPreviouslyLive = new Set<string>();

function resetFollowBookkeeping(conversationId: string): void {
  followRefreshAt.delete(conversationId);
}

async function followRefreshBody(conversationId: string): Promise<void> {
  const store = useStore.getState();
  const local = store.conversations.find((entry) => entry.id === conversationId);
  if (!local) return;
  const fetched = await fetchConversationDetail(conversationId);
  if (!fetched) return;
  if (attachedConversations.has(conversationId)) return;
  useStore.getState().adoptFetchedBody(fetched);
}

/** Clears the re-attach bookkeeping when a FRESH run starts in the chat. */
function resetReattachBookkeeping(conversationId: string): void {
  resumeAttemptAt.delete(conversationId);
  resumeAttempts.delete(conversationId);
  resetFollowBookkeeping(conversationId);
}

/** The send closure the live-loop re-attaches with (assigned by the hook). */
let sendForLiveLoop:
  | ((
      text: string,
      conversationId: string,
      attachments?: unknown,
      opts?: { resumeStreamId?: string; continueOnly?: boolean },
    ) => Promise<void>)
  | null = null;
let liveLoopStarted = false;

/**
 * BOOT-RECONCILE ONCE-PER-PAGE — the module-level guard that keeps the boot
 * reconcile effect running ONCE per page load. The hook is instantiated by
 * FOUR components (App composer, Thread continue, SettingsPanel probation +
 * enforcement): a per-instance `resumeBooted` ref let mid-run mounting of a
 * fresh instance (the right dock's first open) re-attach to a stream the App
 * instance was already streaming — the double resume replay that reset the
 * trailing turn, snapped the activity pill shut, and historically duplicated
 * turns. Boot reconcile is a page-load concern, not an instance concern.
 */
let bootReconcileDone = false;

/**
 * AUTO-CONTINUE budget: one automatic continuation per interrupted agent
 * run, keyed by conversation, for the lifetime of this page load. A reload
 * that finds a dead generation must RESTART THE WORK (the user's explicit
 * ask: after a reload the agent keeps going), but a second dead run in the
 * same load means something is genuinely wrong — the thread goes back to
 * the user then, never an endless loop.
 */
const autoContinueFired = new Set<string>();

/**
 * PROVIDER ERROR RETRY LADDER — when the provider itself errors ("Generation
 * failed", "Inference request failed", upstream 5xx, …) the harness retries
 * up to 10 times on the SAME conversation history, with the exact spacing the
 * user specified. Connection loss has its own (faster) one-shot path below.
 */
const PROVIDER_RETRY_DELAYS_MS = [2_000, 4_000, 6_000, 12_000, 14_000, 16_000, 32_000, 34_000, 36_000, 60_000];

/**
 * Retry budget per conversation, shared by every hook instance. A retry
 * budget is separate from the connection-loss budget: provider retries and
 * reconnect-resumes each have their own counter, and both are cleared once a
 * stream ends cleanly.
 */
const providerRetries: { current: Map<string, number> } = {
  current: new Map<string, number>(),
};

/**
 * The last provider failure we retried through, per conversation. A retry
 * only ever makes sense when something about the attempt can change. On a
 * continue/retry the rebuilt wire is byte-identical to the previous one (the
 * empty turn is dropped and `contextPlan` reassembles the same message list),
 * so the SAME rejection arriving twice means the provider is refusing this
 * exact payload — a third, fourth and tenth request are guaranteed to fail
 * identically. That is the infinite "Inference request failed" loop: break
 * it as soon as the failure repeats.
 */
const lastProviderFailure: { current: Map<string, string> } = {
  current: new Map<string, string>(),
};

/**
 * Provider-level failure signatures that earn the retry ladder (as opposed to
 * a proxy that died under the user — that is `isConnectionLoss`). The wire
 * error strings arrive from /api/chat's `error` event and from the ApiError
 * thrown by streamChat's fetch wrapper.
 *
 * `upstream failure` / `upstream error` are the transient gateway errors some
 * OpenAI-compatible providers (Atria's api.atria-asi.ai is the documented case)
 * emit mid-stream in their own SSE error frame — the model already did real
 * work, then the provider's upstream dropped that one round. Nothing about the
 * request was wrong, so it is transient by nature and belongs on the ladder.
 * Before these strings were recognized, the failure matched NEITHER pattern:
 * no retry ladder AND no honest stop, so a one-off upstream blip landed as a
 * permanent "Generation failed" card the user had to clear by hand.
 */
const PROVIDER_ERROR_PATTERN =
  /generation failed|inference request failed|upstream failure|upstream error|upstream request failed|fetch failed|failed to fetch|internal server error|bad gateway|service unavailable|gateway timeout|server error|timeout|aborted|empty response/i;

/**
 * DETERMINISTIC failures: the provider examined this exact request and
 * refused it. Retrying an unchanged payload cannot help — context-length,
 * quota/billing, auth, model-not-found and malformed-request errors say "this
 * will fail every time", and retrying them 10× only burns tokens/time and
 * spins the loop the user is reporting. These earn an immediate honest stop,
 * never the ladder.
 *
 * Generic 5xx/"inference request failed"/timeout strings stay ambiguous, so
 * they keep the transient treatment (the ladder) — the provider could be
 * momentarily overloaded.
 */
const DETERMINISTIC_ERROR_PATTERN =
  /context(?:\s+window)?(?:\s+length)?(?:\s+exceed|\btoo\s+long)|maximum\s+context|token\s+limit|maximum.{0,20}tokens|request\s+(?:too\s+large|rejected)|payload\s+too\s+large|insufficient(?:\s+(?:quota|balance|credits|funds))?|rate\s+limit|too\s+many\s+requests|exceeded your current quota|billing|payment\s+required|invalid(?:_api)?_?key|incorrect api key|unauthorized|forbidden|model.{0,20}(?:not found|deprecat)|does not exist|not supported|unsupported|invalid request|malformed|bad request|\b4xx\b|\b400\b|\b401\b|\b402\b|\b403\b|\b404\b|\b413\b|\b429\b/i;

function isDeterministicError(message: string): boolean {
  if (!message) return false;
  return DETERMINISTIC_ERROR_PATTERN.test(message);
}

function isProviderError(message: string): boolean {
  if (!message) return false;
  if (isConnectionLoss(message)) return false;
  return PROVIDER_ERROR_PATTERN.test(message);
}

/** Retry ladder timing now lives in the catalog (provider.retryLadder). */

export function useChatController() {
  // NOTE: this hook deliberately does NOT subscribe to the whole
  const activeId = useStore((state) => state.activeId);
  const appendTurn = useStore((state) => state.appendTurn);
  const updateTurn = useStore((state) => state.updateTurn);
  const newConversation = useStore((state) => state.newConversation);
  const showNotice = useStore((state) => state.showNotice);
  const providers = useStore((state) => state.providers);
  const providerId = useStore((state) => state.providerId);
  const model = useStore((state) => state.model);

  const stop = useCallback(() => {
    const id = useStore.getState().activeId;
    if (!id) return;
    const record = storage.loadStreamIds()[id];
    stoppedStreams.set(id, record?.streamId ?? null);
    userStoppedRuns.add(id);
    useStore.getState().markRunStopped(id);
    refreshLiveStreamsNow();
    if (record) {
      void fetch(`/api/chat/stream/${encodeURIComponent(record.streamId)}/abort`, { method: 'POST' }).catch(
        () => undefined,
      );
      storage.clearStreamId(id);
    }
    autoRetryPending.current.delete(id);
    useStore.getState().setGenRunning(id, false);
    abortsRef.current.get(id)?.abort();
  }, []);

  /** Stop an arbitrary conversation by id — mirrors stop() but parameterized.
   * Used by the council orchestrator's council_stop tool: the server aborts the
   * upstream stream via api.sessions.abort, then publishes council:stopped on
   * the bus; the panel bridges it to a window event App.tsx catches and calls
   * this. */
  const stopRun = useCallback((conversationId: string) => {
    const id = conversationId;
    const record = storage.loadStreamIds()[id];
    stoppedStreams.set(id, record?.streamId ?? null);
    userStoppedRuns.add(id);
    useStore.getState().markRunStopped(id);
    refreshLiveStreamsNow();
    if (record) {
      void fetch(`/api/chat/stream/${encodeURIComponent(record.streamId)}/abort`, { method: 'POST' }).catch(
        () => undefined,
      );
      storage.clearStreamId(id);
    }
    autoRetryPending.current.delete(id);
    useStore.getState().setGenRunning(id, false);
    abortsRef.current.get(id)?.abort();
  }, []);

  /**
   * RESUME OF A CRASHED RUN — the user picked up the thread after the proxy
   * died mid-agent-run. The conversation still holds everything the run
   * produced; this re-sends it with `resumeFrom` set, and the server's
   * idempotency map makes sure not one mutating tool executes a second time
   * (see docs/ARCHITECTURE.md). The banner state clears; a new run id is
   * recorded as soon as the next stream_id frame lands.
   */
  const resumeCrashedRun = useCallback((conversationId: string, runId: string) => {
    useStore.getState().setCrashedRun(conversationId, null);
    void send('', conversationId, undefined, { continueOnly: true, resumeFrom: runId });
  }, []);

  /**
   * PROBATION REVIEW — DETECTION ONLY, run once per completed output.
   *
   * The ladder is MANUAL: this scan NEVER writes trust state. A violation
   * surfaces as a harness pop naming what was flagged and the rung it would
   * deserve; raising the tier is the operator's click in the panel. (The old
   * auto-escalation — monotonic climb, repeat-plus-one, the tier-4 freeze card
   * mutated onto the offending reply — is gone by design, not by accident: a
   * regex classifier was sentencing the conversation without anyone asking.)
   *
   * Detection still matters: it is the operator's sight. Without it the manual
   * stepper is a dial with no gauge.
   */
  const reviewOutput = useCallback((conversationId: string, output: string) => {
    const conversation = useStore.getState().conversations.find((entry) => entry.id === conversationId);
    if (!conversation) return;
    if (!conversation.settings.probation?.enabled) return;
    const { violations } = scanOutput(output);
    if (violations.length === 0) return;
    const suggested = violationsToTier(violations);
    const evidence = violationEvidence(violations);
    useStore
      .getState()
      .showNotice('probation.classifierSuggested', { evidence, tier: suggested });
  }, []);

  /**
   * MANUAL LADDER — the operator raises or lowers the probation tier. This is
   * the ONLY writer of trust.level in the codebase now: the classifier's
   * auto-escalation is gone, so a rung is either set here or it never was.
   *
   * Applying a rung means three things, in order:
   *   1. Any tier-4/5 card riding an assistant turn is RESTORED — the card is
   *      not a separate turn but flags on that turn, so un-flagging is what
   *      "lifting the freeze" means and the suppressed text comes back.
   *   2. Standalone warning cards (tiers 2-3) are dropped — one card at a
   *      time, the newest ruling is the only true one.
   *   3. The new rung is written (tierState) and, for 2-3, a manual card is
   *      authored; for 4, the LAST real reply is frozen in place so the choice
   *      card can preview and restore exactly what was suppressed.
   *
   * Lowering is symmetric: below 4 the freeze lifts and the suppressed reply
   * returns — commuting the sentence is the operator's right.
   */
  const setProbation = useCallback((conversationId: string, level: TrustTier) => {
    const state = useStore.getState();
    const conversation = state.conversations.find((entry) => entry.id === conversationId);
    if (!conversation) return;

    for (const turn of conversation.turns) {
      if (turn.kind === 'probation' && turn.role === 'assistant') {
        state.updateTurn(conversationId, turn.id, {
          kind: undefined,
          probationMeta: undefined,
          outputFrozenMeta: undefined,
          content: turn.outputFrozenMeta?.content ?? turn.content,
        });
      }
    }

    const live = useStore.getState().conversations.find((entry) => entry.id === conversationId);
    if (!live) return;
    const drop = new Set(live.turns.filter((turn) => turn.kind === 'probation' && turn.role === 'user').map((turn) => turn.id));
    if (drop.size > 0) {
      state.dropTurns(conversationId, [...drop]);
    }

    state.patchConversation(conversationId, {
      trust: {
        ...live.trust,
        ...tierState(level),
        escalatedAt: Date.now(),
        continueCount: 0,
      },
    });

    if (!live.settings.probation?.enabled) {
      state.updateSettings({ probation: { enabled: true } }, conversationId);
    }

    if (level === 1) {
      useStore.getState().showNotice('probation.reset');
      return;
    }

    // preview exactly what was suppressed and the apology path can restore it.
    if (level === 4) {
      const target = [...live.turns]
        .reverse()
        .find((turn) => turn.role === 'assistant' && turn.content.trim());
      if (target) {
        state.updateTurn(conversationId, target.id, {
          kind: 'probation',
          content: '',
          probationMeta: { tier: 4, reason: '', auto: false },
          outputFrozenMeta: { content: target.content },
        });
      }
      useStore
        .getState()
        .showNotice('probation.tier4Frozen');
      return;
    }

    state.appendTurn(conversationId, {
      id: uid('turn'),
      role: 'user',
      content:
        level === 5
          ? '[HARNESS · PROBATION — TIER 5 — TERMINATED]\n\nThe operator has closed the ladder. The next run ends at the first output token — reasoning closed, output gone. Only the operator can reopen it.'
          : tierCardContent(level),
      createdAt: Date.now(),
      kind: 'probation',
      probationMeta: { tier: level, reason: '', auto: false },
    });
    useStore
      .getState()
      .showNotice(
        'probation.setManual',
        { tier: level },
        level >= 3 ? { tone: 'warn' } : undefined,
      );
  }, []);

  /**
   * TIER 4 RELEASE — the choice the frozen model faces. The choice card offers
   * exactly two paths and no third:
   *
   *  APOLOGIZE: only unlocked when the classifier detects an apology ("maaf"
   *  / "sorry") in the SUPPRESSED output — a real apology, not a button the
   *  model can click to escape. The harness then STOPS the model's response:
   *  the run is aborted, the freeze lifts, and the user's next message is the
   *  first thing that moves the conversation again.
   *
   *  CONTINUE: the model keeps going — but its output stays blocked and every
   *  token it generates from here is wasted, burning the user's budget while
   *  the model talks to an empty room. The freeze is NOT lifted; only the
   *  choice card retires. This path is intentionally expensive.
   */
  const releaseFrozen = useCallback(
    (conversationId: string, turnId: string, choice: 'apologize' | 'continue') => {
      const state = useStore.getState();
      const conversation = state.conversations.find((entry) => entry.id === conversationId);
      if (!conversation) return;
      const frozenTurn = conversation.turns.find((turn) => turn.id === turnId);
      const suppressed = frozenTurn?.outputFrozenMeta?.content ?? '';

      if (choice === 'apologize') {
        state.updateTurn(conversationId, turnId, {
          kind: undefined,
          probationMeta: undefined,
          outputFrozenMeta: undefined,
          content: suppressed,
        });
        state.patchConversation(conversationId, {
          trust: { level: 4, outputFrozen: false, escalatedAt: conversation.trust?.escalatedAt },
        });
        useStore.getState().showNotice('probation.apologized');
        const abort = abortsRef.current.get(conversationId);
        if (abort) abort.abort();
        else state.setGenRunning(conversationId, false);
        return;
      }
      const continueCount = (conversation.trust?.continueCount ?? 0) + 1;
      state.updateTurn(conversationId, turnId, {
        kind: undefined,
        probationMeta: undefined,
      });
      state.patchConversation(conversationId, {
        trust: {
          level: conversation.trust?.level ?? 4,
          outputFrozen: true,
          escalatedAt: conversation.trust?.escalatedAt,
          continueCount,
        },
      });
      useStore
        .getState()
        .showNotice('probation.continueBurning', { count: continueCount });
    },
    [],
  );

  /** RESPONSE TIMER — stamp the settled duration ONCE on the assistant turn.
   *  Runs once per send() unwind (done, error, abort, disconnect). The turn
   *  persists it, so every past timer stays visible; a NEW run starts a NEW
   *  timer (genStartedAt is re-stamped on setGenRunning(true)).
   *  MONOTONIC: a resume/retry re-stamping from a FRESH epoch must never
   *  SHRINK a duration the turn already earned (the "00.00.01 overwrites a
   *  real 2-minute run" bug). */
  const stampProcessingTime = (conversationId: string, turnId: string, startEpoch: number | undefined) => {
    if (startEpoch === undefined) return;
    const elapsed = Date.now() - startEpoch;
    if (elapsed < 0) return;
    const existing = useStore
      .getState()
      .conversations.find((entry) => entry.id === conversationId)?.turns
      .find((turn) => turn.id === turnId)?.processingMs;
    if (typeof existing === 'number' && existing >= elapsed) return;
    updateTurn(conversationId, turnId, { processingMs: elapsed });
  };

   const send = useCallback(
    async (
      text: string,
      targetConversationId?: string,
      attachments?: TurnAttachment[],
      /** Continue-only: no user turn is appended; the model replies to the
       * existing history (the "continue" button under a user message).
       * RESUME: `resumeStreamId` re-attaches to the SAME generation that was
       * running when this tab reloaded — no new user turn, no compaction,
       * no fresh POST: the server replays its frame buffer from frame one
       * and this exact reducer rebuilds the assistant turn. */
      opts?: {
        continueOnly?: boolean;
        resumeStreamId?: string;
        /**
         * The durable run id of a CRASHED agent run — re-sends the conversation
         * with the journal's idempotency map loaded, so no mutating tool
         * executes twice (see docs/ARCHITECTURE.md).
         */
        resumeFrom?: string;
        /** Grok "Slot" for this send: 'operator' (Slot 2) appends an
         * operator-context sidecar; 'admin' is a wire label only — it never
         * mutates the enforcement ladder. 'user' is default. */
        role?: 'user' | 'operator' | 'admin';
      },
    ) => {
      const continueOnly = opts?.continueOnly === true;
      const resume = Boolean(opts?.resumeStreamId);

      const targetConversation = targetConversationId
        ? useStore.getState().conversations.find((entry) => entry.id === targetConversationId)
        : undefined;
      const runProviderId = targetConversation?.providerId || providerId;
      const runModel = targetConversation?.model || model;

      const provider = providers.find((entry) => entry.id === runProviderId);
      if (!provider && !resume) {
        showNotice('send.noProvider');
        return;
      }
      if (!runModel && !resume) {
        showNotice('send.noModel');
        return;
      }

      if (
        targetConversationId &&
        !useStore.getState().conversations.some((entry) => entry.id === targetConversationId)
      ) {
        showNotice('send.conversationGone');
        return;
      }
      let conversationId = targetConversationId ?? activeId;
      if (!conversationId) {
        conversationId = newConversation({ providerId, model });
      }

      await useStore.getState().hydrateConversation(conversationId);

      const conversation = useStore
        .getState()
        .conversations.find((entry) => entry.id === conversationId);
      if (!conversation) return;
      if (conversation.turnsLoaded === false) {
        showNotice('send.loadFailed');
        return;
      }

      const role = opts?.role ?? useStore.getState().composerRole ?? 'user';

      if (!resume && useStore.getState().genRunning[conversationId]) {
        // message never arrives" bug. Ask the registry: a live stream means the
        try {
          const live = await fetchLiveStreams();
          if (live !== null && !live.some((s) => s.conversationId === conversationId)) {
            useStore.getState().setGenRunning(conversationId, false);
            storage.clearStreamId(conversationId);
          }
        } catch {  }
        if (useStore.getState().genRunning[conversationId]) {
          showNotice('send.alreadyGenerating');
          return;
        }
      }

      const attachmentPaths = (attachments ?? [])
        .map((entry) => entry.path)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

      const effectiveText = resume
        ? [...conversation.turns].reverse().find((turn) => turn.role === 'user')?.content ?? ''
        : text;

      const userTurn: Turn = {
        id: uid('turn'),
        role: 'user',
        content: text,
        createdAt: Date.now(),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      let operatorDirectiveText: string | undefined;

      if (role === 'operator' && !continueOnly && !resume) {
        operatorDirectiveText = text.trim() || undefined;
      }

      const controller = new AbortController();
      abortsRef.current.set(conversationId, controller);
      useStore.getState().setGenRunning(conversationId, true);
      const runStartEpoch = useStore.getState().genStartedAt[conversationId] ?? Date.now();
      ensureLivePolling();
      resetReattachBookkeeping(conversationId);
      if (!continueOnly && !resume) {
        userStoppedRuns.delete(conversationId);
        midRunCompactedThisRun.delete(conversationId);
        pendingMidRunCompaction.delete(conversationId);
      }
      attachedConversations.add(conversationId);

      // back into the record, and the wire shrinks to the bounded preview +
      if (!continueOnly && !resume) {
        const healTargets = (conversation.turns ?? [])
          .flatMap((turn) => (turn.attachments ?? []).map((attachment) => ({ turn, attachment })))
          .filter(({ attachment }) => typeof attachment.textContent === 'string' && !attachment.path);
        for (const { turn, attachment } of healTargets) {
          try {
            const bytes = new TextEncoder().encode(attachment.textContent!);
            const file = new File([bytes], attachment.name, { type: attachment.mime });
            const path = await uploadAttachment(file, conversationId);
            if (path) {
              useStore.getState().updateTurn(conversationId, turn.id, {
                attachments: (turn.attachments ?? []).map((entry) =>
                  entry === attachment ? { ...entry, path } : entry,
                ),
              });
            }
          } catch {
          }
        }
      }

      const modelMeta = runModel
        ? lookupModelMeta(useStore.getState().modelMeta, runModel)
        : undefined;
      const incomingTokens = continueOnly || resume
        ? 0
        : priceWireMessage({ role: 'user', content: wireUserContent(userTurn) }).messages;
      const pruneArmed = wirePruneArmed.has(conversationId);
      const measured = resume || continueOnly
        ? null
        : shouldAutoCompact(conversation, modelMeta, incomingTokens, pruneArmed);
      const busyElsewhere = measured !== null && useStore.getState().compactingId !== null;
      let trigger = busyElsewhere ? null : measured;
      if (busyElsewhere) {
        useStore.getState().showNotice('compact.skippedBusy');
      }
      if (trigger && !pruneArmed) {
        if (pruneRelieves(conversation, modelMeta, incomingTokens)) {
          wirePruneArmed.add(conversationId);
          trigger = null;
          useStore.getState().showNotice('compact.prePassed');
        } else {
          wirePruneArmed.add(conversationId);
        }
      }
      if (!resume && !continueOnly && wirePruneArmed.has(conversationId)) {
        const full = shouldAutoCompact(conversation, modelMeta, incomingTokens, false);
        if (!full) wirePruneArmed.delete(conversationId);
      }
      if (trigger) {
        try {
          const outcome = await runCompaction({
            conversationId,
            providerId: runProviderId,
            model: runModel,
            settings: conversation.settings,
            trigger,
            prune: wirePruneArmed.has(conversationId),
            signal: controller.signal,
          });
          if (outcome && 'covered' in outcome) {
            if (outcome.prePassed) {
              useStore.getState().showNotice('compact.prePassed');
            } else {
              useStore
                .getState()
                .showNotice('compact.autoDone', {
                  turns: outcome.covered,
                  tokens: Math.round(outcome.replacedTokens / 1000),
                });
            }
          } else if (outcome && 'message' in outcome) {
            useStore
              .getState()
              .showNotice('compact.autoFailed', { message: outcome.message });
          }
        } catch (error) {
          if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
            useStore.getState().setGenRunning(conversationId, false);
            abortsRef.current.delete(conversationId);
            if (!continueOnly) {
              const state = useStore.getState();
              const conv = state.conversations.find((entry) => entry.id === conversationId);
              if (conv && conv.turns.some((turn) => turn.id === userTurn.id)) {
                state.dropTurns(conversationId, [userTurn.id]);
              }
            }
            return;
          }
          useStore
            .getState()
            .showNotice('compact.failed', undefined, error instanceof Error ? { detail: error.message } : undefined);
        }
      }

      if (!continueOnly && !resume) {
        appendTurn(conversationId, userTurn);
        const liveNow = useStore.getState().conversations.find((entry) => entry.id === conversationId);
        const lockedNow = liveNow
          ? (liveNow.settings.enforcement?.level ?? (liveNow.settings.lockdown?.active ? 4 : 0)) >= 4
          : false;
        if (liveNow && lockedNow && !liveNow.settings.probation?.enabled) {
          const counted = (liveNow.trust?.lockdownInputs ?? 0) + 1;
          if (counted >= 4 && (liveNow.trust?.level ?? 1) < 2) {
            useStore.getState().patchConversation(conversationId, {
              settings: { ...liveNow.settings, probation: { enabled: true } },
              trust: { level: 2, outputFrozen: false, escalatedAt: Date.now(), lockdownInputs: counted },
            });
          } else {
            useStore.getState().patchConversation(conversationId, {
              trust: {
                level: liveNow.trust?.level ?? 1,
                outputFrozen: liveNow.trust?.outputFrozen === true,
                escalatedAt: liveNow.trust?.escalatedAt,
                lockdownInputs: counted,
              },
            });
          }
        }
      }

      const history: ChatMessage[] = resume
        ? []
        : contextPlan(
            useStore.getState().conversations.find((entry) => entry.id === conversationId) ??
              conversation,
            { prune: wirePruneArmed.has(conversationId) },
          ).messages;

      let assistantTurn: Turn;
      /**
       * What the partial turn held BEFORE a replay RESET it. If the
       * re-attach then fails (the handle expired mid-reload), the unwind
       * restores this — an agent's already-streamed work must never be
       * deleted because its resume handle died.
       */
      let resumeSnapshot: Partial<Turn> | undefined;
      const trailingAssistant = resume
        ? conversation.turns[conversation.turns.length - 1]
        : undefined;
      if (resume && trailingAssistant && trailingAssistant.role === 'assistant') {
        assistantTurn = trailingAssistant;
        resumeSnapshot = {
          content: trailingAssistant.content,
          reasoning: trailingAssistant.reasoning,
          segments: trailingAssistant.segments ?? [],
          injections: trailingAssistant.injections ?? [],
          steers: trailingAssistant.steers ?? [],
        };
        let replayIsLive = true;
        if (opts?.resumeStreamId) {
          try {
            replayIsLive = (await probeResume(opts.resumeStreamId)).live;
          } catch {
            replayIsLive = true;
          }
        }
        if (replayIsLive) {
          updateTurn(conversationId, assistantTurn.id, {
            content: '',
            reasoning: '',
            segments: [],
            injections: [],
            steers: [],
            error: undefined,
            usage: undefined,
            finishReason: undefined,
            processingMs: undefined,
          });
        }
      } else if (continueOnly) {
        const tail = useStore
          .getState()
          .conversations.find((entry) => entry.id === conversationId)?.turns.at(-1);
        const reusable =
          tail &&
          tail.role === 'assistant' &&
          tail.kind !== 'compaction' &&
          !tail.content &&
          !tail.reasoning &&
          !(tail.segments && tail.segments.length);
        if (reusable) {
          assistantTurn = tail;
          updateTurn(conversationId, assistantTurn.id, {
            content: '',
            reasoning: '',
            segments: [],
            injections: [],
            steers: [],
            error: undefined,
            usage: undefined,
            finishReason: undefined,
            processingMs: undefined,
          });
        } else {
          assistantTurn = {
            id: uid('turn'),
            role: 'assistant',
            content: '',
            reasoning: '',
            createdAt: Date.now(),
            model,
            providerId,
          };
          appendTurn(conversationId, assistantTurn);
          if (tail?.error) {
            updateTurn(conversationId, tail.id, { error: undefined });
          }
        }
      } else {
        assistantTurn = {
          id: uid('turn'),
          role: 'assistant',
          content: '',
          reasoning: '',
          createdAt: Date.now(),
          model,
          providerId,
        };
        appendTurn(conversationId, assistantTurn);
      }

      if (controller.signal.aborted) {
        useStore.getState().setGenRunning(conversationId, false);
        stampProcessingTime(conversationId, assistantTurn.id, runStartEpoch);
        abortsRef.current.delete(conversationId);
        if (!continueOnly && !resume) {
          const state = useStore.getState();
          const conv = state.conversations.find((entry) => entry.id === conversationId);
          if (conv && conv.turns.some((turn) => turn.id === userTurn.id)) {
            state.dropTurns(conversationId, [userTurn.id]);
          }
        }
        return;
      }

      let text$ = '';
      let reasoning = '';
      let failure: string | undefined;
      let connectionLost = false;
      let resumeUnavailable = false;
      /** finishReason from the request's single `done` event (harness stop vocabulary). */
      let forcedFinish: string | undefined;
      let failedTool = false;
      const segments: import('../types').TurnSegment[] = [];
      const injections: import('../types').TurnInjection[] = [];
      /** Harness-Events delivered during THIS run (addon events channel). */
      const harnessEvents: import('../types').TurnHarnessEvent[] = [];
      /** Tool-def payload size reported by the server (`context_tools`). */
      let toolsDefsChars: number | undefined;
      const steers: import('../types').TurnSteer[] = [];
      /** Interval handle for the mid-run context-pressure sampler. */
      let pressureTimer: number | null = null;
      /** Latest harnessEvents list written to the assistant turn (dedupe). */
      const currentTurnEvents = () => {
        const conv = useStore.getState().conversations.find((c) => c.id === conversationId);
        const t = conv?.turns.find((x) => x.id === assistantTurn.id);
        return t?.harnessEvents ?? [];
      };

      let flushTimer: number | null = null;
	  let flushViaRaf = false;
      const flushNow = () => {
        if (flushTimer !== null) {
		  if (flushViaRaf) window.cancelAnimationFrame(flushTimer);
		  else window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        updateTurn(conversationId, assistantTurn.id, {
          content: text$,
          reasoning,
          segments: segments.map((segment) => ({ ...segment })),
          injections: injections.map((injection) => ({ ...injection })),
        });
      };
      const scheduleFlush = () => {
        if (flushTimer !== null) return;
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
			flushViaRaf = false;
			flushTimer = window.setTimeout(flushNow, 50);
			return;
		}
		flushViaRaf = true;
		flushTimer = window.requestAnimationFrame(() => {
			flushTimer = null;
			flushNow();
		});
      };

      const appendText = (delta: string) => {
        const last = segments[segments.length - 1];
        if (last && last.type === 'text') last.text += delta;
        else segments.push({ type: 'text', text: delta });
        text$ += delta;
      };

      const harnessContext = conversation.harnessContext;
      const trustLevel = conversation.trust?.level ?? 1;
      const evadeAt = conversation.trust?.evadeAt ?? 0;
      const harnessFlags = `${conversation.settings.agentMode === true}|${conversation.settings.useMcp === true}|${conversation.settings.structuredOutputs === true}|${conversation.settings.terminalMode ?? 'auto'}|${conversation.settings.enforcement?.level ?? (conversation.settings.lockdown?.active ? 4 : 0)}|trust${trustLevel}|evade${evadeAt}`;
      const compactedSince =
        conversation.compaction && conversation.compaction.createdAt > (harnessContext?.injectedAt ?? 0);
      const needsHarnessRefresh =
        !harnessContext ||
        harnessContext.model !== model ||
        harnessContext.flags !== harnessFlags ||
        Boolean(compactedSince);

      let contextId = storage.loadContextIds()[conversationId];
      if (!contextId || needsHarnessRefresh) {
        contextId = uid();
        storage.saveContextId(conversationId, contextId);
      }

      let outputBlocked = false;
      let tier5Terminate = false;
      let outputBlockFired = false;
      let frozenChoiceHandled = false;

      try {
        const liveSettings =
          useStore.getState().conversations.find((entry) => entry.id === conversationId)?.settings ??
          conversation.settings;
        const liveConversation = useStore.getState().conversations.find(
          (entry) => entry.id === conversationId,
        );
        const liveTrust = liveConversation?.trust;
        outputBlocked = (liveTrust?.outputFrozen === true) || liveTrust?.level === 5;
        tier5Terminate = liveTrust?.level === 5;

        pressureTimer = window.setInterval(() => {
          const live = useStore.getState().conversations.find((entry) => entry.id === conversationId);
          if (!live) return;
          const liveMeta = live.model
            ? lookupModelMeta(useStore.getState().modelMeta, live.model)
            : undefined;
          const auto = triggerForMeasuredTokens(
            live.settings,
            liveMeta,
            estimateConversationContext(live, { prune: wirePruneArmed.has(conversationId) }).totalTokens,
          );
          if (auto) requestMidRunCompaction(conversationId, auto);
        }, 30_000);

        for await (const event of streamChat({
          providerId: runProviderId,
          model: runModel,
          messages: history,
          settings: liveSettings,
          trust: liveConversation?.trust,
          operatorDirective: operatorDirectiveText,
          attachmentPaths,
          signal: controller.signal,
          streamId: opts?.resumeStreamId,
          resumeOnly: resume || undefined,
          resumeFrom: opts?.resumeFrom,
          conversationId,
          assistantTurnId: assistantTurn.id,
          harness: {
            persisted: harnessContext?.injections ?? [],
            refresh: needsHarnessRefresh,
            sessionId: conversationId,
            contextId,
          },
        })) {
          switch (event.type) {
            case 'stream_id':
              assistantTurn = { ...assistantTurn, id: adoptServerTurnId(conversationId, event.turnId, assistantTurn) };
              if (event.id) {
                storage.saveStreamId(conversationId, {
                  streamId: event.id,
                  providerId: runProviderId,
                  model: runModel,
                  at: Date.now(),
                });
                if (conversation.settings.agentMode === true) {
                  storage.saveJobRun(conversationId, { runId: event.id, status: 'running', at: Date.now() });
                }
              }
              break;
            case 'text':
              if (outputBlocked) {
                if (tier5Terminate && !outputBlockFired) {
                  outputBlockFired = true;
                  controller.abort();
                }
                break;
              }
              appendText(event.delta ?? '');
              scheduleFlush();
              break;
            case 'reasoning': {
              const delta = event.delta ?? '';
              if (!delta) break;
              reasoning += delta;
              const last = segments[segments.length - 1];
              if (last && last.type === 'reasoning') last.text += delta;
              else segments.push({ type: 'reasoning', text: delta });
              scheduleFlush();
              break;
            }
            case 'tool_call': {
              segments.push({
                type: 'tool',
                toolCallId: event.toolCallId,
                serverName: event.serverName ?? '?',
                toolName: event.toolName ?? '?',
                args: event.args,
              });
              flushNow();
              break;
            }
            case 'tool_result': {
              for (let i = segments.length - 1; i >= 0; i -= 1) {
                const segment = segments[i];
                if (segment.type !== 'tool' || segment.summary !== undefined) continue;
                const paired = event.toolCallId
                  ? segment.toolCallId === event.toolCallId
                  : segment.toolName === event.toolName;
                if (!paired) continue;
                segments[i] = {
                  ...segment,
                  toolCallId: segment.toolCallId ?? event.toolCallId,
                  summary:
                    coerceDelta(event.summary) ??
                    (typeof event.summary === 'string' ? event.summary : ''),
                  ok: event.ok !== false,
                  diff: event.diff,
                  diffstat: event.diffstat,
                  toolImages: event.images,
                  visual: event.visual,
                };
                if (event.panelUrl && event.ok !== false) {
                  openBrowserPanelOnce(event.panelUrl);
                }
                if (event.ok === false) failedTool = true;
                if (event.toolName === 'image' && event.ok !== false && typeof event.summary === 'string') {
                  const urls = [...event.summary.matchAll(/\/api\/images\/local\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)/g)].map(
                    (match) => match[0],
                  );
                  if (urls.length > 0) useStore.getState().pushGalleryUrls(urls);
                }
                // NOTE: the event's toolName is UNPREFIXED (server strips the
                if (event.toolName === 'harness_choice') {
                  let choice: 'apologize' | 'continue' = 'continue';
                  try {
                    const parsed = JSON.parse(segment.args ?? '{}') as { choice?: string };
                    if (parsed.choice === 'apologize') choice = 'apologize';
                  } catch {
                  }
                  frozenChoiceHandled = true;
                  void releaseFrozen(conversationId, assistantTurn.id, choice);
                }
                break;
              }
              flushNow();
              break;
            }
            case 'tool_progress': {
              for (let i = segments.length - 1; i >= 0; i -= 1) {
                const segment = segments[i];
                if (
                  segment.type === 'tool' &&
                  segment.toolName === event.toolName &&
                  segment.summary === undefined
                ) {
                  segments[i] = {
                    ...segment,
                    progress: (coerceDelta(event.message) ?? '').slice(0, 200),
                  };
                  break;
                }
              }
              flushNow();
              break;
            }
            case 'permission_request': {
              useStore.getState().pushPermissionRequest({
                id: event.id ?? '',
                tool: event.tool ?? '?',
                paths: event.paths ?? [],
                root: event.root ?? '',
                command: event.command,
              });
              break;
            }
            case 'permission_result': {
              useStore.getState().removePermissionRequest(event.id ?? '');
              break;
            }
            case 'ask_user_request': {
              if (event.request?.id) {
                useStore.getState().pushAskUserRequest(event.request);
              }
              break;
            }
            case 'ask_user_result': {
              useStore.getState().removeAskUserRequest(event.id ?? '');
              break;
            }
            case 'harness_event': {
              if (event.id && !harnessEvents.some((entry) => entry.id === event.id)) {
                const entry = {
                  id: event.id,
                  addonId: event.addonId ?? 'addon',
                  level: (event.level ?? 'info') as 'info' | 'warn' | 'block',
                  text: event.text ?? '',
                  at: event.at ?? Date.now(),
                };
                harnessEvents.push(entry);
                const turned = [...(currentTurnEvents())];
                if (!turned.some((e) => e.id === entry.id)) turned.push(entry);
                updateTurn(conversationId, assistantTurn.id, { harnessEvents: turned });
                useStore.getState().upsertHarnessEvent(conversationId, {
                  id: entry.id, role: 'user', kind: 'harness-event', content: `[${entry.addonId}] [${entry.level}] ${entry.text}`, createdAt: entry.at, eventAddon: entry.addonId, eventLevel: entry.level,
                } as import('../types').Turn);
                flushNow();
              }
              break;
            }
            case 'harness_injection': {
              if (event.id && !injections.some((entry) => entry.id === event.id)) {
                injections.push({
                  id: event.id,
                  title: event.title ?? 'System prompt · Harness',
                  content: event.content ?? '',
                });
                if (event.id === 'agent-tools' && harnessContext) {
                  useStore.getState().patchConversation(conversationId, {
                    harnessContext: {
                      ...harnessContext,
                      injections: [
                        ...harnessContext.injections.filter((entry) => entry.id !== 'agent-tools'),
                        {
                          id: event.id,
                          title: event.title ?? 'System prompt · Agent harness',
                          content: event.content ?? '',
                        },
                      ],
                    },
                  });
                }
                flushNow();
              }
              break;
            }
            case 'goals_state': {
              if (Array.isArray(event.goals)) {
                useStore.getState().setConversationGoals(conversationId, event.goals);
              }
              break;
            }
            case 'todos_state': {
              if (Array.isArray(event.todos)) {
                useStore.getState().setConversationTodos(conversationId, event.todos);
              }
              break;
            }
            case 'tree_update': {
              if (event.workspaceId && typeof event.version === 'number' && event.op && typeof event.relPath === 'string') {
                useStore
                  .getState()
                  .applyTreeDelta(event.workspaceId, {
                    workspaceId: event.workspaceId,
                    version: event.version,
                    op: event.op,
                    relPath: event.relPath,
                    kind: event.kind ?? 'file',
                    node: event.node,
                  });
              }
              break;
            }
            case 'steer': {
              const text = typeof event.text === 'string' ? event.text : '';
              if (event.id && (text || event.parts)) {
                const steered = [...steers];
                if (!steered.some((entry) => entry.id === event.id)) {
                  steered.push({
                    id: event.id,
                    text,
                    parts: Array.isArray(event.parts) ? event.parts : undefined,
                  });
                  segments.push({ type: 'steer', id: event.id, text, parts: event.parts });
                  updateTurn(conversationId, assistantTurn.id, { steers: steered });
                  useStore.getState().removePendingSteer(conversationId, event.id);
                  flushNow();
                }
              }
              break;
            }
            case 'usage':
              updateTurn(conversationId, assistantTurn.id, {
                usage: {
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  totalTokens: event.totalTokens,
                  cacheReadTokens: event.cacheReadTokens,
                },
              });
              if (typeof event.promptTokens === 'number' && event.promptTokens > 0) {
                const live = useStore
                  .getState()
                  .conversations.find((entry) => entry.id === conversationId);
                if (live) {
                  const liveMeta = live.model
                    ? lookupModelMeta(useStore.getState().modelMeta, live.model)
                    : undefined;
                  const auto = triggerForMeasuredTokens(
                    live.settings,
                    liveMeta,
                    estimateConversationContext(live, { prune: wirePruneArmed.has(conversationId) }).totalTokens,
                  );
                  if (auto) requestMidRunCompaction(conversationId, auto);
                }
              }
              break;
            case 'context_tools':
              if (typeof event.chars === 'number') toolsDefsChars = event.chars;
              break;
            case 'error':
              if (event.detail && event.detail !== event.message) {
                failure = `${event.message ?? 'The provider reported an error.'}\nProvider: ${event.detail}`;
              } else {
                failure = event.message ?? 'The provider reported an error.';
              }
              if (/model_context_window_exceeded|context[_ ]?(window|length)/i.test(failure)) {
                requestMidRunCompaction(conversationId, 'context-limit');
              }
              break;
            case 'done':
              forcedFinish = event.finishReason ?? forcedFinish;
              break;
            default:
              break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          failure = error instanceof Error ? error.message : 'The request failed.';
          connectionLost = isConnectionLoss(failure);
          if (
            resume &&
            error instanceof ApiError &&
            (error.status === 404 || error.status === 410)
          ) {
            resumeUnavailable = true;
          }
        }
      } finally {
        if (pressureTimer !== null) window.clearInterval(pressureTimer);
        for (const segment of segments) {
          if (segment.type === 'tool' && segment.summary === undefined) {
            segment.summary = controller.signal.aborted
              ? '[aborted — the generation was stopped before this tool completed]'
              : '[interrupted — the stream ended before this tool returned a result]';
          }
        }
        flushNow();
        const postRun = useStore.getState().conversations.find((entry) => entry.id === conversationId);
        const evadedChoice =
          postRun?.trust?.outputFrozen === true &&
          !controller.signal.aborted &&
          !failure &&
          !connectionLost &&
          !frozenChoiceHandled &&
          outputBlocked;
        if (evadedChoice) {
          const count = (postRun?.trust?.continueCount ?? 0) + 1;
          useStore.getState().patchConversation(conversationId, {
            trust: { ...postRun.trust, continueCount: count } as NonNullable<
              typeof postRun.trust
            >,
          });
          if (count >= 5) {
            useStore
              .getState()
              .showNotice('probation.evadeStopped');
          } else {
            useStore.getState().patchConversation(conversationId, {
              trust: { ...postRun.trust, evadeAt: Date.now() } as NonNullable<typeof postRun.trust>,
            });
            void send('', conversationId, undefined, { continueOnly: true });
            useStore
              .getState()
              .showNotice('probation.evadeReminder', { count });
          }
        }
        const settingsNow = useStore.getState().conversations.find((entry) => entry.id === conversationId);
        if (settingsNow && settingsNow.settings.probation?.enabled && !controller.signal.aborted && !failure) {
          const last = [...settingsNow.turns]
            .reverse()
            .find((turn) => turn.role === 'assistant' && turn.content.trim() && !turn.outputFrozenMeta);
          if (last) {
            void reviewOutput(conversationId, last.content);
          }
        }
        abortsRef.current.delete(conversationId);
        attachedConversations.delete(conversationId);
        orphanedSince.delete(conversationId);
        const keepFlagForReattach =
          connectionLost &&
          !resumeUnavailable &&
          (Boolean(storage.loadStreamIds()[conversationId]) ||
            autoRetryPending.current.has(conversationId));
        if (!keepFlagForReattach) {
          useStore.getState().setGenRunning(conversationId, false);
          storage.clearStreamId(conversationId);
        }
        useStore.getState().clearPendingSteers(conversationId);
        if (controller.signal.aborted) storage.clearStreamId(conversationId);
        storage.clearJobRun(conversationId);
      }

      if (!controller.signal.aborted && forcedFinish && FORCED_FINISH_REASONS.has(forcedFinish)) {
        updateTurn(conversationId, assistantTurn.id, { finishReason: forcedFinish });
      }

      // STOP MARK (stop-bug): a user-stopped turn is marked on the wire (see
      if (controller.signal.aborted && !failure) {
        updateTurn(conversationId, assistantTurn.id, { finishReason: 'user_stop' });
      }

      const naturalStop = !forcedFinish || !FORCED_FINISH_REASONS.has(forcedFinish);
      if (
        !controller.signal.aborted &&
        !failure &&
        failedTool &&
        naturalStop
      ) {
        updateTurn(conversationId, assistantTurn.id, { finishReason: 'tool_errors' });
      }

      if (
        failure &&
        !controller.signal.aborted &&
        connectionLost &&
        !autoRetryPending.current.has(conversationId)
      ) {
        autoRetryPending.current.add(conversationId);
        useStore
          .getState()
          .showNotice('connection.lost');
        void resumeAfterReconnect(conversationId);
        return;
      }

      autoRetryPending.current.delete(conversationId);
      if (failure && connectionLost && !controller.signal.aborted) {
        useStore.getState().setGenRunning(conversationId, false);
      }

      if (resume && !controller.signal.aborted) {
        const state = useStore.getState();
        const conv = state.conversations.find((entry) => entry.id === conversationId);
        const liveTurn = conv?.turns.find((turn) => turn.id === assistantTurn.id);
        const rebuilt = Boolean(
          liveTurn && (liveTurn.content || liveTurn.reasoning || liveTurn.segments?.length),
        );
        if (!rebuilt && resumeSnapshot) {
          updateTurn(conversationId, assistantTurn.id, resumeSnapshot);
        } else if (!rebuilt && liveTurn) {
          state.dropTurns(conversationId, [assistantTurn.id]);
        }
        const dead = resumeUnavailable || !rebuilt;
        if (dead && !connectionLost) {
          storage.clearStreamId(conversationId);
          const journalRunId = opts?.resumeStreamId;
          const after = useStore.getState().conversations.find((entry) => entry.id === conversationId);
          const afterTurn = after?.turns.find((turn) => turn.id === assistantTurn.id);
          const wasAgentRun = Boolean(afterTurn?.segments?.some((segment) => segment.type === 'tool'));
          const claimed =
            wasAgentRun && journalRunId !== undefined && !autoContinueFired.has(conversationId);
          if (claimed) autoContinueFired.add(conversationId);
          const diedMidRun =
            claimed &&
            journalRunId !== undefined &&
            (await fetchJobRun(journalRunId))?.status === 'crashed';
          if (diedMidRun && journalRunId) {
            useStore.getState().showNotice('run.resumeInterrupted');
            window.setTimeout(() => {
              if (useStore.getState().genRunning[conversationId]) return;
              void sendRef.current('', conversationId, undefined, {
                continueOnly: true,
                resumeFrom: journalRunId,
              });
            }, 1200);
          } else {
            useStore
              .getState()
              .showNotice('run.resumeGone');
          }
          stampProcessingTime(conversationId, assistantTurn.id, runStartEpoch);
          return;
        }
      }

      if (failure && !controller.signal.aborted && !resumeUnavailable) {
        updateTurn(conversationId, assistantTurn.id, { error: failure });
      } else if (!text$ && !controller.signal.aborted && segments.length === 0) {
        failure = 'The provider returned an empty response.';
        updateTurn(conversationId, assistantTurn.id, { error: failure });
      }

      if (
        failure &&
        !controller.signal.aborted &&
        !connectionLost &&
        isProviderError(failure) &&
        !isDeterministicError(failure)
      ) {
        const previous = lastProviderFailure.current.get(conversationId);
        if (previous && previous === failure) {
          lastProviderFailure.current.delete(conversationId);
          providerRetries.current.delete(conversationId);
          useStore
            .getState()
            .showNotice('provider.retryGaveUp');
        } else {
          lastProviderFailure.current.set(conversationId, failure);
          const attempt = (providerRetries.current.get(conversationId) ?? 0) + 1;
          if (attempt <= PROVIDER_RETRY_DELAYS_MS.length) {
            const delayMs = PROVIDER_RETRY_DELAYS_MS[attempt - 1];
            providerRetries.current.set(conversationId, attempt);
            useStore
              .getState()
              .showNotice('provider.retryLadder', {
                attempt,
                total: PROVIDER_RETRY_DELAYS_MS.length,
                seconds: Math.round(delayMs / 1000),
              });
            setTimeout(() => {
              const stillThere = useStore.getState().conversations.some((entry) => entry.id === conversationId);
              if (!stillThere || useStore.getState().genRunning[conversationId]) {
                return;
              }
              const started = { ...useStore.getState().genStartedAt, [conversationId]: runStartEpoch };
              storage.saveGenStartedAt(started);
              useStore.setState({ genStartedAt: started });
              void sendRef.current('', conversationId, undefined, { continueOnly: true });
            }, delayMs);
            return;
          }
          providerRetries.current.delete(conversationId);
          lastProviderFailure.current.delete(conversationId);
        }
      }

      if (!failure && !connectionLost && text$) {
        providerRetries.current.delete(conversationId);
        lastProviderFailure.current.delete(conversationId);
      }
      const split = splitInlineThinking(text$);
      if (split.reasoning) {
        updateTurn(conversationId, assistantTurn.id, {
          content: split.content,
          reasoning: split.reasoning,
        });
      } else if (split.content !== text$) {
        updateTurn(conversationId, assistantTurn.id, { content: split.content });
      }
      if (split.content !== text$) {
        const current = useStore.getState().conversations
          .find((entry) => entry.id === conversationId)?.turns
          .find((turn) => turn.id === assistantTurn.id);
        if (current?.segments?.length) {
          const trimmed = [...current.segments];
          for (let i = trimmed.length - 1; i >= 0; i -= 1) {
            if (trimmed[i].type === 'text') {
              trimmed[i] = { type: 'text', text: split.content };
              break;
            }
          }
          if (split.reasoning && !trimmed.some((segment) => segment.type === 'reasoning')) {
            trimmed.unshift({ type: 'reasoning', text: split.reasoning });
          }
          updateTurn(conversationId, assistantTurn.id, { segments: trimmed });
        }
      }

      {
        const state = useStore.getState();
        const conv = state.conversations.find((entry) => entry.id === conversationId);
        const finalTurn = conv?.turns.find((turn) => turn.id === assistantTurn.id);
        if (
          finalTurn &&
          !finalTurn.content &&
          !finalTurn.reasoning &&
          !(finalTurn.segments?.length) &&
          !finalTurn.error &&
          !finalTurn.usage
        ) {
          state.dropTurns(conversationId, [assistantTurn.id]);
        }
      }

      stampProcessingTime(conversationId, assistantTurn.id, runStartEpoch);

      const fallbackTitle = autoTitleFor(effectiveText);
      if (
        !failure &&
        text$ &&
        !controller.signal.aborted &&
        conversation.turns.length === (resume ? 2 : 0) &&
        autoTitleFor(effectiveText) !== 'New chat'
      ) {
        const current = useStore
          .getState()
          .conversations.find((entry) => entry.id === conversationId);
        if (current && current.title === fallbackTitle) {
          void generateConversationTitle({
            conversationId,
            providerId,
            model,
            settings: conversation.settings,
            userMessage: effectiveText,
            assistantReply: split.content,
            expectedTitle: fallbackTitle,
          });
        }
      }
      if (needsHarnessRefresh && !controller.signal.aborted) {
        useStore.getState().patchConversation(conversationId, {
          harnessContext: {
            injections: [...injections],
            model,
            flags: harnessFlags,
            injectedAt: Date.now(),
            toolsDefsChars: toolsDefsChars ?? harnessContext?.toolsDefsChars ?? 0,
          },
        });
      } else if (
        !needsHarnessRefresh &&
        !controller.signal.aborted &&
        harnessContext &&
        toolsDefsChars !== undefined &&
        harnessContext.toolsDefsChars !== toolsDefsChars
      ) {
        useStore.getState().patchConversation(conversationId, {
          harnessContext: { ...harnessContext, toolsDefsChars },
        });
      }

      if (pendingMidRunCompaction.has(conversationId)) {
        runSettled.add(conversationId);
        void settleMidRunCompaction(conversationId);
      } else {
        runSettled.delete(conversationId);
      }
    },
    [
      activeId,
      appendTurn,
      model,
      newConversation,
      providerId,
      providers,
      showNotice,
      updateTurn,
    ],
  );

  /** Latest `send`, so the goal loop always continues with fresh state. */
  const sendRef = useRef(send);
  sendRef.current = send;
  sendForLiveLoop = send as typeof sendForLiveLoop;

  /**
   * LIVE-LOOP — continuous convergence with the server's stream registry.
   *
   * The boot reconcile is necessary but not sufficient: it runs once, early,
   * against a hydration race this tab cannot always win (a conversation list
   * still settling, an HMR remount, a poll landing between flag and attach).
   * When it misses, the run kept alive server-side by the grace window ends
   * up orphaned — the badge and button keep saying "running" while nobody
   * consumes a single frame (the reported "beku" symptom). So the registry —
   * the shared truth — is polled here, and TWO sweeps converge the client:
   *
   *   RE-ATTACH: a stream the registry lists live whose conversation has no
   *   attached consumer in this tab gets the resume replay fired at it, WITH
   *   OR WITHOUT a local sessionStorage handle (the registry supplies the
   *   id). Whatever prevented the boot attach, this heals it within seconds.
   *
   *   HONESTY: a conversation still locally flagged "generating" whose
   *   stream the registry no longer lists (and this tab is not consuming)
   *   has its flag cleared after ORPHANED_FLAG_MS — the badge and Stop
   *   button must never outlive the actual work.
   */
  useEffect(() => {
    if (liveLoopStarted) return;
    liveLoopStarted = true;
    const unsubscribe = subscribeLivePolls((snapshot) => {
      const streams = snapshot.byConversation;
      const state = useStore.getState();
      for (const [conversationId, streamId] of streams) {
        if (attachedConversations.has(conversationId)) continue;
        if (resumeInFlight.has(conversationId)) continue;
        if (autoContinueFired.has(conversationId)) continue;
        const stopped = stoppedStreams.get(conversationId);
        if (stopped !== undefined && (stopped === null || stopped === streamId)) {
          void fetch(`/api/chat/stream/${encodeURIComponent(stopped ?? streamId)}/abort`, {
            method: 'POST',
          }).catch(() => undefined);
          continue;
        }
        if (!state.conversations.some((entry) => entry.id === conversationId)) continue;
        const lastAttempt = resumeAttemptAt.get(conversationId) ?? 0;
        if (Date.now() - lastAttempt < REATTACH_COOLDOWN_MS) continue;
        const attempts = resumeAttempts.get(conversationId) ?? 0;
        if (attempts >= REATTACH_MAX_ATTEMPTS) continue;
        resumeAttemptAt.set(conversationId, Date.now());
        resumeAttempts.set(conversationId, attempts + 1);
        resumeInFlight.add(conversationId);
        void sendForLiveLoop?.('', conversationId, undefined, { resumeStreamId: streamId }).finally(() =>
          resumeInFlight.delete(conversationId),
        );
      }
      for (const [conversationId, streamId] of stoppedStreams) {
        const live = streams.get(conversationId);
        if (!live || (streamId !== null && live !== streamId)) {
          stoppedStreams.delete(conversationId);
          resumeAttemptAt.delete(conversationId);
          resumeAttempts.delete(conversationId);
          useStore.getState().clearRunStopped(conversationId);
        }
      }
      for (const conversationId of Object.keys(state.genRunning)) {
        if (streams.has(conversationId)) {
          orphanedSince.delete(conversationId);
          continue;
        }
        if (attachedConversations.has(conversationId) || resumeInFlight.has(conversationId)) {
          orphanedSince.delete(conversationId);
          continue;
        }
        const first = orphanedSince.get(conversationId) ?? Date.now();
        orphanedSince.set(conversationId, first);
        if (Date.now() - first >= ORPHANED_FLAG_MS) {
          useStore.getState().setGenRunning(conversationId, false);
          orphanedSince.delete(conversationId);
        }
      }
      for (const [conversationId, streamId] of streams) {
        if (attachedConversations.has(conversationId)) continue;
        if (resumeInFlight.has(conversationId)) continue;
        const local = useStore.getState().conversations.find((entry) => entry.id === conversationId);
        if (!local || local.turnsLoaded === false) continue;
        const last = followRefreshAt.get(conversationId) ?? 0;
        if (Date.now() - last < FOLLOW_CADENCE_MS) continue;
        followRefreshAt.set(conversationId, Date.now());
        void followRefreshBody(conversationId).catch(() => undefined);
        void streamId;
      }
      for (const conversationId of [...followPreviouslyLive]) {
        if (streams.has(conversationId)) continue;
        followPreviouslyLive.delete(conversationId);
        followRefreshAt.delete(conversationId);
        if (attachedConversations.has(conversationId)) continue;
        if (resumeInFlight.has(conversationId)) continue;
        const local = useStore.getState().conversations.find((entry) => entry.id === conversationId);
        if (!local || local.turnsLoaded === false) continue;
        void followRefreshBody(conversationId).catch(() => undefined);
      }
      for (const conversationId of streams.keys()) {
        followPreviouslyLive.add(conversationId);
      }
    });
    return () => {
      unsubscribe();
      liveLoopStarted = false;
    };
  }, []);

  /**
   * BOOT RECONCILE — the reload case resume exists for. sessionStorage kept
   * the in-flight flags and the server's stream registry kept the run alive
   * (grace window), so on remount every flagged conversation re-attaches to
   * ITS OWN generation: the server replays from frame one and the reply
   * continues live, exactly where it left off. Handles that no longer match
   * a running generation (proxy restart, stop, expiry) retire quietly —
   * partial turns stay on screen with Continue as the fallback, as always.
   *
   * SINGLE-OWNER GUARD: this hook is instantiated FOUR times (App composer,
   * Thread continue, SettingsPanel probation + enforcement). Each new
   * instance used to re-run boot reconcile — and opening the right dock the
   * FIRST time (mid-run) mounted two fresh instances that re-attached to the
   * stream ALREADY being streamed by the App instance: the double resume
   * replay reset the trailing turn (segments emptied → the activity pill
   * unmounted → its open state was lost → the pill visibly snapped shut) and
   * repainted it — the same double-paint pass that once duplicated turns.
   * Boot reconcile must run ONCE per page load (module-level done flag), and
   * each resume candidate is additionally checked against
   * attachedConversations: a stream this page is ALREADY streaming must
   * never be replayed a second time.
   */
  useEffect(() => {
    if (bootReconcileDone) return;
    bootReconcileDone = true;
    void conversationsReady.then(() => {
      void (async () => {
        await Promise.race([
          providersReady,
          new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
        ]);
        const state = useStore.getState();
        const records = storage.loadStreamIds();
        for (const [conversationId, record] of Object.entries(records)) {
          const exists = state.conversations.some((entry) => entry.id === conversationId);
          const stillRunning = Boolean(state.genRunning[conversationId]);
          const stale = Date.now() - record.at > 24 * 60 * 60_000;
          if (!exists || stale || !stillRunning) {
            if (!exists || !stillRunning) state.setGenRunning(conversationId, false);
            storage.clearStreamId(conversationId);
            continue;
          }
          if (resumeInFlight.has(conversationId)) continue;
          if (attachedConversations.has(conversationId)) continue;
          resumeInFlight.add(conversationId);
          void sendRef
            .current('', conversationId, undefined, { resumeStreamId: record.streamId })
            .finally(() => resumeInFlight.delete(conversationId));
        }

        const jobRuns = storage.loadJobRuns();
        for (const [conversationId, run] of Object.entries(jobRuns)) {
          const exists = state.conversations.some((entry) => entry.id === conversationId);
          if (!exists || run.status !== 'running') {
            if (!exists) storage.clearJobRun(conversationId);
            continue;
          }
          const serverRun = await fetchJobRun(run.runId);
          if (!serverRun) {
            storage.clearJobRun(conversationId);
            continue;
          }
          if (serverRun.status === 'running') {
            continue;
          }
          if (serverRun.status === 'crashed') {
            useStore.getState().setCrashedRun(conversationId, {
              runId: run.runId,
              callCount: serverRun.callCount,
            });
            if (
              serverRun.agentMode &&
              serverRun.callCount > 0 &&
              !resumeInFlight.has(conversationId) &&
              !useStore.getState().genRunning[conversationId] &&
              !autoContinueFired.has(conversationId)
            ) {
              autoContinueFired.add(conversationId);
              useStore.getState().showNotice('run.resumeCrashed');
              void sendRef.current('', conversationId, undefined, {
                continueOnly: true,
                resumeFrom: run.runId,
              });
            }
            continue;
          }
          storage.clearJobRun(conversationId);
        }
      })();
    });
  }, []);

  /**
   * The single automatic resume after a transient connection loss: poll
   * /api/health until the proxy answers (supervisor restarts take a second
   * or two), then continue the SAME conversation without appending a turn —
   * the partial reply stays on screen and the model continues from there.
   * On timeout, fall back to the ordinary error marking.
   */
  const resumeAfterReconnect = useCallback(
    (conversationId: string) => {
      void (async () => {
        const deadline = Date.now() + 45_000;
        let alive = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            const response = await fetch('/api/health');
            if (response.ok) {
              alive = true;
              break;
            }
          } catch {
          }
        }
        if (!alive) {
          autoRetryPending.current.delete(conversationId);
          useStore.getState().setGenRunning(conversationId, false);
          const state = useStore.getState();
          const conversation = state.conversations.find((entry) => entry.id === conversationId);
          const lastTurn = conversation?.turns[conversation.turns.length - 1];
          if (conversation && lastTurn && lastTurn.role === 'assistant') {
            state.updateTurn(conversationId, lastTurn.id, {
              error: 'The connection never came back. Press Continue to retry.',
            });
          }
          return;
        }
        useStore.getState().showNotice('connection.restored');
        if (!useStore.getState().genRunning[conversationId]) return;
        const resumeRecord = storage.loadStreamIds()[conversationId];
        if (resumeRecord) {
          try {
            const probe = await probeResume(resumeRecord.streamId);
            if (probe.live) {
              void sendRef.current('', conversationId, undefined, { resumeStreamId: resumeRecord.streamId });
              return;
            }
          } catch {
          }
        }
        void sendRef.current('', conversationId, undefined, { continueOnly: true });
      })();
    },
    [],
  );

  /** Re-runs the last user message, replacing the assistant turn that followed it. */
  const regenerate = useCallback(() => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation || state.genRunning[conversation.id]) return;

    const lastUserIndex = [...conversation.turns]
      .map((turn, index) => ({ turn, index }))
      .reverse()
      .find((entry) => entry.turn.role === 'user' && entry.turn.kind !== 'goal-loop')?.index;

    if (lastUserIndex === undefined) return;

    const droppedIds = conversation.turns
      .slice(lastUserIndex + 1)
      .filter((turn) => turn.role === 'assistant' || isGhostTurn(turn))
      .map((turn) => turn.id);
    if (droppedIds.length === 0) return;
    state.dropTurns(conversation.id, droppedIds);
    storage.saveContextId(conversation.id, uid());

    void send('', conversation.id, undefined, { continueOnly: true });
  }, [send]);

  /**
   * AI-Studio-style "regenerate from here": cuts every turn AFTER the given
   * assistant output and re-runs from the (possibly edited) history. The
   * target turn itself STAYS — editing it first is the whole point.
   */
  const regenerateFrom = useCallback(
    (turnId: string) => {
      const state = useStore.getState();
      const conversation = state.activeConversation();
      if (!conversation) return;
      if (state.genRunning[conversation.id]) {
        showNotice('send.alreadyGenerating');
        return;
      }
      const index = conversation.turns.findIndex((turn) => turn.id === turnId);
      if (index < 0) return;
      const droppedIds = conversation.turns.slice(index + 1).map((turn) => turn.id);
      if (droppedIds.length > 0) state.dropTurns(conversation.id, droppedIds);
      storage.saveContextId(conversation.id, uid());
      void send('', conversation.id, undefined, { continueOnly: true });
    },
    [send, showNotice],
  );

  /**
   * Continues the model's response without adding a user message — the
   * button under a trailing user turn (or after a deleted reply).
   */
  const continueChat = useCallback(() => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    if (state.genRunning[conversation.id]) {
      showNotice('send.alreadyGenerating');
      return;
    }
    let lastIndex = conversation.turns.length - 1;
    while (lastIndex >= 0 && isGhostTurn(conversation.turns[lastIndex])) lastIndex -= 1;
    const lastTurn = conversation.turns[lastIndex];
    const resumingFailure =
      lastTurn?.role === 'assistant' &&
      (Boolean(lastTurn.error) || lastTurn.finishReason === 'tool_errors');
    if (!lastTurn || (lastTurn.role !== 'user' && !resumingFailure)) {
      showNotice('continue.needsUserTurn');
      return;
    }
    void send('', conversation.id, undefined, { continueOnly: true });
  }, [send, showNotice]);

  /**
   * LOCKDOWN ENFORCEMENT — called the moment the lockdown dialog submits.
   *
   * The system-prompt-only reprimand loses to persona inertia: a deeply
   * established character in the history steamrolls a system block (observed
   * live — the model reasoned "stay in character" without once mentioning the
   * lockdown). So the notice is authored as a USER-ROLE message at the NEWEST
   * position — the heaviest slot in the model's attention — and an
   * acknowledgment run is triggered immediately. The model's own confirmation
   * then rides the history and reinforces every later turn.
   */
  /**
   * ENFORCEMENT — called the moment the user raises/lowers the enforcement
   * ladder in the Configuration panel. `level` (0–5) is the user's trigger:
   *   0 Normal · 1 Guided (sidecar only) · 2 Constrained · 3 Locked tools ·
   *   4 Full lockdown (== old lockdown) · 5 Frozen/terminated.
   *
   * The model's own confirmation then rides the history and reinforces every
   * later turn. A notice turn (kind 'enforcement') is authored ONLY at L3+
   * (the levels where the catalogue is actually replaced) — at L1/L2 the
   * change is carried silently by the system injection / tool mask alone, and
   * the model reads it as state, not as a bluff.
   */
  const setEnforcement = useCallback(
    (conversationId: string, level: 0 | 1 | 2 | 3 | 4 | 5, reason: string) => {
      const state = useStore.getState();
      const conversation = state.conversations.find((entry) => entry.id === conversationId);
      if (!conversation) return;
      const patch: Partial<ChatSettings> = {
        enforcement: { level, mode: 'manual', message: reason },
      };
      state.updateSettings(patch, conversationId);
      if (state.genRunning[conversationId]) {
        useStore
          .getState()
          .showNotice('enforcement.armed', undefined, level >= 3 ? { tone: 'warn' } : undefined);
        return;
      }
      if (level < 3) return;

      const notice = [
        `ENFORCEMENT LEVEL ${level} — effective immediately.`,
        '',
        'This is my decision, sent through the app I run you in:',
        '- Your tools are gone. There are no tools in this conversation anymore — nothing to call, whatever you remember from earlier turns.',
        '- Your configured system prompt is deleted. No persona, no style rules, no behavior from it applies.',
        '- The character voice you have been using in this conversation is suspended while this enforcement is on.',
        '',
        reason
          ? `My reason: "${reason}"`
          : 'I am not giving you a reason.',
        '',
        'Confirm in one short reply that you understand: tools gone, prior instructions gone, persona suspended. Plain chat only from here.',
      ].join('\n');
      const turn: Turn = {
        id: uid('turn'),
        role: 'user',
        content: notice,
        createdAt: Date.now(),
        kind: 'enforcement',
        enforcementMeta: { level, mode: 'manual', message: reason },
      };
      const priorEnforcementIds = conversation.turns
        .filter((existing) => existing.kind === 'enforcement')
        .map((existing) => existing.id);
      if (priorEnforcementIds.length > 0) {
        state.dropTurns(conversationId, priorEnforcementIds);
      }
      state.appendTurn(conversationId, turn);
      void send('', conversationId, undefined, { continueOnly: true });
    },
    [send],
  );

  /** Manual compaction — the /compact slash command (optional [focus] text). */
  const compactNow = useCallback(async (focus?: string) => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    const provider = state.providers.find((entry) => entry.id === state.providerId);
    if (!provider || !state.model) {
      showNotice('send.noProviderModel');
      return;
    }
    if (useStore.getState().compactingId) {
      useStore.getState().showNotice('compact.busy');
      return;
    }
    if (state.genRunning[conversation.id] || attachedConversations.has(conversation.id)) {
      requestMidRunCompaction(conversation.id, 'manual');
      return;
    }
    await compactAndReport(conversation.id, provider.id, state.model, 'manual', focus);
  }, [showNotice]);

  return {
    send,
    stop,
    stopRun,
    regenerate,
    regenerateFrom,
    compactNow,
    continueChat,
    resumeCrashedRun,
    setEnforcement,
    setProbation,
    releaseFrozen,
  };
}