/**
 * SERVER-SIDE TURN MIRROR — the store's own writer for an in-flight turn.
 *
 * THE BUG THIS KILLS: the conversation record's live turn was written by the
 * CLIENT ONLY. The /api/conversations/sync patch channel is fed by the
 * streaming tab's reducer — when that tab is frozen, closed, or its re-attach
 * budget ran out, nobody pushed the run's output anywhere durable: the proxy
 * finished the work (goals done, journal complete) while every reader — any
 * refresh, any second browser — saw the pre-run thread. The mirror closes
 * that hole at the source: the route that EXECUTES the run folds the same
 * StreamEvents into a turn and patches the store itself, on a cadence, plus a
 * final flush in the run's finally. The record is now current server-side no
 * matter what any client does.
 *
 * WHY A REDUCER DUPLICATE IS UNAVOIDABLE HERE: the client's reducer is fused
 * with browser side-effects (rAF flushes, permission cards, panel opening).
 * The mirror folds ONLY the persisted shape — content, reasoning, segments,
 * injections, steers, usage, finishReason, error — which is exactly what the
 * patch channel replaces by turn id. The turn id itself is the shared
 * contract: the client sends `assistantTurnId`, the server echoes it on the
 * stream_id frame (see index.ts), so this mirror, the originating tab, and
 * every re-attaching consumer address ONE turn and converge by replace.
 *
 * WHOSE FLUSH WINS: mid-run, both writers replace by id — the mirror's
 * cadence (~1.5s) and the client's sync debounce interleave harmlessly. At
 * run end the GUARD is terminal-state: if the store's turn already carries
 * usage / finishReason / error, the client's (richer) flush landed, and the
 * mirror stands down. A dead client's turn has none of those, so the mirror's
 * final flush is the truth that survives.
 */
import type { StreamEvent } from './contracts.js';
import { applyTurnPatches, getStoredConversation } from './conversationStore.js';
import { recordUsage } from './usageLedger.js';

/** How often a live run's mirror flushes into the store (cadence, not per token). */
export const MIRROR_FLUSH_MS = 1_500;

/** Structural shape the mirror owns — the persisted assistant turn's fields. */
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
  } | null;
  error: string | null;
  finishReason: string | null;
  /** True once a done/error event (or the run's finish) marked this turn terminal. */
  terminal: boolean;
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
      /**
       * VISUAL v2: `replaces` = edit-in-place (the newest render_visual
       * segment for this id is the live card's payload; earlier segments are
       * the audit trail). `variants` = 1..3 frontend-preview candidates.
       */
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

/**
 * Fold ONE stream event into the mirror state. Pure: mutates only the given
 * state object, touches nothing else — this is the testable core.
 *
 * `suppressText` matches the client's OUTPUT BLOCK policy (probation Tier 4+):
 * the model's text must not land in the visible transcript while frozen, so
 * the mirrored record must not hold it either — a second browser reading the
 * store must see what the owning tab's freeze card shows (nothing), not the
 * suppressed text itself.
 */
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
    case 'usage':
      state.usage = {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        cacheReadTokens: event.cacheReadTokens,
      };
      // USAGE LEDGER — persist per-provider token accounting (the dashboard's
      // durable accumulation source; survives provider switches and chat
      // clears, unlike the in-memory turns sum).
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

/** The store-ready turn object: nulls are OMITTED, not written. */
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

/**
 * True when the store's copy of this turn is already TERMINAL (usage,
 * finishReason, or error present): the client's own richer flush landed, and
 * the mirror must not replace it with its leaner reconstruction.
 */
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
  /** Feed one stream event (the route's StreamHandler calls this). */
  apply(event: StreamEvent): void;
  /** Flush now, honoring the terminal guard (the run-end path). */
  flushFinal(): void;
}

/**
 * Open a mirror for one run. Returns null when the run carries no
 * conversation (one-shot helpers) or is the compaction summarizer (machinery,
 * not a thread turn — its output must never land in the record).
 */
export function startTurnMirror(options: {
  conversationId: string;
  turnId: string;
  model: string;
  providerId: string;
  suppressText?: boolean;
  /** Overrides the flush cadence (tests shrink this; default MIRROR_FLUSH_MS). */
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
      // VISUAL v2: a visual-bearing tool_result flushes IMMEDIATELY — the
      // next tool round may be an edit-in-place that must find this id in
      // the store, and a heavy artifact should never wait for the cadence.
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
