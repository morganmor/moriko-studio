import type {
  ChatMessage,
  ChatSettings,
  CompactionCheckpoint,
  Conversation,
  ConversationCompaction,
  MessageContentPart,
  ModelCapabilitySource,
  Turn,
  TurnToolCall,
} from '../types';
import type { ResolvedModelCapability } from './modelCapability';
import { attachmentRefWireUrl } from './api';
import {
  apportionBuckets,
  CHARS_PER_TOKEN,
  FRAME_CHAR_WEIGHT,
  measureMessageWeights,
  type PriceMessage,
} from '../../shared/contextAccounting';
import type { LiveContextTelemetry } from '../types';


type LiveContextBuckets = NonNullable<LiveContextTelemetry['buckets']>;



const LIMIT_TRIGGER_RATIO = 0.95;
export interface ContextStats {
  
  totalUsedTokens: number;
  
  activeTokens: number;
  
  effectiveLimit: number | null;
  
  limitSource: ContextLimitSource | null;
}


export type ContextLimitSource = ModelCapabilitySource | 'manual';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}


export function reasoningFootprint(
  conversation: Pick<Conversation, 'turns' | 'compaction'>,
): { turns: number; tokens: number } {
  const covered = new Set(conversation.compaction?.coveredTurnIds ?? []);
  let turns = 0;
  let tokens = 0;
  for (const turn of conversation.turns) {
    if (covered.has(turn.id) || turn.kind === 'compaction' || turn.kind === 'restore') continue;
    const reasoningSegments = (turn.segments ?? []).filter(
      (segment) => segment.type === 'reasoning' && segment.text.trim(),
    );
    if (reasoningSegments.length > 0) {
      turns += 1;
      for (const segment of reasoningSegments) {
        if (segment.type !== 'reasoning') continue;
        tokens += estimateTokens(segment.text);
      }
      continue;
    }
    const legacy = turn.reasoning?.trim() ?? '';
    if (!legacy) continue;
    turns += 1;
    tokens += estimateTokens(legacy);
  }
  return { turns, tokens };
}


export function stripReasoning(turns: Turn[]): { turns: Turn[]; trimmed: number } {
  let trimmed = 0;
  const next = turns.map((turn) => {
    const segments = turn.segments ?? [];
    const kept = segments.filter((segment) => segment.type !== 'reasoning');
    const hadReasoning = Boolean(turn.reasoning?.trim()) || kept.length !== segments.length;
    if (!hadReasoning) return turn;
    trimmed += 1;
    return {
      ...turn,
      reasoning: '',
      ...(turn.segments ? { segments: kept } : {}),
    };
  });
  return { turns: trimmed === 0 ? turns : next, trimmed };
}


export function getCompactionCheckpoints(
  compaction: ConversationCompaction | undefined,
): CompactionCheckpoint[] {
  if (!compaction) return [];
  if (Array.isArray(compaction.checkpoints) && compaction.checkpoints.length > 0) {
    return compaction.checkpoints;
  }
  if (!compaction.summary) return [];
  return [
    {
      id: 'checkpoint-1',
      index: 1,
      summary: compaction.summary,
      coveredTurnIds: compaction.coveredTurnIds ?? [],
      trigger: compaction.trigger,
      createdAt: compaction.createdAt,
    },
  ];
}

export function allCoveredTurnIds(compaction: ConversationCompaction | undefined): string[] {
  if (!compaction) return [];
  const checkpoints = getCompactionCheckpoints(compaction);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cp of checkpoints) {
    for (const id of cp.coveredTurnIds) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  for (const id of compaction.coveredTurnIds ?? []) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function formatCumulativeSummary(checkpoints: readonly CompactionCheckpoint[]): string {
  if (checkpoints.length === 0) return '';
  if (checkpoints.length === 1) return checkpoints[0].summary;
  return checkpoints
    .map((cp) => `[Checkpoint ${cp.index}.0]\n${cp.summary}`)
    .join('\n\n---\n\n');
}


function turnTokens(turn: Turn): number {
  return estimateTokens(wireTurnText(turn));
}


function zeroBuckets(): LiveContextBuckets {
  return {
    systemTokens: 0,
    toolsTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function normalizeBuckets(raw: LiveContextBuckets): LiveContextBuckets {
  const sum =
    raw.systemTokens +
    raw.toolsTokens +
    raw.inputTokens +
    raw.outputTokens +
    raw.reasoningTokens;
  return {
    systemTokens: raw.systemTokens,
    toolsTokens: raw.toolsTokens,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    reasoningTokens: raw.reasoningTokens,
    totalTokens: raw.totalTokens > 0 ? raw.totalTokens : sum,
  };
}

function sumTotalUsedTokens(conversation: Conversation): number {
  let totalUsedTokens = 0;
  for (const turn of conversation.turns) {
    const usage = turn.usage;
    if (!usage) continue;
    totalUsedTokens += usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }
  return totalUsedTokens;
}

function countApiRoundsForTurn(turn: Turn): number {
  let stepCount = 0;
  let prevWasTool = false;
  let prevStartedAt: number | undefined;
  let endedWithTool = false;
  for (const seg of turn.segments ?? []) {
    if (seg.type === 'tool') {
      const sameParallelEmit =
        prevWasTool &&
        typeof seg.startedAt === 'number' &&
        typeof prevStartedAt === 'number' &&
        seg.startedAt === prevStartedAt;
      if (!sameParallelEmit) stepCount += 1;
      prevWasTool = true;
      prevStartedAt = seg.startedAt;
      endedWithTool = true;
    } else {
      prevWasTool = false;
      prevStartedAt = undefined;
      endedWithTool = false;
    }
  }
  return stepCount === 0 ? 1 : endedWithTool ? stepCount : stepCount + 1;
}

function collectSystemAndToolWeights(
  conversation: Conversation,
  maxTurnIndex: number,
  covered: Set<string>,
): { systemWeight: number; toolsDefsWeight: number } {
  let systemWeight = (conversation.settings.systemInstruction ?? '').length;
  const seenInjectionIds = new Set<string>();
  const addInjections = (list: Turn['injections'] | undefined) => {
    for (const inj of list ?? []) {
      if (inj.id && seenInjectionIds.has(inj.id)) continue;
      if (inj.id) seenInjectionIds.add(inj.id);
      systemWeight += FRAME_CHAR_WEIGHT + (inj.title?.length ?? 0) + (inj.content?.length ?? 0);
    }
  };
  addInjections(conversation.harnessContext?.injections);
  const limit = Math.min(maxTurnIndex, conversation.turns.length - 1);
  for (let i = 0; i <= limit; i += 1) {
    const turn = conversation.turns[i];
    if (covered.has(turn.id)) continue;
    addInjections(turn.injections);
  }
  const toolsDefsWeight = Math.max(0, conversation.harnessContext?.toolsDefsChars ?? 0);
  return { systemWeight, toolsDefsWeight };
}

function asPriceMessage(msg: ChatMessage, includeReasoning: boolean): PriceMessage {
  return {
    role: msg.role as PriceMessage['role'],
    content:
      typeof msg.content === 'string' || msg.content === null
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as unknown as PriceMessage['content'])
          : null,
    ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    ...(includeReasoning && msg.reasoning_content
      ? { reasoning_content: msg.reasoning_content }
      : {}),
  };
}

function deriveBucketsFromTotalBudget(
  conversation: Conversation,
  budget: number,
): LiveContextBuckets {
  const covered = new Set(allCoveredTurnIds(conversation.compaction));
  const lastIdx = conversation.turns.length - 1;
  const { systemWeight, toolsDefsWeight } = collectSystemAndToolWeights(conversation, lastIdx, covered);
  const weights = {
    system: systemWeight,
    tools: toolsDefsWeight,
    input: 0,
    output: 0,
    reasoning: 0,
  };
  const plan = contextPlan(conversation);
  for (let i = 0; i < plan.messages.length; i += 1) {
    const msg = plan.messages[i];
    const w = measureMessageWeights(asPriceMessage(msg, true), { includeReasoning: true });
    weights.tools += w.tools;
    weights.input += w.input;
    weights.output += w.output;
    weights.reasoning += w.reasoning;
  }
  if (weights.reasoning === 0) {
    for (let i = lastIdx; i >= 0; i -= 1) {
      const turn = conversation.turns[i];
      if (covered.has(turn.id)) continue;
      if (turn.role === 'assistant' && turn.reasoning?.trim()) {
        weights.reasoning += turn.reasoning.length;
        break;
      }
    }
  }
  const alloc = apportionBuckets(budget, weights, 'input');
  return normalizeBuckets({
    systemTokens: alloc.system,
    toolsTokens: alloc.tools,
    inputTokens: alloc.input,
    outputTokens: alloc.output,
    reasoningTokens: alloc.reasoning,
    totalTokens: Math.max(0, Math.round(budget)),
  });
}

function findLatestUncoveredUsageTurn(
  conversation: Conversation,
  covered: Set<string>,
): { turn: Turn; index: number; usage: NonNullable<Turn['usage']> } | null {
  for (let i = conversation.turns.length - 1; i >= 0; i -= 1) {
    const turn = conversation.turns[i];
    if (covered.has(turn.id)) continue;
    if (turn.role !== 'assistant') continue;
    if (turn.kind === 'compaction' || turn.kind === 'restore' || turn.kind === 'probation') continue;
    const u = turn.usage;
    if (!u) continue;
    const hasNumbers =
      (u.lastBuckets?.totalTokens ?? 0) > 0 ||
      (u.lastPromptTokens ?? 0) > 0 ||
      (u.lastCompletionTokens ?? 0) > 0 ||
      (u.promptTokens ?? 0) > 0 ||
      (u.completionTokens ?? 0) > 0 ||
      (u.totalTokens ?? 0) > 0;
    if (hasNumbers) return { turn, index: i, usage: u };
  }
  return null;
}

function deriveProviderFallbackBreakdown(conversation: Conversation): {
  buckets: LiveContextBuckets;
  activeTokens: number;
  live: false;
} {
  const covered = new Set(allCoveredTurnIds(conversation.compaction));
  const found = findLatestUncoveredUsageTurn(conversation, covered);
  if (!found) return { buckets: zeroBuckets(), activeTokens: 0, live: false };

  const { turn: lastTurn, index: lastIdx, usage: u } = found;
  const hasUncoveredReasoning = conversation.turns.some(
    (entry, idx) =>
      idx <= lastIdx &&
      !covered.has(entry.id) &&
      entry.role === 'assistant' &&
      Boolean(entry.reasoning?.trim()),
  );

  if (u.lastBuckets && u.lastBuckets.totalTokens > 0) {
    const base = normalizeBuckets(u.lastBuckets);
    const buckets =
      !hasUncoveredReasoning && base.reasoningTokens > 0
        ? {
            ...base,
            reasoningTokens: 0,
            totalTokens: Math.max(0, base.totalTokens - base.reasoningTokens),
          }
        : base;
    return { buckets, activeTokens: buckets.totalTokens, live: false };
  }

  let roundPrompt = 0;
  let roundCompletion = 0;
  if (typeof u.lastPromptTokens === 'number' || typeof u.lastCompletionTokens === 'number') {
    roundPrompt = Math.max(0, Math.round(u.lastPromptTokens ?? 0));
    roundCompletion = Math.max(0, Math.round(u.lastCompletionTokens ?? 0));
  } else {
    const rounds = countApiRoundsForTurn(lastTurn);
    const rawPrompt = Math.max(0, u.promptTokens ?? 0);
    const rawCompletion = Math.max(0, u.completionTokens ?? 0);
    const rawTotal = Math.max(0, u.totalTokens ?? rawPrompt + rawCompletion);
    if (rawPrompt === 0 && rawCompletion === 0 && rawTotal > 0) {
      roundPrompt = rounds > 1 ? Math.round(rawTotal / rounds) : rawTotal;
      roundCompletion = 0;
    } else if (rounds === 1) {
      roundPrompt = rawPrompt > 0 ? rawPrompt : Math.max(0, rawTotal - rawCompletion);
      roundCompletion = rawCompletion;
    } else {
      roundPrompt = Math.round(rawPrompt / rounds);
      roundCompletion = Math.round(rawCompletion / rounds);
    }
  }

  const turnIndexById = new Map<string, number>();
  conversation.turns.forEach((t, idx) => turnIndexById.set(t.id, idx));

  const { systemWeight, toolsDefsWeight } = collectSystemAndToolWeights(conversation, lastIdx, covered);
  const promptWeights = {
    system: systemWeight,
    tools: toolsDefsWeight,
    input: 0,
    output: 0,
    reasoning: 0,
  };
  const completionWeights = {
    tools: 0,
    output: 0,
    reasoning: 0,
  };

  const plan = contextPlan(conversation);
  let lastAssistantMsgIdx = -1;
  for (let i = plan.messages.length - 1; i >= 0; i -= 1) {
    if (plan.tags[i] === lastTurn.id && plan.messages[i].role === 'assistant') {
      lastAssistantMsgIdx = i;
      break;
    }
  }

  for (let i = 0; i < plan.messages.length; i += 1) {
    const tag = plan.tags[i];
    if (tag !== null) {
      const tIdx = turnIndexById.get(tag);
      if (tIdx === undefined || tIdx > lastIdx) continue;
    }
    const msg = plan.messages[i];
    const isFinalComp = i === lastAssistantMsgIdx;
    const w = measureMessageWeights(asPriceMessage(msg, isFinalComp), {
      includeReasoning: isFinalComp,
    });
    if (isFinalComp) {
      completionWeights.tools += w.tools;
      completionWeights.output += w.output;
      completionWeights.reasoning += w.reasoning;
    } else {
      promptWeights.tools += w.tools;
      promptWeights.input += w.input;
      promptWeights.output += w.output;
    }
  }

  if (lastTurn.reasoning?.trim() && completionWeights.reasoning === 0) {
    completionWeights.reasoning = lastTurn.reasoning.length;
  }

  const promptAlloc = apportionBuckets(roundPrompt, promptWeights, 'input');
  let compAlloc: { tools: number; output: number; reasoning: number };
  if (
    typeof u.lastReasoningTokens === 'number' &&
    u.lastReasoningTokens > 0 &&
    lastTurn.reasoning?.trim()
  ) {
    const roundReasoning = Math.min(roundCompletion, Math.max(0, Math.round(u.lastReasoningTokens)));
    const remainingCompletion = Math.max(0, roundCompletion - roundReasoning);
    const remAlloc = apportionBuckets(
      remainingCompletion,
      { tools: completionWeights.tools, output: completionWeights.output },
      'output',
    );
    compAlloc = {
      tools: remAlloc.tools,
      output: remAlloc.output,
      reasoning: roundReasoning,
    };
  } else {
    compAlloc = apportionBuckets(roundCompletion, completionWeights, 'output');
  }

  const buckets = normalizeBuckets({
    systemTokens: promptAlloc.system,
    toolsTokens: promptAlloc.tools + compAlloc.tools,
    inputTokens: promptAlloc.input,
    outputTokens: promptAlloc.output + compAlloc.output,
    reasoningTokens: promptAlloc.reasoning + compAlloc.reasoning,
    totalTokens: roundPrompt + roundCompletion,
  });
  return { buckets, activeTokens: buckets.totalTokens, live: false };
}

function resolveBreakdownBuckets(
  conversation: Conversation,
  live?: { liveContextTokens?: number | null; buckets?: LiveContextBuckets | null } | null,
): { buckets: LiveContextBuckets; activeTokens: number; live: boolean } {
  const source = live ?? conversation.liveContext;
  if (typeof source?.liveContextTokens === 'number' && source.liveContextTokens > 0) {
    if (source.buckets) {
      const normalized = normalizeBuckets(source.buckets);
      if (normalized.totalTokens > 0) {
        return { buckets: normalized, activeTokens: normalized.totalTokens, live: true };
      }
    }
    const derived = deriveBucketsFromTotalBudget(conversation, source.liveContextTokens);
    return { buckets: derived, activeTokens: derived.totalTokens, live: true };
  }
  return deriveProviderFallbackBreakdown(conversation);
}

export function contextStats(
  conversation: Conversation,
  capability: ResolvedModelCapability | undefined,
  live?: { liveContextTokens?: number | null; buckets?: LiveContextBuckets | null } | null,
): ContextStats {
  const { limit, source } = effectiveContextLimit(conversation.settings, capability);
  const { activeTokens } = resolveBreakdownBuckets(conversation, live);
  return {
    totalUsedTokens: sumTotalUsedTokens(conversation),
    activeTokens,
    effectiveLimit: limit,
    limitSource: source,
  };
}


export function effectiveContextLimit(
  settings: ChatSettings,
  capability: ResolvedModelCapability | undefined,
): { limit: number | null; source: ContextLimitSource | null } {
  const model = capability?.context ?? null;
  const modelSource = capability?.sources.context ?? 'default';
  const user = settings.maxContextTokens ?? null;
  if (model && user && user < model) return { limit: user, source: 'manual' };
  if (model) return { limit: model, source: modelSource };
  if (user) return { limit: user, source: 'manual' };
  return { limit: null, source: null };
}

export interface ContextBreakdown extends ContextStats {
  
  systemTokens: number;
  
  toolsTokens: number;
  
  inputTokens: number;
  
  outputTokens: number;
  
  reasoningTokens: number;
  
  live: boolean;
}


export function contextBreakdown(
  conversation: Conversation,
  capability: ResolvedModelCapability | undefined,
  live?: { liveContextTokens?: number | null; buckets?: LiveContextBuckets | null } | null,
): ContextBreakdown {
  const { limit, source } = effectiveContextLimit(conversation.settings, capability);
  const resolved = resolveBreakdownBuckets(conversation, live);
  return {
    totalUsedTokens: sumTotalUsedTokens(conversation),
    activeTokens: resolved.activeTokens,
    effectiveLimit: limit,
    limitSource: source,
    systemTokens: resolved.buckets.systemTokens,
    toolsTokens: resolved.buckets.toolsTokens,
    inputTokens: resolved.buckets.inputTokens,
    outputTokens: resolved.buckets.outputTokens,
    reasoningTokens: resolved.buckets.reasoningTokens,
    live: resolved.live,
  };
}



export const TOOL_ARGS_CHARS = 160;

function toolSegmentState(segment: { summary?: string; ok?: boolean }): string {
  return segment.summary === undefined ? 'running' : segment.ok === false ? 'failed' : 'done';
}

function shortArgs(args: string | undefined): string {
  const trimmed = args?.trim() ?? '';
  if (!trimmed) return '';
  const oneLine = trimmed.replace(/\s+/g, ' ');
  return oneLine.length > TOOL_ARGS_CHARS ? `${oneLine.slice(0, TOOL_ARGS_CHARS)}…` : oneLine;
}


function repairPartialArgs(raw: string): string {
  let work = raw.trim();
  if (!work || work === '{}') return '{}';
  try {
    JSON.parse(work);
    return work;
  } catch {
  }
  if (!work.startsWith('{')) return '{}';
  let inString = false;
  let escaped = false;
  let lastCompleteValueEnd = -1;
  for (let i = 1; i < work.length; i += 1) {
    const char = work[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString && (char === ',' || char === '}' || char === ']')) lastCompleteValueEnd = i;
  }
  if (lastCompleteValueEnd > 0) work = work.slice(0, lastCompleteValueEnd + 1);
  work = work.replace(/,\s*$/, '');
  let depth = 0;
  const stack: string[] = [];
  let inner = false;
  for (let i = 1; i < work.length; i += 1) {
    const char = work[i];
    if (char === '"') inner = !inner;
    if (inner) continue;
    if (char === '{' || char === '[') { depth += 1; stack.push(char === '{' ? '}' : ']'); }
    else if (char === '}' || char === ']') { depth -= 1; stack.pop(); }
  }
  try {
    const parsed = JSON.parse(work + stack.reverse().join('')) as unknown;
    return parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : '{}';
  } catch {
    return '{}';
  }
}


function wireToolSegment(segment: { toolName: string; args?: string; summary?: string; ok?: boolean }): string {
  const args = shortArgs(segment.args);
  const header = `[tool ${segment.toolName}${args ? ` ${args}` : ''} — ${toolSegmentState(segment)}]`;
  const summary = segment.summary?.trim() ?? '';
  return summary ? `${header}\n${summary}` : header;
}


export function wireTurnText(turn: Pick<Turn, 'content' | 'reasoning' | 'segments'>): string {
  if (turn.segments?.length) {
    const parts: string[] = [];
    for (const segment of turn.segments) {
      if (segment.type === 'text' && segment.text.trim()) {
        parts.push(segment.text);
      } else if (segment.type === 'reasoning') {
        continue;
      } else if (segment.type === 'steer') {
        if (segment.text.trim()) parts.push(`User (steered mid-run): ${segment.text.trim()}`);
      } else if (segment.type === 'tool') {
        parts.push(wireToolSegment(segment));
      }
    }
    if (parts.length) return parts.join('\n');
  }
  return turn.content;
}


export function appendWireTurnStop(turn: Pick<Turn, 'finishReason'>): string {
  return turn.finishReason === 'user_stop'
    ? '\n[The generation above was stopped by the user. That task is ENDED — do not resume or continue it. Respond to the newest user message only.]'
    : '';
}


export function wireMessages(
  turn: Pick<Turn, 'content' | 'reasoning' | 'segments' | 'steers' | 'finishReason'>,
): ChatMessage[] {
  const segments = turn.segments;
  if (!segments || segments.length === 0) {
    const reasoning = (turn.reasoning ?? '').trim();
    return [
      {
        role: 'assistant',
        content: wireTurnText(turn),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
    ];
  }

  const messages: ChatMessage[] = [];
  let pendingText = '';
  
  let pendingReasoning = '';
  const reasoningField = (): { reasoning_content?: string } => {
    const reasoning = pendingReasoning.trim();
    pendingReasoning = '';
    return reasoning ? { reasoning_content: reasoning } : {};
  };
  let pendingCalls: Array<{
    id: string;
    wireName: string;
    args: string;
    result: string | undefined;
    images?: TurnToolCall['toolImages'];
  }> = [];
  let emittedNative = false;
  let sawSteer = false;

  const flushRound = (): void => {
    if (pendingCalls.length === 0) {
      if (pendingText.trim()) {
        messages.push({ role: 'assistant', content: pendingText, ...reasoningField() });
      } else {
        // BUG #4 FIX (user's specification): a round may carry reasoning but
        const reasoningOnly = reasoningField();
        if (reasoningOnly.reasoning_content) {
          messages.push({ role: 'assistant', content: null, ...reasoningOnly });
        }
      }
      pendingText = '';
      return;
    }
    const native = pendingCalls.every((call) => call.id && call.result !== undefined);
    if (!native) {
      const parts: string[] = [];
      if (pendingText.trim()) parts.push(pendingText.trim());
      for (const call of pendingCalls) {
        parts.push(
          wireToolSegment({ toolName: call.wireName, args: repairPartialArgs(call.args), summary: call.result }),
        );
      }
      if (parts.length) {
        messages.push({ role: 'assistant', content: parts.join('\n'), ...reasoningField() });
      } else {
        const reasoningOnly = reasoningField();
        if (reasoningOnly.reasoning_content) {
          messages.push({ role: 'assistant', content: null, ...reasoningOnly });
        }
      }
      pendingText = '';
      pendingCalls = [];
      return;
    }
    emittedNative = true;
    messages.push({
      role: 'assistant',
      content: pendingText.trim() ? pendingText : null,
      ...reasoningField(),
      tool_calls: pendingCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.wireName, arguments: repairPartialArgs(call.args || '{}') },
      })),
    });
    for (const call of pendingCalls) {
      const images = call.images ?? [];
      const text = toolResultContent(call.result ?? '');
      messages.push({
        role: 'tool',
        content: images.length
          ? [
              { type: 'text', text },
              ...images.map((image) => ({
                type: 'image_url' as const,
                image_url: {
                  url: image.dataRef
                    ? attachmentRefWireUrl(image.dataRef.hash, image.dataRef.mime)
                    : (image.dataUrl ?? ''),
                },
              })),
            ]
          : text,
        tool_call_id: call.id,
      });
    }
    pendingText = '';
    pendingCalls = [];
  };

  for (const segment of segments) {
    if (segment.type === 'text') {
      if (pendingCalls.length > 0) flushRound();
      pendingText += segment.text;
    } else if (segment.type === 'reasoning') {
      if (pendingCalls.length > 0) flushRound();
      pendingReasoning += segment.text;
    } else if (segment.type === 'steer') {
      flushRound();
      const note = segment.text.trim();
      if (note) {
        messages.push({ role: 'user', content: steerWireBody(note) });
        sawSteer = true;
      }
    } else if (segment.type === 'tool') {
      const wireName = wireNameForSegment(segment);
      if (!wireName) {
        pendingText += `${wireToolSegment(segment)}\n`;
        continue;
      }
      pendingCalls.push({
        id: segment.toolCallId ?? '',
        wireName,
        args: segment.args?.trim() || '{}',
        result: segment.summary === undefined ? undefined : segment.summary,
        images: segment.toolImages,
      });
    }
  }
  flushRound();

  if (!emittedNative && !sawSteer) {
    // BUG #4 FIX: the non-native fallback must ALSO price reasoning — legacy
    const flat = wireTurnText(turn);
    const segmentsReasoning = (turn.segments ?? [])
      .filter((segment) => segment.type === 'reasoning')
      .map((segment) => segment.text)
      .join('');
    const reasoning = (segmentsReasoning || (turn.reasoning ?? '')).trim();
    return [
      {
        role: 'assistant',
        content: flat + appendWireTurnStop(turn),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
    ];
  }
  if (turn.finishReason === 'user_stop') {
    messages.push({ role: 'assistant', content: appendWireTurnStop(turn).trim() });
  }
  return messages;
}


function steerWireBody(notes: string): string {
  return [
    'STEERED MID-RUN — the user sent this while you were working. Treat',
    'it as their latest, highest-priority instruction; it was already',
    'honored in the reply above. Keep it in mind going forward.',
    '',
    notes,
  ].join('\n');
}


function toolResultContent(summary: string): string {
  return summary.trim() ? summary : '(no output)';
}


function wireNameForSegment(segment: {
  serverName: string;
  toolName: string;
}): string | null {
  if (!segment.toolName) return null;
  if (segment.serverName === 'Workspace') return `agent__${segment.toolName}`;
  if (segment.serverName && segment.serverName !== '?') {
    return `mcp__${segment.serverName}__${segment.toolName}`;
  }
  return null;
}



export function wireUserContent(turn: Pick<Turn, 'content' | 'attachments'>): ChatMessage['content'] {
  if (!turn.attachments || turn.attachments.length === 0) return turn.content;
  const parts: MessageContentPart[] = [];
  if (turn.content.trim()) parts.push({ type: 'text', text: turn.content });
  for (const attachment of turn.attachments) {
    // send the PATH ONLY — no preview, no excerpt. The model reads the file
    if (attachment.textContent !== undefined) {
      if (attachment.path) {
        parts.push({
          type: 'text',
          text: `[Attached file: ${attachment.name}]\nPath: ${attachment.path}\n\nThe content is NOT included — use the read tool on the path above when you need it.`,
        });
      } else {
        parts.push({
          type: 'text',
          text: `[Attached file: ${attachment.name}]\n${attachment.textContent}`,
        });
      }
    } else if (attachment.mime.startsWith('image/')) {
      const url = attachment.dataRef
        ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
        : attachment.dataUrl;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    } else if (attachment.mime.startsWith('video/')) {
      
      const url = attachment.dataRef
        ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
        : attachment.dataUrl;
      if (url) parts.push({ type: 'video_url', video_url: { url } });
    } else {
      const data = attachment.dataRef
        ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
        : attachment.dataUrl;
      if (data) {
        parts.push({
          type: 'file',
          file: { filename: attachment.name, file_data: data },
        });
      }
    }
  }
  return parts;
}


export function steerPartsToContent(
  entry: Pick<import('../types').TurnSteer, 'text' | 'parts'>,
): ChatMessage['content'] {
  if (entry.parts && entry.parts.length > 0) {
    const parts: MessageContentPart[] = [];
    for (const part of entry.parts) {
      if (part.type === 'text') {
        if (part.text) parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
      } else if (part.type === 'video_url') {
        parts.push({ type: 'video_url', video_url: { url: part.video_url.url } });
      } else {
        parts.push({
          type: 'file',
          file: { filename: part.file.filename, file_data: part.file.file_data },
        });
      }
    }
    if (parts.length > 0) return parts;
  }
  return entry.text;
}

export interface ContextPlan {
  
  messages: ChatMessage[];
  
  tags: Array<string | null>;
  
  coveredTurnIds: string[];
  
  hasSummary: boolean;
}


const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

export function contextPlan(conversation: Conversation): ContextPlan {
  const compaction = conversation.compaction;
  const checkpoints = getCompactionCheckpoints(compaction);
  const coveredList = allCoveredTurnIds(compaction);
  const covered = new Set(coveredList);
  const messages: ChatMessage[] = [];
  const tags: Array<string | null> = [];

  if (checkpoints.length > 0) {
    const combinedSummary = formatCumulativeSummary(checkpoints);
    messages.push({
      role: 'user',
      content: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${combinedSummary}\n</compacted-summary>`,
    });
    tags.push(null);
  }

  const turns = conversation.turns;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (covered.has(turn.id)) continue;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    if (turn.kind === 'compaction' || turn.kind === 'restore') continue;
    const hasWork = Boolean(turn.content.trim() || turn.reasoning?.trim() || turn.segments?.length);
    if (!hasWork) continue;
    if (turn.kind === 'probation') continue;

    if (turn.kind === 'harness-event') {
      const addon = turn.eventAddon ?? 'addon';
      messages.push({
        role: 'user',
        content: `[Harness event · ${addon}] ${turn.content.replace(/^\[[^\]]+\] \[[^\]]+\] /, '')}\n(The line above is an automated addon event, NOT a user message.)`,
      });
      tags.push(turn.id);
      continue;
    }

    if (turn.role === 'user') {
      const next = turns[index + 1];
      const steerEntries = (next && next.role === 'user' ? (next.steers ?? []) : []).filter(
        (entry) => entry.parts?.length || entry.text.trim(),
      );
      if (steerEntries.length > 0) {
        for (const entry of steerEntries) {
          messages.push({ role: 'user', content: steerPartsToContent(entry) });
          tags.push(turn.id);
        }
        index += 1;
        continue;
      }
      messages.push({ role: 'user', content: wireUserContent(turn) });
      tags.push(turn.id);
      continue;
    }
    for (const message of wireMessages(turn)) {
      messages.push(message);
      tags.push(turn.id);
    }
    const assistantSteers = (turn.steers ?? []).filter(
      (entry) => entry.parts?.length || entry.text.trim(),
    );
    if (assistantSteers.length > 0) {
      for (const entry of assistantSteers) {
        messages.push({ role: 'user', content: steerPartsToContent(entry) });
        tags.push(turn.id);
      }
    }
  }

  return {
    messages,
    tags,
    coveredTurnIds: coveredList,
    hasSummary: checkpoints.length > 0,
  };
}


export type CompactTrigger = 'manual' | 'threshold' | 'context-limit' | null;


export function measuredActiveTokens(
  conversation: Conversation,
  capability: ResolvedModelCapability | undefined,
  live?: { liveContextTokens?: number | null; buckets?: LiveContextBuckets | null } | null,
): number {
  return contextBreakdown(conversation, capability, live).activeTokens;
}


export function triggerForMeasuredTokens(
  settings: ChatSettings,
  capability: ResolvedModelCapability | undefined,
  measuredTokens: number,
): Exclude<CompactTrigger, null | 'manual'> | null {
  if (!settings.autoCompact) return null;
  if (!Number.isFinite(measuredTokens) || measuredTokens <= 0) return null;

  const threshold = settings.compactThresholdTokens ?? null;
  if (threshold && measuredTokens >= threshold) return 'threshold';

  const { limit } = effectiveContextLimit(settings, capability);
  const ratio = Math.min(0.98, Math.max(0.5, settings.compactThresholdRatio ?? LIMIT_TRIGGER_RATIO));
  if (limit && measuredTokens >= limit * ratio) return 'context-limit';

  return null;
}


export const SERVER_HANDOFF_RATIO = 0.85;


export function nearingServerHandoff(
  capability: ResolvedModelCapability | undefined,
  tokens: number,
): boolean {
  const limit = capability?.context ?? null;
  if (!limit || !Number.isFinite(tokens) || tokens <= 0) return false;
  return tokens >= limit * SERVER_HANDOFF_RATIO;
}

export function shouldAutoCompact(
  conversation: Conversation,
  capability: ResolvedModelCapability | undefined,
  _incomingTokens = 0,
  live?: { liveContextTokens?: number | null; buckets?: LiveContextBuckets | null } | null,
): Exclude<CompactTrigger, null | 'manual'> | null {
  const settings = conversation.settings;
  if (!settings.autoCompact) return null;

  const measured = measuredActiveTokens(conversation, capability, live);
  return triggerForMeasuredTokens(settings, capability, measured);
}


export function summarizationReplay(
  plan: ContextPlan,
  coveredTurnIds: string[],
): ChatMessage[] {
  const covered = new Set(coveredTurnIds);
  const out: ChatMessage[] = [];
  for (let index = 0; index < plan.tags.length; index += 1) {
    const tag = plan.tags[index];
    // Exclude tag === null (<compacted-summary> prior checkpoints) strictly so
    // Summarizer only sees pure turns from the current checkpoint span.
    if (tag !== null && covered.has(tag)) {
      out.push(plan.messages[index]);
    }
  }
  if (out.length > 0 && out[0].role === 'assistant') {
    out.unshift({
      role: 'user',
      content: '[Checkpoint segment to summarize — condense only what follows.]',
    });
  }
  return out;
}



function compactionDirective(framing: 'replay' | 'transcript'): string {
  const source = framing === 'replay' ? 'the conversation ABOVE' : 'the conversation';
  const record = framing === 'replay' ? 'The conversation above is' : 'The transcript is';
  return [
    `You are now acting as a compaction engine for this AI coding assistant. Condense ${source} into a structured checkpoint that lets another model resume the work with no loss of essential context.`,
    '',
    'STEP 1 — <analysis> scratchpad. Before writing anything else, reconstruct the conversation chronologically inside ONE <analysis> block. It is stripped before the checkpoint is stored, so be exhaustive rather than tidy — but keep it under ~120 lines: it is a working note, not a transcript.',
    "1. Walk the messages in order. For each stretch name: the user's explicit request and intent, your approach, the key decisions and WHY, exact file paths, full code snippets, function signatures, and every file edit.",
    '2. List each error you hit and how it was resolved.',
    '3. Quote user feedback VERBATIM, especially corrections — every place the user said you did it wrong or wanted it done differently. Those are the most valuable lines in the whole checkpoint.',
    '4. Re-check technical accuracy and completeness against the material before compressing anything.',
    '',
    'STEP 2 — the checkpoint. Immediately after </analysis>, output the Markdown structure below.',
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    '## Primary Request and Intent',
    "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
    '',
    '## Key Technical Concepts',
    '- [technologies, frameworks, patterns, and conventions in play]',
    '',
    '## Files and Code',
    '- [exact path: why it matters, key changes or snippets]',
    '',
    '## Errors and Fixes',
    '- [error: how it was resolved, plus any related user feedback]',
    '',
    '## Pending Jobs',
    '- [explicitly requested work not yet completed]',
    '',
    '## Goals & Todos',
    '- [the live goal checklist if any: each goal, its status, and every todo with its checked state, verbatim]',
    '',
    '## Current Work',
    '- [precisely what was in progress at this checkpoint]',
    '',
    '## Next Step',
    '- [the single next action, directly in line with the most recent request, or "(none)"]',
    '',
    '## Critical Context',
    '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
    '',
    'Rules:',
    '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Never reference the <analysis> block inside the checkpoint — it is discarded, so a pointer to it would dangle.',
    '- Output only the checkpoint text.',
    `${record} a RECORD of past work — it is finished. Do NOT continue that work, do not perform new actions, and do not narrate plans as if acting.`,
    '- Do NOT emit tool-call lines, tool output lines, or imitate the transcript log format (e.g. lines like "[tool … — done]"). Prose bullets only.',
    '- Summarize ONLY the conversation turns provided for this checkpoint segment cleanly from first principles; do NOT assume, invent, or re-summarize prior checkpoints.',
    ...(framing === 'replay'
      ? [
          '- Do NOT call any tool or take any other action — the tool schemas ride only so this request matches the cached prefix. Summarize; do not work.',
        ]
      : []),
  ].join('\n');
}


export const COMPACT_INSTRUCTION = compactionDirective('replay');

export const COMPACT_SYSTEM_INSTRUCTION = compactionDirective('transcript');


export function stripCompactionAnalysis(raw: string): string {
  let text = raw.trim();
  if (!text) return text;
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  const openAt = text.search(/<analysis>/i);
  if (openAt !== -1) text = text.slice(0, openAt).trim();
  const closeTag = '</analysis>';
  const closeAt = text.search(/<\/analysis>/i);
  if (closeAt !== -1) text = text.slice(closeAt + closeTag.length).trim();
  return text;
}


const CHECKPOINT_REQUIRED_SECTIONS = [
  '## Primary Request',
  '## Current Work',
  '## Next Step',
] as const;

export function isCheckpointShape(summary: string): boolean {
  const text = summary.trim();
  if (!text) return false;
  if (CHECKPOINT_REQUIRED_SECTIONS.every((section) => text.includes(section))) return true;
  const headingCount = (text.match(/^##+ /gm) ?? []).length;
  return headingCount >= 5 && /resume|checkpoint|context/i.test(text.slice(0, 400));
}

export interface CompactOutcome {
  summary: string;
  coveredTurnIds: string[];
  
  replacedTokens: number;
  summaryTokens?: number;
  sourceTokens?: number;
}


function serializeGoals(goals: import('../types').Goal[] | undefined): string {
  if (!goals?.length) return '(none)';
  return goals
    .map((goal) => {
      const todos = (goal.todos ?? [])
        .map((todo) => `${todo.done ? '[x]' : '[ ]'} ${todo.text}`)
        .join('; ');
      return `- ${goal.title} [${goal.status}]${goal.plan?.trim() ? ` — ${goal.plan.trim()}` : ''}${todos ? ` · todos: ${todos}` : ''}`;
    })
    .join('\n');
}


const MAX_TRANSCRIPT_CHARS = 600_000;


function elisionMarker(dropped: number): string {
  return `\n\n[… ${dropped} characters elided to fit the summarization request …]\n\n`;
}


function elideBody(body: string, allowance: number): string {
  if (body.length <= allowance) return body;
  const markerLength = elisionMarker(body.length).length;
  const keep = allowance - markerLength - 2;
  if (keep < 200) return elisionMarker(body.length).trim();
  const head = Math.floor(keep * 0.7);
  const tail = keep - head;
  return body.slice(0, head) + elisionMarker(body.length - keep) + body.slice(body.length - tail);
}


export function compactCandidate(conversation: Conversation): {
  turns: Turn[];
  transcript: string;
  replacedTokens: number;
  
  goalBlock: string;
} | null {
  const alreadyCovered = new Set(allCoveredTurnIds(conversation.compaction));
  let covered = conversation.turns.filter(
    (turn) =>
      !alreadyCovered.has(turn.id) &&
      (turn.role === 'user' || turn.role === 'assistant') &&
      turn.kind !== 'compaction' &&
      turn.kind !== 'probation' &&
      turn.kind !== 'restore' &&
      turn.kind !== 'harness-event',
  );
  if (covered.length === 0) return null;

  const render = (turn: Turn): string => {
    const body = wireTurnText(turn);
    return `${turn.role === 'user' ? 'User' : 'Assistant'}: ${body}`;
  };

  const goalBlock = conversation.goals?.length
    ? `CURRENT GOAL STATE (authoritative — restate it verbatim in the Goals & Todos section):\n${serializeGoals(conversation.goals)}\n\n---\n\n`
    : '';
  const preamble = goalBlock;

  const budget = Math.max(0, MAX_TRANSCRIPT_CHARS - preamble.length);
  const accepted: Turn[] = [];
  const bodies: string[] = [];
  let used = 0;
  for (let index = covered.length - 1; index >= 0; index -= 1) {
    const body = render(covered[index]);
    if (used + body.length <= budget) {
      accepted.unshift(covered[index]);
      bodies.unshift(body);
      used += body.length;
      continue;
    }
    const room = Math.max(0, budget - used);
    const share =
      accepted.length === 0 ? Math.floor(budget * 0.6) : Math.floor(room / (index + 1));
    const excerpt = elideBody(body, Math.min(body.length, Math.max(share, 0)));
    accepted.unshift(covered[index]);
    bodies.unshift(excerpt);
    used += excerpt.length;
  }
  if (accepted.length === 0) return null;
  covered = accepted;

  const transcript = preamble + bodies.join('\n\n');
  const replacedTokens = covered.reduce((sum, turn) => sum + turnTokens(turn), 0);

  return { turns: covered, transcript, replacedTokens, goalBlock };
}

export function applyCompaction(
  conversation: Conversation,
  outcome: CompactOutcome,
  trigger: 'manual' | 'threshold' | 'context-limit',
): Conversation {
  const prevCheckpoints = getCompactionCheckpoints(conversation.compaction);
  const prevCovered = new Set(allCoveredTurnIds(conversation.compaction));
  const checkpointCoveredIds = outcome.coveredTurnIds.filter((id) => !prevCovered.has(id));
  const now = Date.now();
  const nextIndex = prevCheckpoints.length + 1;
  const newCheckpoint: CompactionCheckpoint = {
    id: `checkpoint-${nextIndex}`,
    index: nextIndex,
    summary: outcome.summary,
    coveredTurnIds: checkpointCoveredIds,
    trigger,
    createdAt: now,
    ...(typeof outcome.summaryTokens === 'number' && outcome.summaryTokens > 0
      ? { summaryTokens: outcome.summaryTokens }
      : {}),
    ...(typeof outcome.sourceTokens === 'number' && outcome.sourceTokens > 0
      ? { sourceTokens: outcome.sourceTokens }
      : {}),
  };
  const checkpoints = [...prevCheckpoints, newCheckpoint];
  const allCovered = [...new Set([...prevCheckpoints.flatMap((c) => c.coveredTurnIds), ...checkpointCoveredIds])];
  return {
    ...conversation,
    compaction: {
      summary: formatCumulativeSummary(checkpoints),
      coveredTurnIds: allCovered,
      trigger,
      createdAt: now,
      checkpoints,
    },
  };
}

const compactionAborters = new Map<string, () => void>();

export function registerCompactionAbort(conversationId: string, abort: () => void): void {
  compactionAborters.set(conversationId, abort);
}

export function clearCompactionAbort(conversationId: string): void {
  compactionAborters.delete(conversationId);
}


export function abortCompaction(conversationId: string): boolean {
  const abort = compactionAborters.get(conversationId);
  if (!abort) return false;
  compactionAborters.delete(conversationId);
  abort();
  return true;
}
