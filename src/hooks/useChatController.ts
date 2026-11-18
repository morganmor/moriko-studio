import { useCallback, useEffect, useRef } from 'react';

import { ApiError, coerceDelta, fetchConversationDetail, fetchJobRun, fetchLiveStreams, openBrowserPanelOnce, patchConversationConfig, probeResume, pushCompactionConfig, streamChat, sweepTodosApi, uploadAttachment } from '../lib/api';
import { ensureLivePolling, refreshLiveStreamsNow, subscribeLivePolls } from '../store/livePoller';
import {
  abortCompaction,
  applyCompaction,
  COMPACT_INSTRUCTION,
  COMPACT_SYSTEM_INSTRUCTION,
  clearCompactionAbort,
  compactCandidate,
  contextBreakdown,
  contextPlan,
  getCompactionCheckpoints,
  isCheckpointShape,
  measuredActiveTokens,
  registerCompactionAbort,
  shouldAutoCompact,
  stripCompactionAnalysis,
  summarizationReplay,
  triggerForMeasuredTokens,
  type CompactTrigger,
} from '../lib/compaction';
import { splitInlineThinking, stripInlineThinking } from '../lib/reasoning';
import { isGhostTurn, nextSegmentId } from '../lib/turns';
import { awaitConfigSync, useStore, conversationsReady, providersReady, resolveCapability } from '../store/useStore';
import type { ChatMessage, ChatSettings, LiveContextTelemetry, Turn, TurnAttachment, TrustTier } from '../types';
import { storage, uid } from '../lib/storage';
import { scanOutput, tierState, violationEvidence, violationsToTier } from '../lib/trust';




function autoTitleFor(firstUserMessage: string): string {
  const text = firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 52);
  if (text.length >= 4) return text;
  return 'New chat';
}


export interface CompactionFailure {
  
  message: string;
}

async function runCompaction(input: {
  conversationId: string;
  providerId: string;
  model: string;
  settings: ChatSettings;
  apiKey?: string;
  trigger: Exclude<CompactTrigger, null>;
  
  focus?: string;
  
  signal?: AbortSignal;
}): Promise<
  | {
      covered: number;
      replacedTokens: number;
      summaryTokens?: number;
      cumulativeSummaryTokens: number;
      checkpointCount: number;
      prePassed?: boolean;
    }
  | CompactionFailure
  | null
> {
  if (useStore.getState().compactingId === input.conversationId) return null;
  useStore.getState().setCompacting(input.conversationId);
  const owned = new AbortController();
  const relay = () => owned.abort();
  input.signal?.addEventListener('abort', relay, { once: true });
  registerCompactionAbort(input.conversationId, relay);
  try {
    return await runCompactionInner({ ...input, signal: owned.signal });
  } catch (error) {
    if (owned.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    return { message: message || 'The summarization request failed.' };
  } finally {
    input.signal?.removeEventListener('abort', relay);
    clearCompactionAbort(input.conversationId);
    if (useStore.getState().compactingId === input.conversationId) {
      useStore.getState().setCompacting(null);
    }
  }
}

async function runCompactionInner(input: {
  conversationId: string;
  providerId: string;
  model: string;
  settings: ChatSettings;
  apiKey?: string;
  trigger: Exclude<CompactTrigger, null>;
  
  focus?: string;
  
  signal?: AbortSignal;
}): Promise<
  | {
      covered: number;
      replacedTokens: number;
      summaryTokens?: number;
      cumulativeSummaryTokens: number;
      checkpointCount: number;
      prePassed?: boolean;
    }
  | CompactionFailure
  | null
> {
  const state = useStore.getState();
  const conversation = state.conversations.find((entry) => entry.id === input.conversationId);
  if (!conversation) return null;
  const candidate = compactCandidate(conversation);
  if (!candidate) return null;

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
    const plan = contextPlan(conversation);
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
      | {
          summary: string;
          usage?: { promptTokens?: number; completionTokens?: number };
        }
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
      let usage: { promptTokens?: number; completionTokens?: number } | undefined;
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
              useStore.getState().updateTurn(input.conversationId, noteId, {
                content: stripCompactionAnalysis(text),
              });
            }
          } else if (event.type === 'usage') {
            if (
              typeof event.promptTokens === 'number' ||
              typeof event.completionTokens === 'number'
            ) {
              usage = {
                ...(typeof event.promptTokens === 'number'
                  ? { promptTokens: event.promptTokens }
                  : {}),
                ...(typeof event.completionTokens === 'number'
                  ? { completionTokens: event.completionTokens }
                  : {}),
              };
            }
          } else if (event.type === 'error') {
            return { error: event.message ?? 'The summarization request failed.' };
          } else if (event.type === 'tool_call' || event.type === 'tool_result') {
            return { toolViolation: true };
          }
        }
        return { summary: text, usage };
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return { aborted: true };
        }
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };

    let summary = '';
    let resolvedUsage: { promptTokens?: number; completionTokens?: number } | undefined;
    let resolved = false;
    let lastError = '';
    for (const attempt of attempts) {
      const result = await summarizeOnce(attempt);
      if ('aborted' in result) return null;
      if ('summary' in result) {
        const trimmed = stripCompactionAnalysis(stripInlineThinking(result.summary)).trim();
        if (trimmed) {
          summary = trimmed;
          resolvedUsage = result.usage;
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
    const actualSourceTokens = resolvedUsage?.promptTokens ?? candidate.replacedTokens;
    const actualSummaryTokens = resolvedUsage?.completionTokens;
    if (
      typeof actualSummaryTokens === 'number' &&
      actualSummaryTokens > 0 &&
      actualSourceTokens > 0 &&
      actualSummaryTokens >= actualSourceTokens
    ) {
      return {
        message: `The checkpoint did not shrink the covered material (${actualSummaryTokens} vs ${actualSourceTokens} source tokens) — nothing was replaced. Compact again or switch models.`,
      };
    }

    const applied = applyCompaction(
      conversation,
      {
        summary,
        coveredTurnIds: coveredIds,
        replacedTokens: actualSourceTokens,
        sourceTokens: actualSourceTokens,
        ...(typeof actualSummaryTokens === 'number'
          ? { summaryTokens: actualSummaryTokens }
          : {}),
      },
      input.trigger,
    );
    committed = true;
    useStore.getState().setCompaction(input.conversationId, applied.compaction);
    useStore.getState().updateTurn(input.conversationId, noteId, {
      content: summary,
      compactionMeta: {
        covered: candidate.turns.length,
        replacedTokens: actualSourceTokens,
        trigger: input.trigger,
      },
    });
    const checkpoints = getCompactionCheckpoints(applied.compaction);
    const cumulativeSummaryTokens = checkpoints.reduce(
      (sum, cp) => sum + (typeof cp.summaryTokens === 'number' ? cp.summaryTokens : 0),
      0,
    );
    return {
      covered: candidate.turns.length,
      replacedTokens: actualSourceTokens,
      ...(typeof actualSummaryTokens === 'number' ? { summaryTokens: actualSummaryTokens } : {}),
      cumulativeSummaryTokens,
      checkpointCount: checkpoints.length,
    };

  } finally {
    if (!committed) useStore.getState().deleteTurn(input.conversationId, noteId);
  }
}


const FORCED_FINISH_REASONS = new Set([
  
  'context_budget',
  'stalled',
  'length',
  'max_tokens',
  'MAX_TOKENS',
]);


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



const abortsRef: { current: Map<string, AbortController> } = {
  current: new Map<string, AbortController>(),
};


const CONNECTION_LOSS_PATTERN =
  /cannot reach the local moriko proxy|failed to fetch|fetch failed|networkerror|network error|socket hang up|econn(?:refused|reset|aborted)|premature close|other side closed|terminated/i;

function isConnectionLoss(message: string): boolean {
  return CONNECTION_LOSS_PATTERN.test(message);
}


const autoRetryPending: { current: Set<string> } = {
  current: new Set<string>(),
};


const resumeInFlight = new Set<string>();


const attachedConversations = new Set<string>();


const stoppedStreams = new Map<string, string | null>();


const pendingMidRunCompaction = new Map<string, Exclude<CompactTrigger, null>>();


const midRunCompactingInFlight = new Set<string>();


const midRunCompactedThisRun = new Set<string>();


const userStoppedRuns = new Set<string>();


const runSettled = new Set<string>();


function syncLiveContextAfterCompaction(
  conversationId: string,
  cumulativeSummaryTokens: number,
): LiveContextTelemetry {
  const state = useStore.getState();
  const conversation = state.conversations.find((entry) => entry.id === conversationId);
  const prev = state.liveContext[conversationId] ?? conversation?.liveContext;
  const fallbackBreakdown = conversation
    ? contextBreakdown(
        conversation,
        resolveCapability(
          conversation.providerId || state.providerId,
          conversation.model || state.model,
        ),
        prev,
      )
    : null;
  const systemTokens = prev?.buckets?.systemTokens ?? fallbackBreakdown?.systemTokens ?? 0;
  const toolsTokens = prev?.buckets?.toolsTokens ?? fallbackBreakdown?.toolsTokens ?? 0;
  const activeTokens = systemTokens + toolsTokens + cumulativeSummaryTokens;
  const contextLimit = prev?.contextLimit ?? fallbackBreakdown?.effectiveLimit ?? null;
  const telemetry: LiveContextTelemetry = {
    promptTokens: activeTokens,
    completionTokens: 0,
    addedTokens: 0,
    liveContextTokens: activeTokens,
    contextLimit,
    ratio: contextLimit ? Math.min(1, activeTokens / contextLimit) : null,
    buckets: {
      systemTokens,
      toolsTokens,
      inputTokens: cumulativeSummaryTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: activeTokens,
    },
    at: Date.now(),
  };
  state.setLiveContext(conversationId, telemetry);
  void patchConversationConfig(conversationId, { liveContext: telemetry });
  return telemetry;
}


async function compactAndReport(
  conversationId: string,
  providerId: string,
  model: string,
  trigger: Exclude<CompactTrigger, null>,
  focus?: string,
): Promise<boolean> {
  const conversation = useStore.getState().conversations.find((entry) => entry.id === conversationId);
  if (!conversation) return false;
  const outcome = await runCompaction({
    conversationId,
    providerId,
    model,
    settings: conversation.settings,
    trigger,
    focus,
  });
  const showNotice = useStore.getState().showNotice;
  if (outcome && 'covered' in outcome) {
    syncLiveContextAfterCompaction(conversationId, outcome.cumulativeSummaryTokens);
    await awaitConfigSync(conversationId);
    if (outcome.prePassed) {
      showNotice('compact.prePassed');
    } else {
      showNotice('compact.manualDone', { turns: outcome.covered });
    }
    return true;
  }
  if (outcome && 'message' in outcome) {
    showNotice('compact.failedReason', { message: outcome.message });
  } else if (trigger === 'manual') {
    showNotice('compact.nothing');
  }
  return false;
}


function requestMidRunCompaction(
  conversationId: string,
  trigger: Exclude<CompactTrigger, null>,
): void {
  if (pendingMidRunCompaction.has(conversationId)) return;
  if (midRunCompactingInFlight.has(conversationId)) return;
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


async function resumeAfterInRunCompaction(
  conversationId: string,
  compactionSegment?: { assistantTurnId: string; beforeTokens: number },
): Promise<void> {
  const state = useStore.getState();
  const conversation = state.conversations.find((entry) => entry.id === conversationId);
  if (!conversation) return;
  const providerId = conversation.providerId || state.providerId;
  const provider = state.providers.find((entry) => entry.id === providerId);
  const model = conversation.model || state.model;
  const caps = resolveCapability(providerId, model);
  const tokensBefore = measuredActiveTokens(conversation, caps, state.liveContext[conversationId]);

  let compacted = false;
  if (provider && model) {
    const busyDeadline = Date.now() + 90_000;
    while (useStore.getState().compactingId === conversationId && Date.now() < busyDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }

    const latestConv = useStore
      .getState()
      .conversations.find((entry) => entry.id === conversationId);
    const candidate = latestConv ? compactCandidate(latestConv) : null;
    if (candidate) {
      compacted = await compactAndReport(conversationId, provider.id, model, 'context-limit').catch(
        () => false,
      );
      if (!compacted) {
        midRunCompactedThisRun.delete(conversationId);
        return;
      }
    } else {
      compacted = true;
    }

    const afterState = useStore.getState();
    const after = afterState.conversations.find((entry) => entry.id === conversationId);
    const afterTokens = after
      ? measuredActiveTokens(after, caps, afterState.liveContext[conversationId])
      : 0;
    if (after && afterTokens < tokensBefore) {
      midRunCompactedThisRun.add(conversationId);
    } else {
      midRunCompactedThisRun.delete(conversationId);
    }

    if (compactionSegment && after) {
      const targetTurn = after.turns.find((entry) => entry.id === compactionSegment.assistantTurnId);
      const checkpoints = getCompactionCheckpoints(after.compaction);
      const latestCheckpoint = checkpoints[checkpoints.length - 1];
      const existingSegments = targetTurn?.segments ?? [];
      afterState.updateTurn(conversationId, compactionSegment.assistantTurnId, {
        segments: [
          ...existingSegments,
          {
            type: 'compaction',
            id: `compact-${Date.now()}`,
            beforeTokens: compactionSegment.beforeTokens,
            afterTokens,
            coveredTurns:
              latestCheckpoint?.coveredTurnIds.length ?? after.compaction?.coveredTurnIds.length ?? 0,
            summary: latestCheckpoint?.summary ?? after.compaction?.summary ?? '',
            at: Date.now(),
          },
        ],
      });
    }
  } else {
    return;
  }

  if (!compacted || userStoppedRuns.has(conversationId)) return;

  await awaitConfigSync(conversationId);
  const dispatched = await sendForLoop(conversationId, { continueOnly: true });
  if (!dispatched) {
    useStore.getState().showNotice('compact.continueHint');
  }
}


async function settleMidRunCompaction(conversationId: string): Promise<void> {
  if (midRunCompactingInFlight.has(conversationId)) return;
  midRunCompactingInFlight.add(conversationId);
  try {
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

    const caps = resolveCapability(providerId, model);
    const tokensBefore = measuredActiveTokens(conversation, caps, state.liveContext[conversationId]);

    const compacted = await compactAndReport(conversationId, provider.id, model, trigger).catch(
      () => false,
    );

    const afterState = useStore.getState();
    const after = afterState.conversations.find((entry) => entry.id === conversationId);
    const afterTokens = after
      ? measuredActiveTokens(after, caps, afterState.liveContext[conversationId])
      : 0;
    if (compacted && after && afterTokens < tokensBefore) {
      midRunCompactedThisRun.add(conversationId);
    } else {
      midRunCompactedThisRun.delete(conversationId);
    }

    if (!compacted) return;
    if (userStoppedRuns.has(conversationId)) return;
    if (afterState.genRunning[conversationId]) return;
    if (!(await serverRunGone(conversationId))) {
      afterState
        .showNotice('compact.continueHint');
      return;
    }
    await awaitConfigSync(conversationId);
    await sendForLoop(conversationId, { continueOnly: true });
  } finally {
    midRunCompactingInFlight.delete(conversationId);
  }
}


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


const orphanedSince = new Map<string, number>();
const ORPHANED_FLAG_MS = 9_000;


const REATTACH_COOLDOWN_MS = 8_000;
const REATTACH_MAX_ATTEMPTS = 3;
const resumeAttemptAt = new Map<string, number>();
const resumeAttempts = new Map<string, number>();


const FOLLOW_CADENCE_MS = 5_000;
const followRefreshAt = new Map<string, number>();

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


function resetReattachBookkeeping(conversationId: string): void {
  resumeAttemptAt.delete(conversationId);
  resumeAttempts.delete(conversationId);
  resetFollowBookkeeping(conversationId);
}


let sendForLiveLoop:
  | ((
      text: string,
      conversationId: string,
      attachments?: unknown,
      opts?: { resumeStreamId?: string; continueOnly?: boolean },
    ) => Promise<void>)
  | null = null;


async function sendForLoop(
  conversationId: string,
  opts: { continueOnly?: boolean; resumeStreamId?: string },
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (!sendForLiveLoop && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  const dispatch = sendForLiveLoop;
  if (!dispatch) return false;
  await dispatch('', conversationId, undefined, opts);
  return true;
}

let liveLoopStarted = false;


let bootReconcileDone = false;


const autoContinueFired = new Set<string>();


const PROVIDER_RETRY_DELAYS_MS = [2_000, 4_000, 6_000, 12_000, 14_000, 16_000, 32_000, 34_000, 36_000, 60_000];


const providerRetries: { current: Map<string, number> } = {
  current: new Map<string, number>(),
};


const lastProviderFailure: { current: Map<string, string> } = {
  current: new Map<string, string>(),
};


const PROVIDER_ERROR_PATTERN =
  /generation failed|inference request failed|upstream failure|upstream error|upstream request failed|fetch failed|failed to fetch|internal server error|bad gateway|service unavailable|gateway timeout|server error|timeout|aborted|empty response/i;


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

  
  const pushedCompactionRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const evaluate = (): void => {
      const state = useStore.getState();
      for (const conversation of state.conversations) {
        const running =
          Boolean(state.genRunning[conversation.id]) || attachedConversations.has(conversation.id);
        if (!running) {
          pushedCompactionRef.current.delete(conversation.id);
          continue;
        }
        const settings = conversation.settings;
        const fingerprint = [
          settings.autoCompact,
          settings.compactThresholdTokens,
          settings.compactThresholdRatio,
          settings.maxContextTokens,
        ].join('|');
        if (pushedCompactionRef.current.get(conversation.id) === fingerprint) continue;
        pushedCompactionRef.current.set(conversation.id, fingerprint);
        void pushCompactionConfig(conversation.id, {
          autoCompact: settings.autoCompact,
          compactThresholdTokens: settings.compactThresholdTokens ?? null,
          compactThresholdRatio: settings.compactThresholdRatio ?? null,
          maxContextTokens: settings.maxContextTokens ?? null,
        }).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          useStore.getState().showNotice('compact.configFailed', undefined, { detail });
        });
        const caps = resolveCapability(
          conversation.providerId || state.providerId,
          conversation.model || state.model,
        );
        const trigger = triggerForMeasuredTokens(
          settings,
          caps,
          measuredActiveTokens(conversation, caps, state.liveContext[conversation.id]),
        );
        if (trigger) requestMidRunCompaction(conversation.id, trigger);
      }
    };
    evaluate();
    return useStore.subscribe(evaluate);
  }, []);

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
    if (useStore.getState().compactingId === id) {
      abortCompaction(id);
      useStore.getState().setCompacting(null);
    }
  }, []);

  
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
    if (useStore.getState().compactingId === id) {
      abortCompaction(id);
      useStore.getState().setCompacting(null);
    }
  }, []);

  
  const resumeCrashedRun = useCallback((conversationId: string, runId: string) => {
    useStore.getState().setCrashedRun(conversationId, null);
    void send('', conversationId, undefined, { continueOnly: true, resumeFrom: runId });
  }, []);

  
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
        continueSeized: false,
      },
    });

    if (!live.settings.probation?.enabled) {
      state.updateSettings({ probation: { enabled: true } }, conversationId);
    }

    if (level === 1) {
      useStore.getState().showNotice('probation.reset');
      return;
    }

    useStore
      .getState()
      .showNotice(
        level === 4 ? 'probation.tier4Frozen' : 'probation.setManual',
        level === 4 ? undefined : { tier: level },
        level >= 3 ? { tone: 'warn' } : undefined,
      );
  }, []);

  
  const releaseFrozen = useCallback(
    (conversationId: string, _turnId: string, choice: 'apologize' | 'continue') => {
      const state = useStore.getState();
      const conversation = state.conversations.find((entry) => entry.id === conversationId);
      if (!conversation) return;

      if (choice === 'apologize') {
        state.patchConversation(conversationId, {
          trust: { level: 4, outputFrozen: false, escalatedAt: conversation.trust?.escalatedAt, continueSeized: false },
        });
        useStore.getState().showNotice('probation.apologized');
        const abort = abortsRef.current.get(conversationId);
        if (abort) abort.abort();
        else state.setGenRunning(conversationId, false);
        return;
      }
      const continueCount = (conversation.trust?.continueCount ?? 0) + 1;
      state.patchConversation(conversationId, {
        trust: {
          level: conversation.trust?.level ?? 4,
          outputFrozen: true,
          escalatedAt: conversation.trust?.escalatedAt,
          continueCount,
          continueSeized: conversation.trust?.continueSeized === true,
        },
      });
      useStore
        .getState()
        .showNotice('probation.continueBurning', { count: continueCount });
    },
    [],
  );

  
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
      
      opts?: {
        continueOnly?: boolean;
        resumeStreamId?: string;
        
        resumeFrom?: string;
        
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
      await awaitConfigSync(conversationId);

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

      const runCaps = resolveCapability(runProviderId, runModel);
      const measured = resume || continueOnly
        ? null
        : shouldAutoCompact(
            conversation,
            runCaps,
            0,
            useStore.getState().liveContext[conversationId],
          );
      const busyHere = measured !== null && useStore.getState().compactingId === conversation.id;
      let trigger = busyHere ? null : measured;
      if (busyHere) {
        useStore.getState().showNotice('compact.skippedBusy');
      }
      if (trigger) {
        try {
          const outcome = await runCompaction({
            conversationId,
            providerId: runProviderId,
            model: runModel,
            settings: conversation.settings,
            trigger,
            signal: controller.signal,
          });
          if (outcome && 'covered' in outcome) {
            syncLiveContextAfterCompaction(conversationId, outcome.cumulativeSummaryTokens);
            await awaitConfigSync(conversationId);
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
          ).messages;

      let assistantTurn: Turn;
      
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
      
      let forcedFinish: string | undefined;
      
      let guardCompaction: { liveContextTokens: number; contextLimit: number | null } | null = null;
      let failedTool = false;
      
      let failedToolSteps = 0;
      let sawProgressAfterToolError = false;
      const segments: import('../types').TurnSegment[] = [];
      const injections: import('../types').TurnInjection[] = [];
      
      const harnessEvents: import('../types').TurnHarnessEvent[] = [];
      
      let toolsDefsChars: number | undefined;
      const steers: import('../types').TurnSteer[] = [];
      
      let pressureTimer: number | null = null;
      
      const currentTurnEvents = () => {
        const conv = useStore.getState().conversations.find((c) => c.id === conversationId);
        const t = conv?.turns.find((x) => x.id === assistantTurn.id);
        return t?.harnessEvents ?? [];
      };

      let flushTimer: number | null = null;
	  let flushViaRaf = false;
      
      let building$: Turn['building'];
      
      let inFlight$: Turn['inFlightTool'];
      
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
          ...(building$ ? { building: building$ } : {}),
          inFlightTool: inFlight$,
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
        else segments.push({ id: nextSegmentId('text'), type: 'text', text: delta });
        text$ += delta;
      };
      
      const reasoningSegments = new Map<string, Extract<import('../types').TurnSegment, { type: 'reasoning' }>>();

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
          const liveConv = useStore.getState().conversations.find((entry) => entry.id === conversationId);
          if (!liveConv) return;
          const liveCaps = resolveCapability(liveConv.providerId, liveConv.model);
          const auto = triggerForMeasuredTokens(
            liveConv.settings,
            liveCaps,
            measuredActiveTokens(liveConv, liveCaps, useStore.getState().liveContext[conversationId]),
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
            case 'reasoning_start': {
              const id = event.blockId ?? nextSegmentId('reason');
              const segment = { id, type: 'reasoning' as const, text: '', status: 'streaming' as const };
              reasoningSegments.set(id, segment);
              segments.push(segment);
              flushNow();
              break;
            }
            case 'reasoning': {
              const delta = event.delta ?? '';
              if (!delta) break;
              reasoning += delta;
              
              const blockId = event.blockId;
              const open = blockId
                ? reasoningSegments.get(blockId)
                : [...segments].reverse().find(
                    (segment): segment is Extract<import('../types').TurnSegment, { type: 'reasoning' }> =>
                      segment.type === 'reasoning' && segment.status === 'streaming',
                  );
              if (open) {
                open.text += delta;
              } else {
                const id = blockId ?? nextSegmentId('reason');
                const segment = { id, type: 'reasoning' as const, text: delta, status: 'streaming' as const };
                reasoningSegments.set(id, segment);
                segments.push(segment);
              }
              scheduleFlush();
              break;
            }
            case 'reasoning_end': {
              const segment = event.blockId ? reasoningSegments.get(event.blockId) : undefined;
              if (segment) segment.status = 'done';
              else {
                const tail = [...segments]
                  .reverse()
                  .find((entry) => entry.type === 'reasoning' && entry.status === 'streaming');
                if (tail && tail.type === 'reasoning') tail.status = 'done';
              }
              flushNow();
              break;
            }
            case 'tool_building': {
              
              const frame = event.building;
              if (!frame) break;
              
              const head = frame.tools[frame.tools.length - 1];
              if (head && head.name) {
                inFlight$ = {
                  name: head.name,
                  status: 'streaming',
                  startedAt: inFlight$?.startedAt ?? Date.now(),
                };
              }
              building$ = {
                at: event.at ?? Date.now(),
                count: frame.count,
                bytes: frame.bytes,
                tools: frame.tools,
              };
              flushNow();
              break;
            }
            case 'tool_call': {
              
              const name = event.toolName ?? '?';
              const existing = event.toolCallId
                ? segments.findIndex(
                    (segment) => segment.type === 'tool' && segment.toolCallId === event.toolCallId,
                  )
                : -1;
              building$ = undefined;
              inFlight$ = {
                name,
                status: 'executing',
                startedAt: inFlight$?.startedAt ?? Date.now(),
              };
              if (existing >= 0) {
                const known = segments[existing] as Extract<import('../types').TurnSegment, { type: 'tool' }>;
                segments[existing] = {
                  ...known,
                  serverName: event.serverName ?? known.serverName,
                  toolName: name,
                  args: event.args ?? known.args,
                  building: false,
                };
              } else {
                segments.push({
                  id: nextSegmentId('tool'),
                  type: 'tool',
                  toolCallId: event.toolCallId,
                  serverName: event.serverName ?? '?',
                  toolName: name,
                  args: event.args,
                  startedAt: Date.now(),
                });
              }
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
                const resultText =
                  coerceDelta(event.summary) ??
                  (typeof event.summary === 'string' ? event.summary : '');
                const payloadText = resultText + (event.diff ?? '');
                segments[i] = {
                  ...segment,
                  toolCallId: segment.toolCallId ?? event.toolCallId,
                  summary: resultText,
                  ok: event.ok !== false,
                  payloadBytes: payloadText
                    ? new TextEncoder().encode(payloadText).length
                    : undefined,
                  diff: event.diff,
                  diffstat: event.diffstat,
                  toolImages: event.images,
                  visual: event.visual,
                };
                if (event.panelUrl && event.ok !== false) {
                  openBrowserPanelOnce(event.panelUrl, conversationId);
                }
                if (event.ok === false) {
                  failedTool = true;
                  failedToolSteps += 1;
                } else if (failedTool) {
                  sawProgressAfterToolError = true;
                }
                inFlight$ = undefined;
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
                  if (event.ok !== false) {
                    void releaseFrozen(conversationId, assistantTurn.id, choice);
                  }
                }
                break;
              }
              
              const awaitingResult = segments.some(
                (segment) => segment.type === 'tool' && segment.summary === undefined,
              );
              if (!awaitingResult) {
                inFlight$ = undefined;
                building$ = undefined;
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
                skill: event.skill,
              });
              break;
            }
            case 'permission_result': {
              useStore.getState().removePermissionRequest(event.id ?? '');
              break;
            }
            case 'ask_user_request': {
              if (event.request?.id && 'questions' in event.request) {
                useStore.getState().pushAskUserRequest(event.request);
              }
              break;
            }
            case 'ask_user_result': {
              useStore.getState().removeAskUserRequest(event.id ?? '');
              break;
            }
            case 'operator_gate_request': {
              if (event.request?.id && 'kind' in event.request) {
                useStore.getState().pushOperatorGate(event.request);
              }
              break;
            }
            case 'operator_gate_result': {
              const gateStore = useStore.getState();
              const decidedGate = gateStore.pendingOperatorGates.find((entry) => entry.id === (event.id ?? ''));
              gateStore.removeOperatorGate(event.id ?? '');
              if (decidedGate?.kind === 'seize_choice' && event.verdict === 'accept') {
                const seizedConv = gateStore.conversations.find((entry) => entry.id === conversationId);
                if (seizedConv) {
                  gateStore.patchConversation(conversationId, {
                    trust: { ...seizedConv.trust, continueSeized: true } as NonNullable<typeof seizedConv.trust>,
                  });
                }
              }
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
                  ...(event.lastPromptTokens !== undefined
                    ? { lastPromptTokens: event.lastPromptTokens }
                    : {}),
                  ...(event.lastCompletionTokens !== undefined
                    ? { lastCompletionTokens: event.lastCompletionTokens }
                    : {}),
                  ...(event.lastReasoningTokens !== undefined
                    ? { lastReasoningTokens: event.lastReasoningTokens }
                    : {}),
                  ...(event.lastBuckets ? { lastBuckets: event.lastBuckets } : {}),
                },
              });
              if (typeof event.promptTokens === 'number' && event.promptTokens > 0) {
                const liveConv = useStore
                  .getState()
                  .conversations.find((entry) => entry.id === conversationId);
                if (liveConv) {
                  const liveCaps = resolveCapability(liveConv.providerId, liveConv.model);
                  const auto = triggerForMeasuredTokens(
                    liveConv.settings,
                    liveCaps,
                    measuredActiveTokens(liveConv, liveCaps, useStore.getState().liveContext[conversationId]),
                  );
                  if (auto) requestMidRunCompaction(conversationId, auto);
                }
              }
              break;
            case 'context_tools':
              if (typeof event.chars === 'number') toolsDefsChars = event.chars;
              break;
            case 'context_telemetry': {
              const current = useStore.getState().liveContext[conversationId];
              const nextLive =
                event.liveContextTokens && event.liveContextTokens > 0
                  ? event.liveContextTokens
                  : (current?.liveContextTokens ?? 0);
              const telemetry: LiveContextTelemetry = {
                promptTokens: event.promptTokens ?? 0,
                completionTokens: event.completionTokens ?? 0,
                addedTokens: event.addedTokens ?? 0,
                liveContextTokens: nextLive,
                contextLimit: event.contextLimit ?? current?.contextLimit ?? null,
                ratio: event.ratio ?? current?.ratio ?? null,
                buckets: current?.buckets,
                at: Date.now(),
              };
              useStore.getState().setLiveContext(conversationId, telemetry);
              break;
            }
            case 'context_live': {
              const current = useStore.getState().liveContext[conversationId];
              const buckets = {
                systemTokens: event.systemTokens ?? 0,
                toolsTokens: event.toolsTokens ?? 0,
                inputTokens: event.inputTokens ?? 0,
                outputTokens: event.outputTokens ?? 0,
                reasoningTokens: event.reasoningTokens ?? 0,
                totalTokens: event.totalTokens ?? 0,
              };
              const liveTotal =
                buckets.totalTokens > 0
                  ? buckets.totalTokens
                  : buckets.systemTokens +
                    buckets.toolsTokens +
                    buckets.inputTokens +
                    buckets.outputTokens +
                    buckets.reasoningTokens;
              useStore.getState().setLiveContext(conversationId, {
                promptTokens: current?.promptTokens ?? 0,
                completionTokens: current?.completionTokens ?? 0,
                addedTokens: current?.addedTokens ?? 0,
                liveContextTokens: liveTotal,
                contextLimit: current?.contextLimit ?? null,
                ratio: current?.contextLimit
                  ? Math.min(1, liveTotal / current.contextLimit)
                  : null,
                buckets: { ...buckets, totalTokens: liveTotal },
                at: Date.now(),
              });
              break;
            }
            case 'context_compaction_request': {
              guardCompaction = {
                liveContextTokens: event.liveContextTokens ?? 0,
                contextLimit: event.contextLimit ?? null,
              };
              break;
            }
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
        const freezeUnsettled =
          postRun?.trust?.outputFrozen === true &&
          !controller.signal.aborted &&
          !failure &&
          !connectionLost;
        if (freezeUnsettled) {
          const evaded = !frozenChoiceHandled && outputBlocked;
          const count = (postRun?.trust?.continueCount ?? 0) + 1;
          useStore.getState().patchConversation(conversationId, {
            trust: {
              ...postRun.trust,
              continueCount: count,
              ...(evaded ? { evadeAt: Date.now() } : {}),
            } as NonNullable<typeof postRun.trust>,
          });
          void send('', conversationId, undefined, { continueOnly: true });
          useStore
            .getState()
            .showNotice(evaded ? 'probation.evadeReminder' : 'probation.continueBurning', { count });
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
        useStore.getState().settleLiveContext(conversationId);
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

      
      if (!controller.signal.aborted && forcedFinish === 'context_compaction' && !failure) {
        const beforeTokens =
          guardCompaction?.liveContextTokens ??
          useStore.getState().liveContext[conversationId]?.liveContextTokens ??
          0;
        void resumeAfterInRunCompaction(conversationId, {
          assistantTurnId: assistantTurn.id,
          beforeTokens,
        });
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
        failedToolSteps >= 3 &&
        !sawProgressAfterToolError &&
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
      
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (segment.type !== 'reasoning') continue;
        if (segment.status === 'streaming') segment.status = 'done';
        if (!segment.text.trim()) segments.splice(i, 1);
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
            const entry = trimmed[i];
            if (entry.type === 'text') {
              trimmed[i] = { ...entry, type: 'text', text: split.content };
              break;
            }
          }
          if (split.reasoning && !trimmed.some((segment) => segment.type === 'reasoning')) {
            trimmed.unshift({
              id: nextSegmentId('reason'),
              type: 'reasoning',
              text: split.reasoning,
              status: 'done',
            });
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

      // END-OF-TURN TODO SWEEP — the safety net behind the agent's cleanup
      // with every todo completed but never deleted by the model gets its
      // panel cleaned. todos.json keeps the entries; the panel hides swept ones.
      if (naturalStop && !controller.signal.aborted && !failure && !connectionLost) {
        const todosNow = useStore
          .getState()
          .conversations.find((entry) => entry.id === conversationId)?.todos;
        const allDone = Boolean(todosNow?.length) && todosNow!.every((todo) => todo.done);
        const hasUnswept = todosNow?.some((todo) => !todo.sweptAt) ?? false;
        if (allDone && hasUnswept) {
          void sweepTodosApi(conversationId)
            .then((fresh) => useStore.getState().setConversationTodos(conversationId, fresh))
            .catch(() => undefined);
        }
      }

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

  
  const sendRef = useRef(send);
  sendRef.current = send;
  sendForLiveLoop = send as typeof sendForLiveLoop;

  
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

  
  const setEnforcement = useCallback(
    (conversationId: string, level: 0 | 1 | 2 | 3 | 4 | 5, reason: string) => {
      const state = useStore.getState();
      const patch: Partial<ChatSettings> = {
        enforcement: { level, mode: 'manual', message: reason },
      };
      state.updateSettings(patch, conversationId);
      useStore
        .getState()
        .showNotice('enforcement.armed', undefined, level >= 3 ? { tone: 'warn' } : undefined);
    },
    [],
  );

  
  const compactNow = useCallback(async (focus?: string) => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    const provider = state.providers.find((entry) => entry.id === state.providerId);
    if (!provider || !state.model) {
      showNotice('send.noProviderModel');
      return;
    }
    if (useStore.getState().compactingId === conversation.id) {
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