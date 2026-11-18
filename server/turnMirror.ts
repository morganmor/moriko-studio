
import type { StreamEvent } from './contracts.js';
import { applyTurnPatches, getStoredConversation, setStoredLiveContext } from './conversationStore.js';
import { recordUsage } from './usageLedger.js';


export const MIRROR_FLUSH_MS = 1_500;

export interface MirrorLiveContext {
  promptTokens: number;
  completionTokens: number;
  addedTokens: number;
  liveContextTokens: number;
  contextLimit: number | null;
  ratio: number | null;
  buckets?: {
    systemTokens: number;
    toolsTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  at: number;
}


export interface MirrorTurn {
  id: string;
  role: 'assistant';
  content: string;
  reasoning: string;
  createdAt: number;
  model: string;
  providerId: string;
  segments: MirrorSegment[];
  injections: Array<{ id: string; title: string; content: string }>;
  steers: Array<{ id: string; text: string }>;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    lastPromptTokens?: number;
    lastCompletionTokens?: number;
    lastReasoningTokens?: number;
    lastBuckets?: {
      systemTokens: number;
      toolsTokens: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
    };
  } | null;
  error: string | null;
  finishReason: string | null;
  
  terminal: boolean;
  liveContext?: MirrorLiveContext;
}

export type MirrorSegment =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      serverName: string;
      toolName: string;
      args?: string;
      toolCallId?: string;
      summary?: string;
      ok?: boolean;
      diff?: string;
      toolImages?: Array<{ mime: string; dataUrl?: string; dataRef?: { hash: string; mime: string; byteSize: number } }>;
      
      visual?: {
        id: string;
        html?: string;
        htmlRef?: { hash: string; byteSize: number };
        title: string;
        height: number;
        replaces?: true;
        variants?: Array<{ id: string; html?: string; htmlRef?: { hash: string; byteSize: number }; title: string; height: number }>;
      };
    }
  | { type: 'steer'; id: string; text: string };

export function createMirrorTurn(options: {
  id: string;
  model: string;
  providerId: string;
  createdAt?: number;
}): MirrorTurn {
  return {
    id: options.id,
    role: 'assistant',
    content: '',
    reasoning: '',
    createdAt: options.createdAt ?? Date.now(),
    model: options.model,
    providerId: options.providerId,
    segments: [],
    injections: [],
    steers: [],
    usage: null,
    error: null,
    finishReason: null,
    terminal: false,
  };
}


export function applyMirrorEvent(
  state: MirrorTurn,
  event: StreamEvent,
  options: { suppressText?: boolean } = {},
): void {
  switch (event.type) {
    case 'meta':
      if (event.model) state.model = event.model;
      if (event.providerId) state.providerId = event.providerId;
      break;
    case 'text': {
      if (options.suppressText) break;
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta) break;
      state.content += delta;
      const last = state.segments[state.segments.length - 1];
      if (last && last.type === 'text') last.text += delta;
      else state.segments.push({ type: 'text', text: delta });
      break;
    }
    case 'reasoning': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta) break;
      state.reasoning += delta;
      const last = state.segments[state.segments.length - 1];
      if (last && last.type === 'reasoning') last.text += delta;
      else state.segments.push({ type: 'reasoning', text: delta });
      break;
    }
    case 'tool_call':
      state.segments.push({
        type: 'tool',
        toolCallId: event.toolCallId,
        serverName: event.serverName ?? '?',
        toolName: event.toolName ?? '?',
        args: event.args,
      });
      break;
    case 'tool_result': {
      for (let i = state.segments.length - 1; i >= 0; i -= 1) {
        const segment = state.segments[i];
        if (segment.type !== 'tool' || segment.summary !== undefined) continue;
        const paired = event.toolCallId
          ? segment.toolCallId === event.toolCallId
          : segment.toolName === event.toolName;
        if (!paired) continue;
        segment.summary = typeof event.summary === 'string' ? event.summary : '';
        segment.ok = event.ok !== false;
        if (event.diff) segment.diff = event.diff;
        if (event.images) segment.toolImages = event.images;
        if (event.visual) segment.visual = event.visual;
        break;
      }
      break;
    }
    case 'steer':
      if (event.text) {
        state.steers.push({ id: event.id ?? `steer_${state.steers.length}`, text: event.text });
        state.segments.push({ type: 'steer', id: event.id ?? `steer_${state.steers.length}`, text: event.text });
      }
      break;
    case 'harness_injection':
      if (event.title || event.content) {
        state.injections.push({
          id: event.id ?? `inj_${state.injections.length}`,
          title: event.title ?? 'Injection',
          content: event.content ?? '',
        });
      }
      break;
    case 'context_telemetry':
      state.liveContext = {
        promptTokens: event.promptTokens ?? 0,
        completionTokens: event.completionTokens ?? 0,
        addedTokens: 0,
        liveContextTokens: event.liveContextTokens ?? 0,
        contextLimit: event.contextLimit ?? null,
        ratio: event.ratio ?? null,
        buckets: state.liveContext?.buckets,
        at: Date.now(),
      };
      break;
    case 'context_live': {
      const buckets = {
        systemTokens: event.systemTokens ?? 0,
        toolsTokens: event.toolsTokens ?? 0,
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        reasoningTokens: event.reasoningTokens ?? 0,
        totalTokens: event.totalTokens ?? 0,
      };
      const prev = state.liveContext;
      const limit = prev?.contextLimit ?? null;
      state.liveContext = {
        promptTokens: prev?.promptTokens ?? 0,
        completionTokens: prev?.completionTokens ?? 0,
        addedTokens: 0,
        liveContextTokens: buckets.totalTokens,
        contextLimit: limit,
        ratio: limit ? Math.min(1, buckets.totalTokens / limit) : prev?.ratio ?? null,
        buckets,
        at: Date.now(),
      };
      break;
    }
    case 'usage':
      state.usage = {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        cacheReadTokens: event.cacheReadTokens,
        ...(event.lastPromptTokens !== undefined ? { lastPromptTokens: event.lastPromptTokens } : {}),
        ...(event.lastCompletionTokens !== undefined ? { lastCompletionTokens: event.lastCompletionTokens } : {}),
        ...(event.lastReasoningTokens !== undefined ? { lastReasoningTokens: event.lastReasoningTokens } : {}),
        ...(event.lastBuckets ? { lastBuckets: event.lastBuckets } : {}),
      };
      recordUsage({
        providerId: state.providerId,
        model: state.model,
        prompt: event.promptTokens ?? 0,
        completion: event.completionTokens ?? 0,
        total: event.totalTokens ?? (event.promptTokens ?? 0) + (event.completionTokens ?? 0),
        cacheRead: event.cacheReadTokens ?? 0,
      });
      break;
    case 'error':
      state.error = event.message ?? 'Unknown provider error.';
      state.terminal = true;
      break;
    case 'done':
      if (event.finishReason) state.finishReason = event.finishReason;
      state.terminal = true;
      break;
    default:
      break;
  }
}


export function serializeMirrorTurn(state: MirrorTurn): Record<string, unknown> {
  const turn: Record<string, unknown> = {
    id: state.id,
    role: state.role,
    content: state.content,
    reasoning: state.reasoning,
    createdAt: state.createdAt,
    model: state.model,
    providerId: state.providerId,
    segments: state.segments.map((segment) => ({ ...segment })),
    injections: state.injections.map((injection) => ({ ...injection })),
    steers: state.steers.map((steer) => ({ ...steer })),
  };
  if (state.usage) turn.usage = state.usage;
  if (state.error) turn.error = state.error;
  if (state.finishReason) turn.finishReason = state.finishReason;
  return turn;
}


function storeTurnIsTerminal(conversationId: string, turnId: string): boolean {
  const record = getStoredConversation(conversationId);
  const turns = Array.isArray(record?.turns) ? record!.turns : [];
  const turn = turns.find(
    (entry): entry is { id: string; usage?: unknown; finishReason?: unknown; error?: unknown } =>
      typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === turnId,
  );
  if (!turn) return false;
  return (
    turn.usage !== undefined && turn.usage !== null ||
    turn.finishReason !== undefined ||
    (typeof turn.error === 'string' && turn.error.length > 0)
  );
}

export interface TurnMirrorHandle {
  
  apply(event: StreamEvent): void;
  
  flushFinal(): void;
}


export function startTurnMirror(options: {
  conversationId: string;
  turnId: string;
  model: string;
  providerId: string;
  suppressText?: boolean;
  
  flushIntervalMs?: number;
}): TurnMirrorHandle | null {
  if (!options.conversationId || !options.turnId) return null;
  const state = createMirrorTurn({
    id: options.turnId,
    model: options.model,
    providerId: options.providerId,
  });
  const interval = options.flushIntervalMs ?? MIRROR_FLUSH_MS;
  let lastFlushAt = 0;

  const flush = (): void => {
    if (state.liveContext) {
      setStoredLiveContext(options.conversationId, state.liveContext, state.terminal);
    }
    if (storeTurnIsTerminal(options.conversationId, options.turnId)) return;
    applyTurnPatches([
      {
        conversationId: options.conversationId,
        turnId: options.turnId,
        turn: serializeMirrorTurn(state),
      },
    ]);
    lastFlushAt = Date.now();
  };

  return {
    apply(event: StreamEvent): void {
      applyMirrorEvent(state, event, { suppressText: options.suppressText });
      if (event.type === 'tool_result' && event.visual) flush();
      if (state.terminal) {
        flush();
        return;
      }
      if (Date.now() - lastFlushAt >= interval) flush();
    },
    flushFinal(): void {
      flush();
    },
  };
}
