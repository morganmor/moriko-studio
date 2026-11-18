
import {
  CALL_FRAME_CHAR_WEIGHT,
  MESSAGE_FRAME_TOKENS,
  apportionBuckets,
  measureMessageWeights,
  sumTotals,
  type BucketTotals,
  type PriceMessage,
} from '../../shared/contextAccounting.js';
import type { ContextBucketsSnapshot, StreamEvent } from '../contracts.js';


const EMIT_INTERVAL_MS = 1_000;

export interface RoundUsageInput {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export interface ContextMeter {
  
  addSystemSegments(text: string): void;
  
  repriceToolMessages(count: number): void;
  
  addToolChars(chars: number): void;
  
  addInputChars(chars: number): void;
  
  addOutputChars(chars: number): void;
  
  addReasoningChars(chars: number): void;
  
  addCompletionToolChars(chars: number): void;
  
  recordUsage(
    usage: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } | undefined,
  ): void;
  
  advanceRound(options?: { keepReasoning?: boolean }): void;
  
  hasUsage(): boolean;
  
  maybeEmit(onEvent: (event: StreamEvent) => void): void;
  
  flush(onEvent: (event: StreamEvent) => void): void;
  
  snapshot(): BucketTotals & { liveContextTokens: number };
  
  snapshotBuckets(): ContextBucketsSnapshot;
}

export function createContextMeter(input: {
  systemInstruction: string;
  systemSegments?: string[];
  toolDefsChars: number;
  messages: PriceMessage[];
  replayReasoning?: boolean;
}): ContextMeter {
  // Structural char-equivalent weights used strictly as proportional shares inside
  // provider-authoritative promptTokens and completionTokens; never emitted independently.
  let systemWeight = (input.systemInstruction ?? '').length;
  for (const segment of input.systemSegments ?? []) systemWeight += segment.length;

  let toolsWeight = Math.max(0, input.toolDefsChars);
  let inputWeight = 0;
  let historyOutputWeight = 0;
  let historyReasoningWeight = 0;
  const includeHistoryReasoning = input.replayReasoning === true;

  for (const message of input.messages) {
    const weights = measureMessageWeights(message, { includeReasoning: includeHistoryReasoning });
    toolsWeight += weights.tools;
    inputWeight += weights.input;
    historyOutputWeight += weights.output;
    historyReasoningWeight += weights.reasoning;
  }

  const totals: BucketTotals = { system: 0, tools: 0, input: 0, output: 0, reasoning: 0, total: 0 };
  let hasProviderUsage = false;
  let pendingOutputChars = 0;
  let pendingReasoningChars = 0;
  let pendingCompletionToolChars = 0;
  let lastEmit = 0;

  const toBucketsSnapshot = (): ContextBucketsSnapshot => ({
    systemTokens: totals.system,
    toolsTokens: totals.tools,
    inputTokens: totals.input,
    outputTokens: totals.output,
    reasoningTokens: totals.reasoning,
    totalTokens: totals.total,
  });

  const emit = (onEvent: (event: StreamEvent) => void): void => {
    if (!hasProviderUsage) return;
    onEvent({
      type: 'context_live',
      ...toBucketsSnapshot(),
    });
    lastEmit = Date.now();
  };

  const meter: ContextMeter = {
    addSystemSegments(text) {
      systemWeight += (text ?? '').length;
    },
    repriceToolMessages(count) {
      toolsWeight += Math.max(0, count) * CALL_FRAME_CHAR_WEIGHT;
    },
    addToolChars(chars) {
      toolsWeight += Math.max(0, chars);
    },
    addInputChars(chars) {
      inputWeight += Math.max(0, chars);
    },
    addOutputChars(chars) {
      pendingOutputChars += Math.max(0, chars);
    },
    addReasoningChars(chars) {
      pendingReasoningChars += Math.max(0, chars);
    },
    addCompletionToolChars(chars) {
      pendingCompletionToolChars += Math.max(0, chars);
    },
    recordUsage(usage) {
      const providerPrompt = Math.max(0, Math.round(usage?.promptTokens ?? 0));
      const providerCompletion = Math.max(0, Math.round(usage?.completionTokens ?? 0));
      const providerReasoning = Math.max(0, Math.round(usage?.reasoningTokens ?? 0));

      if (providerPrompt === 0 && providerCompletion === 0) return;

      hasProviderUsage = true;

      const promptShares = apportionBuckets(
        providerPrompt,
        {
          system: systemWeight,
          tools: toolsWeight,
          input: inputWeight,
          output: historyOutputWeight,
          reasoning: historyReasoningWeight,
        },
        'input',
      );

      let roundReasoning = 0;
      let roundOutput = 0;
      let roundTools = 0;
      if (providerReasoning > 0) {
        roundReasoning = Math.min(providerCompletion, providerReasoning);
        const remainder = Math.max(0, providerCompletion - roundReasoning);
        const remShares = apportionBuckets(
          remainder,
          { output: pendingOutputChars, tools: pendingCompletionToolChars },
          pendingCompletionToolChars > 0 && pendingOutputChars === 0 ? 'tools' : 'output',
        );
        roundOutput = remShares.output;
        roundTools = remShares.tools;
      } else {
        const compShares = apportionBuckets(
          providerCompletion,
          {
            output: pendingOutputChars,
            reasoning: pendingReasoningChars,
            tools: pendingCompletionToolChars,
          },
          pendingCompletionToolChars > 0 && pendingOutputChars === 0 && pendingReasoningChars === 0
            ? 'tools'
            : 'output',
        );
        roundOutput = compShares.output;
        roundReasoning = compShares.reasoning;
        roundTools = compShares.tools;
      }

      totals.system = promptShares.system;
      totals.tools = promptShares.tools + roundTools;
      totals.input = promptShares.input;
      totals.output = promptShares.output + roundOutput;
      totals.reasoning = promptShares.reasoning + roundReasoning;
      totals.total = sumTotals(totals);
    },
    advanceRound(options) {
      historyOutputWeight += pendingOutputChars;
      toolsWeight += pendingCompletionToolChars;
      if (options?.keepReasoning) historyReasoningWeight += pendingReasoningChars;
      pendingOutputChars = 0;
      pendingReasoningChars = 0;
      pendingCompletionToolChars = 0;
    },
    hasUsage() {
      return hasProviderUsage;
    },
    maybeEmit(onEvent) {
      if (!hasProviderUsage) return;
      const now = Date.now();
      if (now - lastEmit >= EMIT_INTERVAL_MS) emit(onEvent);
    },
    flush(onEvent) {
      emit(onEvent);
    },
    snapshot() {
      return {
        system: totals.system,
        tools: totals.tools,
        input: totals.input,
        output: totals.output,
        reasoning: totals.reasoning,
        total: totals.total,
        liveContextTokens: totals.total,
      };
    },
    snapshotBuckets() {
      return toBucketsSnapshot();
    },
  };
  return meter;
}

export interface TurnUsageAccumulator {
  record(round: RoundUsageInput | undefined, billedTotalOverride?: number): void;
  flush(onEvent: (event: StreamEvent) => void, meter?: ContextMeter): void;
}

export function createTurnUsageAccumulator(): TurnUsageAccumulator {
  let sumPromptTokens = 0;
  let sumCompletionTokens = 0;
  let sumBilledTokens = 0;
  let sumCacheReadTokens = 0;
  let sawAnyUsage = false;
  let flushed = false;
  let lastRound: RoundUsageInput | undefined;

  return {
    record(round, billedTotalOverride) {
      if (!round) return;
      sawAnyUsage = true;
      flushed = false;
      lastRound = round;
      sumPromptTokens += round.promptTokens ?? 0;
      sumCompletionTokens += round.completionTokens ?? 0;
      sumBilledTokens +=
        billedTotalOverride ??
        round.totalTokens ??
        (round.promptTokens ?? 0) + (round.completionTokens ?? 0);
      sumCacheReadTokens += round.cacheReadTokens ?? 0;
    },
    flush(onEvent, meter) {
      if (!sawAnyUsage || flushed) return;
      flushed = true;
      onEvent({
        type: 'usage',
        promptTokens: sumPromptTokens > 0 ? sumPromptTokens : undefined,
        completionTokens: sumCompletionTokens,
        totalTokens: sumBilledTokens,
        cacheReadTokens: sumCacheReadTokens > 0 ? sumCacheReadTokens : undefined,
        lastPromptTokens: lastRound?.promptTokens,
        lastCompletionTokens: lastRound?.completionTokens,
        lastReasoningTokens: lastRound?.reasoningTokens,
        ...(meter?.hasUsage() ? { lastBuckets: meter.snapshotBuckets() } : {}),
      });
    },
  };
}

export { MESSAGE_FRAME_TOKENS };
