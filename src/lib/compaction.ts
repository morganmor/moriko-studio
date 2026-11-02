import type {
  ChatMessage,
  ChatSettings,
  Conversation,
  MessageContentPart,
  ModelCapabilitySource,
  Turn,
  TurnToolCall,
} from '../types';
import type { ResolvedModelCapability } from './modelCapability';
import { attachmentRefWireUrl } from './api';
import {
  CHARS_PER_TOKEN,
  priceFrame,
  type FrameBuckets,
} from '../../shared/contextAccounting';
import type { LiveContextTelemetry } from '../types';

/** The five server-meter buckets, as the client stores them. */
type LiveContextBuckets = NonNullable<LiveContextTelemetry['buckets']>;
/**
 * Client-side context management, modeled on the DSH compaction family and
 * Claude's server-side compaction: measure token pressure, condense older
 * history into a summary, and rebuild the wire context from
 * summary + uncovered turns.
 *
 * REASONING IS NEVER PRUNED BY THE HARNESS. It rides the rebuilt wire on every
 * assistant turn, whatever happens in between — between tool rounds, across
 * user turns, and inside the compaction transcript. The single exception is
 * the user's own trim action (`trimReasoning` in the store), exposed as a
 * button in the composer's context popover: an explicit act, chosen by the
 * user, never a side effect of sending the next message.
 *
 * Measurement doctrine (THE USER'S SPECIFICATION):
 *  - FIVE buckets, each measured DIRECTLY from the reconstructed wire —
 *    system / tools / input / output / reasoning. No bucket is derived from
 *    another; there is no remainder, no subtraction.
 *  - NOTHING may shrink out of the context except COMPACTION (and the user's
 *    explicit reasoning trim). No digest aging, no pruning pre-pass, no image
 *    offload: tool results and images always ride exactly as stored.
 *  - The arithmetic lives in shared/contextAccounting.ts, imported by BOTH
 *    the client and the server meter, so both sides share ONE definite figure.
 *  - `contextPlan()` is the ONE builder both the estimate and the send path
 *    use — measure and send can no longer disagree.
 */

/** Fire the context-limit trigger at 95% of the effective limit. */
const LIMIT_TRIGGER_RATIO = 0.95;
export interface ContextStats {
  /** Σ billed tokens across every recorded turn (all-time usage). */
  totalUsedTokens: number;
  /**
   * Tokens the context window ACTUALLY occupies right now: the reconstructed
   * wire the NEXT request will carry (system prompt + tool defs + messages),
   * measured by `estimateConversationContext`. Deterministic — it moves only
   * when stored content moves, so it cannot oscillate between provider
   * samples the way a usage-anchored figure does.
   */
  activeTokens: number;
  /** Context limit: the resolved model capacity, possibly lowered manually. */
  effectiveLimit: number | null;
  /**
   * WHERE the limit came from — the resolved per-field provenance of the
   * context window ('user' table → 'provider' introspection → 'models.dev'
   * hint), 'manual' when the user lowered it below the model's own capacity,
   * or null when NO layer knows the window — the limit is then unknown, no
   * number is invented, and the context-limit trigger simply never arms.
   */
  limitSource: ContextLimitSource | null;
}

/** Provenance of the active context limit, as shown in the composer chip. */
export type ContextLimitSource = ModelCapabilitySource | 'manual';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * How much reasoning would the user's trim actually free FROM THE WIRE?
 *
 * Only turns that still ride verbatim count: a turn covered by a compaction
 * checkpoint travels as the summary, so its reasoning is already off-context
 * and trimming it frees nothing. Counting those inflated the number the button
 * promises — it reported 126k while the meter priced the ENTIRE message
 * section at 88k, which is exactly how a user stops trusting the meter.
 *
 * The trim itself still strips every turn (including covered ones): this
 * function answers "how much context does this buy me", not "how many bytes
 * does it touch".
 */
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

/**
 * THE INVERSE OF THE WIRE POLICY, kept next to it on purpose.
 *
 * Strips every reasoning block from a turn list — the legacy per-turn field
 * AND the per-round reasoning segments (clearing only one of them is the bug
 * the per-turn trash button already documents). The store's `trimReasoning`
 * action is its ONLY caller: the harness itself never invokes this, which is
 * the entire point of the policy above. Reasoning leaves the conversation when
 * the user says so, and never because a message was sent or a threshold hit.
 *
 * Returns the untouched list (same reference) when there was nothing to strip.
 */
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

/**
 * Prices a turn by its FULL wire text (content + reasoning + segments, i.e.
 * tool calls/results) — exactly what the summarizer transcript renders.
 * Pricing `turn.content` alone undercounted tool-heavy turns (agent sessions
 * are dominated by tool blocks living in segments), making replacedTokens far
 * smaller than the material the checkpoint actually replaces and wrongly
 * failing the shrink gate ("~3985 vs ~1238 source tokens").
 */
function turnTokens(turn: Turn): number {
  return estimateTokens(wireTurnText(turn));
}

/**
 * Price ONE reconstructed wire message into the FOUR user-facing buckets
 * (tools / input / output / reasoning) — delegated to the SHARED estimator so
 * the client and the server meter price the identical wire identically.
 */
export function priceWireMessage(message: ChatMessage): FrameBuckets {
  return priceFrame(message);
}

/** The five user-facing occupancy buckets plus their exact sum. */
export interface ContextEstimate {
  /** Sidebar System Prompt + every harness system-prompt injection. */
  systemTokens: number;
  /** Native tool defs JSON + tool calls made + tool outputs on the wire. */
  toolsTokens: number;
  /** User input on the wire. */
  inputTokens: number;
  /** Model output prose on the wire. */
  outputTokens: number;
  /** Assistant chain-of-thought riding the wire (`reasoning_content`). */
  reasoningTokens: number;
  /** Exact sum of the five buckets — nothing unaccounted. */
  totalTokens: number;
}

/**
 * Measure the conversation's ACTIVE context the way the next request will
 * carry it: the composed system message (user prompt + harness injections),
 * the tool defs the server reported riding the request, and the reconstructed
 * wire from `contextPlan` — the SAME builder the send path uses, so the
 * measurement and the payload can never disagree. Every bucket is measured
 * DIRECTLY; the total is their sum.
 */
export function estimateConversationContext(conversation: Conversation): ContextEstimate {
  const systemTokens =
    estimateTokens(conversation.settings.systemInstruction ?? '') +
    (conversation.harnessContext?.injections ?? []).reduce(
      (sum, injection) => sum + estimateTokens(injection.content),
      0,
    );
  const toolsDefs = conversation.harnessContext?.toolsDefsChars
    ? Math.ceil(conversation.harnessContext.toolsDefsChars / CHARS_PER_TOKEN)
    : 0;
  let tools = toolsDefs;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  for (const message of contextPlan(conversation).messages) {
    const priced = priceWireMessage(message);
    tools += priced.tools;
    input += priced.input;
    output += priced.output;
    reasoning += priced.reasoning;
  }
  return {
    systemTokens,
    toolsTokens: tools,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: systemTokens + tools + input + output + reasoning,
  };
}

/** Context statistics for the composer chip. */
export function contextStats(
  conversation: Conversation,
  capability: ResolvedModelCapability | undefined,
): ContextStats {
  const { limit, source } = effectiveContextLimit(conversation.settings, capability);

  let totalUsedTokens = 0;
  for (const turn of conversation.turns) {
    const usage = turn.usage;
    if (!usage) continue;
    totalUsedTokens += usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }

  const activeTokens = estimateConversationContext(conversation).totalTokens;

  return { totalUsedTokens, activeTokens, effectiveLimit: limit, limitSource: source };
}

/**
 * The ACTIVE context limit, resolved through the 3-layer cascade.
 *
 * `capability.context` is ALREADY the cascade's answer (user table → provider
 * introspection → models.dev hint → unknown), so it is taken verbatim. There is
 * deliberately no `Math.min` against a lower layer: that comparison is what
 * silently truncated a user-declared 1M window down to whatever a stale
 * catalogue row claimed.
 *
 * The one comparison that remains is against `settings.maxContextTokens`, the
 * user's own explicit "lower context limit" cost control — user against user,
 * never a catalogue shrinking a human decision.
 */
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
  // NOTHING knows the window: the limit is unknown, not a guessed constant.
  // The auto-compaction trigger stays disarmed and a long session ends in the
  // provider's own refusal — an error the user SEES, never a silent 256K cap
  // truncating work in the middle of a task.
  return { limit: null, source: null };
}

export interface ContextBreakdown extends ContextStats {
  /** Sidebar System Prompt + every harness system-prompt injection. */
  systemTokens: number;
  /** Native tool defs + tool calls made + tool outputs riding the wire. */
  toolsTokens: number;
  /** User input on the wire. */
  inputTokens: number;
  /** Model output prose on the wire. */
  outputTokens: number;
  /**
   * The reasoning blocks riding the wire — the SAME figure the trim button
   * offers to remove, from one shared definition, so the popover and the
   * button can never disagree.
   */
  reasoningTokens: number;
  /**
   * TRUE while the SERVER's live figures are on screen (guard telemetry or
   * the per-second meter buckets) rather than the local static estimate.
   */
  live: boolean;
}

/**
 * Breakdown of the ACTIVE context into the FIVE rows — the DeepSeek-web-style
 * usage popover. Every row is MEASURED DIRECTLY, never derived from another:
 *  - System prompt   = the sidebar System Prompt + every harness injection,
 *  - Tool definitions = the native tool defs + the tool calls made and the
 *    tool outputs that ride the wire (nothing tool-shaped leaks elsewhere),
 *  - Input           = the user's messages on the wire,
 *  - Output          = the model's prose on the wire,
 *  - Reasoning       = the chain-of-thought riding `reasoning_content`.
 * While a run streams, the SERVER METER's `context_live` buckets are the
 * authority — per-second, grown by every delta, priced by the SAME shared
 * estimator the client uses. Idle / pre-first-frame, the local estimate (the
 * same arithmetic over the stored wire) fills in. The rows always sum exactly
 * to their total — no remainder, no subtraction anywhere.
 *
 * cx-top = System + Tools + Input + Output + Reasoning + gap, where `gap` is
 * the provider's billing offset FROZEN at telemetry time and applied to the
 * headline ONLY — no bucket absorbs it, so no row can eat another.
 */
export function contextBreakdown(
  conversation: Conversation,
  capability: ResolvedModelCapability | undefined,
  live?: { liveContextTokens?: number | null; gap?: number | null; buckets?: LiveContextBuckets | null } | null,
): ContextBreakdown {
  const stats = contextStats(conversation, capability);
  const estimate = estimateConversationContext(conversation);
  const liveActive = typeof live?.liveContextTokens === 'number' && live.liveContextTokens > 0;
  const gap = liveActive && typeof live?.gap === 'number' && live.gap > 0 ? live.gap : 0;
  const buckets = live?.buckets;
  const systemTokens = buckets ? buckets.systemTokens : estimate.systemTokens;
  const toolsTokens = buckets ? buckets.toolsTokens : estimate.toolsTokens;
  const inputTokens = buckets ? buckets.inputTokens : estimate.inputTokens;
  const outputTokens = buckets ? buckets.outputTokens : estimate.outputTokens;
  const reasoningTokens = buckets ? buckets.reasoningTokens : estimate.reasoningTokens;
  // When server buckets are available, they are the calibrated truth — the
  // provider's real numbers absorbed into Tools, Output and Reasoning locked
  // to completionTokens. NO gap is added: the buckets ARE the provider count.
  // The local `gap` field stays for the fallback window (pre-first-frame, idle)
  // where only the local estimate is available.
  const useGap = !buckets;
  return {
    ...stats,
    activeTokens: useGap
      ? systemTokens + toolsTokens + inputTokens + outputTokens + reasoningTokens + gap
      : systemTokens + toolsTokens + inputTokens + outputTokens + reasoningTokens,
    systemTokens,
    toolsTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    live: liveActive,
  };
}


/** Args echo budget (chars), for wire headers. */
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

/**
 * WIRE-SAFE ARGUMENTS — a truncated arguments string (e.g.
 * {"height":860,"variants":) poisons the wire: providers that JSON.parse
 * tool-call arguments (Python backends) reject the WHOLE request. Close the
 * dangling keys/braces the same way the server's repairPartialJson does, so
 * stored segments from older runs heal on the rebuilt wire.
 */
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

/**
 * Tool results ride FULLY — the user's doctrine: nothing may shrink out of
 * the context except compaction. No digest, no truncation, no placeholder.
 */
function wireToolSegment(segment: { toolName: string; args?: string; summary?: string; ok?: boolean }): string {
  const args = shortArgs(segment.args);
  const header = `[tool ${segment.toolName}${args ? ` ${args}` : ''} — ${toolSegmentState(segment)}]`;
  const summary = segment.summary?.trim() ?? '';
  return summary ? `${header}\n${summary}` : header;
}

/**
 * The wire text for one stored turn. Prose turns ride verbatim; tool-bearing
 * turns ride their SEGMENTS — the ordered text/tool/reasoning blocks — with
 * every tool result riding FULLY (no aging, no digest).
 *
 * CRITICAL: a turn whose `content` is non-empty but that ALSO ran tools must
 * NOT collapse to `content` alone. Doing so drops every tool call and its
 * result from the rebuilt context — the post-error / next-turn amnesia where
 * the model forgets all in-run work the moment the conversation resumes.
 * Segments are the authoritative record; content is a flat projection of the
 * text blocks only.
 *
 * @deprecated for tool-bearing turns — use `wireMessages` instead. Text-only
 * turns have nothing structural to preserve, so this stays the right tool for
 * them (and the fallback for segments that carry no usable ids).
 */
export function wireTurnText(turn: Pick<Turn, 'content' | 'reasoning' | 'segments'>): string {
  if (turn.segments?.length) {
    const parts: string[] = [];
    for (const segment of turn.segments) {
      if (segment.type === 'text' && segment.text.trim()) {
        parts.push(segment.text);
      } else if (segment.type === 'reasoning') {
        // NEVER prose. Reasoning rides the assistant message's own
        // `reasoning_content` field (see wireMessages); wrapping it in tag
        // text taught the model that thinking is something it types into the
        // answer, and it started imitating exactly that.
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

/**
 * STOPPED-TURN MARKER (stop-bug fix).
 *
 * When the user presses Stop, the assistant turn ends mid-flight on the wire —
 * tool calls without results, prose cut mid-sentence. On the NEXT send the
 * provider receives that half-finished turn as the last assistant message, and
 * tool-loop models read it as "my work was interrupted — continue it", so the
 * new user input gets ignored and the OLD task resumes. Marking the stopped
 * turn tells the model the run ENDED there on the user's order.
 */
export function appendWireTurnStop(turn: Pick<Turn, 'finishReason'>): string {
  return turn.finishReason === 'user_stop'
    ? '\n[The generation above was stopped by the user. That task is ENDED — do not resume or continue it. Respond to the newest user message only.]'
    : '';
}

/**
 * Rebuilds the NATIVE wire messages for one stored turn.
 *
 * The rebuilt history used to flatten every assistant turn into a single
 * pseudo-record — prose interleaved with `[tool x — done]` stubs. At short
 * context that is merely ugly. Past ~70k tokens it is actively corrosive for
 * tool-history-sensitive models (the GLM-5.x family is the documented case):
 * with the call↔result pairing destroyed, the model can no longer tell "I
 * called this and got that" from "someone wrote this text", so it starts
 * emitting phantom tool calls, re-emitting old rounds verbatim, and fusing
 * separate reasoning rounds into nonsense. That is the Atria degradation.
 *
 * This keeps the real shape: each tool round emits the assistant message
 * that requested the calls (native `tool_calls`, the provider's own ids),
 * then one `tool` message per call carrying its result. Text rounds emit a
 * plain assistant message. The model sees exactly the structure it produced.
 *
 * A round is only rebuilt natively when it is FULLY reconstructible — every
 * call carries `toolCallId` AND a landed result. Otherwise the whole round
 * degrades to the text rendering, because half-wiring a round (calls with no
 * results, or results with no callable id) is precisely the malformed
 * history this fix exists to prevent.
 */
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
  /**
   * The round's chain-of-thought, kept BESIDE the text, never inside it. It is
   * attached to that round's assistant message as `reasoning_content` — the
   * field every thinking provider expects on replay, and the one DeepSeek
   * rejects the request for when a tool-bearing turn omits it.
   */
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
        // NO text and NO tool calls (the in-flight reasoning-only turn, or a
        // thinking model that produced a tool round with no prose). Dropping
        // the reasoning here deleted it from the wire while the Reasoning row
        // still counted it — and the old output-remainder then made Messages
        // shrink one-for-one as reasoning streamed. Emit an assistant frame
        // carrying ONLY `reasoning_content` — reasoning is never discarded.
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
      // Tool results ride FULLY — images included, no budget, no offload,
      // no degraded note. Nothing may leave the wire except compaction.
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
      // Text (and thinking) AFTER a tool call belongs to the NEXT round: the
      // model resumed once it had the result. Letting it ride the tool-calling
      // message would show the model its answer before the result, and would
      // file this round's chain-of-thought under the previous round.
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
    // `turn.reasoning` AND every reasoning segment. Dropping segments here
    // deleted reasoning from the wire while the Reasoning row counted it.
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

/** The wire framing for a mid-run steer note riding a rebuild. */
function steerWireBody(notes: string): string {
  return [
    'STEERED MID-RUN — the user sent this while you were working. Treat',
    'it as their latest, highest-priority instruction; it was already',
    'honored in the reply above. Keep it in mind going forward.',
    '',
    notes,
  ].join('\n');
}

/**
 * The content of a native `tool` message. The result rides FULLY — the user's
 * doctrine: nothing may shrink out of the context except compaction.
 */
function toolResultContent(summary: string): string {
  return summary.trim() ? summary : '(no output)';
}

/**
 * Rebuilds the wire name a tool segment would have been called by. Agent
 * harness segments are labelled `serverName: 'Workspace'` and carry the bare
 * tool name; MCP segments carry the real server name.
 */
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


/**
 * Builds the wire content for a stored USER turn: plain text normally,
 * OpenAI-style content parts when files ride along. Lives here (not in the
 * send path) because `contextPlan` is the ONE wire builder — the estimate
 * measures exactly what the request will carry.
 */
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
      /**
       * VIDEO — the nested OpenAI-compatible shape, never a `file` wrapper.
       * Gateways whose body parser is a Rust untagged enum (MiniMax) accept
       * exactly `{type:'video_url', video_url:{url}}`; anything else fails the
       * whole request with "did not match any variant of untagged enum
       * ChatCompletionRequestUserMessageContent".
       */
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

/**
 * Builds the wire content for one stored steer — an ORDINARY user message.
 * Parts (text/image/file) ride verbatim; text-only steers send a string.
 */
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
  /** Messages to send on the wire (summary first, then uncovered turns). */
  messages: ChatMessage[];
  /**
   * Owner turn id per message (null for the leading checkpoint summary) —
   * the tag stream `summarizationReplay` slices to recover the exact wire
   * prefix of the turns being replaced.
   */
  tags: Array<string | null>;
  /** Turn ids excluded from the wire (represented by the summary). */
  coveredTurnIds: string[];
  /** True when a summary message leads the wire payload. */
  hasSummary: boolean;
}

/**
 * Framing copied from the DSH compaction family: the replacement leading
 * message presents the summary as ESTABLISHED BACKGROUND (a checkpoint),
 * wrapped in <compacted-summary> tags so a later compaction recognizes and
 * consolidates prior checkpoints instead of stacking them.
 */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

export function contextPlan(conversation: Conversation): ContextPlan {
  const compaction = conversation.compaction;
  const covered = new Set(compaction?.coveredTurnIds ?? []);
  const messages: ChatMessage[] = [];
  const tags: Array<string | null> = [];

  if (compaction?.summary) {
    messages.push({
      role: 'user',
      content: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${compaction.summary}\n</compacted-summary>`,
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
    coveredTurnIds: compaction?.coveredTurnIds ?? [],
    hasSummary: Boolean(compaction?.summary),
  };
}


export type CompactTrigger = 'manual' | 'threshold' | 'context-limit' | null;

/**
 * THE ONE NUMBER the chip and every compaction trigger read — BY CONSTRUCTION.
 *
 * This is literally `contextBreakdown(...).activeTokens`, the same function the
 * composer's context popover renders: the server meter's buckets (which include
 * the accumulated tool calls + tool outputs the model has produced) when they
 * are on screen, the local wire estimate otherwise. Any trigger that wants to
 * compare against the number the user SEES must measure through this — an
 * `estimateConversationContext` call beside it would drift below the chip
 * while a round's tool output is still streaming, and the trigger would stay
 * silent at 506K / 500K.
 */
export function measuredActiveTokens(
  conversation: Conversation,
  capability: ResolvedModelCapability | undefined,
  live?: { liveContextTokens?: number | null; gap?: number | null; buckets?: LiveContextBuckets | null } | null,
): number {
  return contextBreakdown(conversation, capability, live).activeTokens;
}

/**
 * Should the NEXT send auto-compact first?
 *
 * The measurement is `measuredActiveTokens` — the EXACT figure the context
 * chip displays (server meter buckets incl. accumulated tool calls + tool
 * outputs, or the local wire estimate) — plus the not-yet-stored incoming
 * message: what the next request WOULD carry. Never a divergent estimate, so
 * the trigger and the displayed occupancy can never disagree.
 *
 * - `threshold`: the user's explicit token threshold is reached.
 * - `context-limit`: the measured figure reaches the configured ratio of the
 *   effective limit — the limit being whichever is tighter, the model's
 *   resolved capacity or the user's Lower Context Limit setting.
 *
 * `incomingTokens` is the size of the user's new message that has not been
 * appended to the conversation yet.
 */
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

/**
 * The guard's OWN threshold, mirrored so the client can pre-empt it.
 *
 * `CONTEXT_COMPACT_RATIO` on the server is 0.85; the client's default is 0.95.
 * The client must win that race, or the server reaches its handoff before the
 * client has ever considered compacting. Kept as a named constant rather than a
 * literal so the relationship to the server value is visible.
 */
export const SERVER_HANDOFF_RATIO = 0.85;

/** Would the SERVER guard hand off at this token count? */
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
  incomingTokens: number,
  live?: { liveContextTokens?: number | null; gap?: number | null; buckets?: LiveContextBuckets | null } | null,
): Exclude<CompactTrigger, null | 'manual'> | null {
  const settings = conversation.settings;
  if (!settings.autoCompact) return null;

  // THE CHIP'S OWN NUMBER, plus the incoming message — 1:1 with the UI.
  const measured = measuredActiveTokens(conversation, capability, live) + Math.max(0, incomingTokens);
  return triggerForMeasuredTokens(settings, capability, measured);
}

/**
 * CACHE-FRIENDLY SUMMARIZER INPUT (DSH summarizer.ts): the exact wire prefix
 * the live request carried — the checkpoint message first, then the messages
 * of the turns being replaced — so the summarization call is a genuine prefix
 * of the routed request and the provider's KV cache is reused instead of
 * re-billed. The compaction directive rides as the FINAL user message (the
 * only novel input).
 */
export function summarizationReplay(
  plan: ContextPlan,
  coveredTurnIds: string[],
): ChatMessage[] {
  const covered = new Set(coveredTurnIds);
  let end = 0;
  for (let index = 0; index < plan.tags.length; index += 1) {
    const tag = plan.tags[index];
    if (tag === null || covered.has(tag)) end = index + 1;
  }
  return plan.messages.slice(0, end);
}


/**
 * The summarization directive, ported from the DSH compaction family
 * (packages/compaction/compaction-basic/src/summarizer.ts): the model must
 * produce a LONG, DETAILED structured checkpoint — every section present,
 * in order — so another model (or a later self) can resume the work with no
 * loss of essential context. Terse bullets, never prose paragraphs.
 *
 * Two framings: `COMPACT_INSTRUCTION` (primary) rides as the FINAL USER
 * MESSAGE after the replayed wire prefix — keeping the conversation's own
 * system prompt, tools, and messages byte-for-byte in front of it so the
 * provider's KV cache is reused instead of re-billed; `COMPACT_SYSTEM_INSTRUCTION`
 * (fallback) is the legacy system-prompt form used when the replayed call
 * fails and the elided-transcript retry takes over.
 */
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
    '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
    ...(framing === 'replay'
      ? [
          '- Do NOT call any tool or take any other action — the tool schemas ride only so this request matches the cached prefix. Summarize; do not work.',
        ]
      : []),
  ].join('\n');
}

/** Primary — final user message after the replayed wire prefix (cache-friendly). */
export const COMPACT_INSTRUCTION = compactionDirective('replay');
/** Fallback — legacy system-prompt framing for the elided-transcript retry. */
export const COMPACT_SYSTEM_INSTRUCTION = compactionDirective('transcript');

/**
 * Drops the model's `<analysis>` scratchpad before the checkpoint is stored.
 *
 * The analysis is a DRAFTING pass: it forces a chronological walk (files,
 * snippets, errors, and — above all — verbatim user corrections) before the
 * compression happens. It must never ride in context afterwards: it is longer
 * than the checkpoint and would defeat the whole point of compacting.
 *
 * Tolerates a truncated block in both directions, because a model that hit its
 * output ceiling mid-scratchpad must not lose the checkpoint that follows.
 */
export function stripCompactionAnalysis(raw: string): string {
  let text = raw.trim();
  if (!text) return text;
  // Complete blocks (possibly several).
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  // Unterminated opening tag: everything after it is still scratchpad.
  const openAt = text.search(/<analysis>/i);
  if (openAt !== -1) text = text.slice(0, openAt).trim();
  // Orphan closing tag (the opening was cut off): keep only the tail.
  const closeTag = '</analysis>';
  const closeAt = text.search(/<\/analysis>/i);
  if (closeAt !== -1) text = text.slice(closeAt + closeTag.length).trim();
  return text;
}

/**
 * Structural gate for a summarizer output BEFORE it may replace the live
 * compaction. The system instruction mandates nine `##` sections; a model
 * that ignored the directive and replayed the transcript (the observed
 * garbage: raw `[tool … — done]` log lines) lacks them. Requiring the three
 * sections that every legitimate checkpoint must carry — and that a log
 * replay virtually never produces — keeps the failure mode from silently
 * taking over the wire context. A short mandatory preamble (the checkpoint
 * intro line) is tolerated as an alternative signal for models that render
 * the body faithfully but phrase headers slightly differently.
 */
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
  /** Estimated tokens the summary replaces (for the toast). */
  replacedTokens: number;
}

/** The durable goal state, serialized for the summarizer — the checkpoint's
 *  Goals & Todos section must be able to restate it verbatim. */
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

/**
 * Upper bound on the compaction transcript, in characters. The summarization
 * request goes to the SAME provider and (by default) the SAME model whose
 * window the thread just overflowed — without a cap, a 180K+ context rebuilds
 * a transcript the provider rejects exactly like the chat it was meant to
 * save, compaction fails silently, the context never shrinks, and the retry
 * loop starts. ~600K chars prices to ~150K tokens, which leaves real headroom
 * under a 200K window even with the system instruction and the output budget.
 */
const MAX_TRANSCRIPT_CHARS = 600_000;

/** Marker rendered where an oversized turn's body was cut. */
function elisionMarker(dropped: number): string {
  return `\n\n[… ${dropped} characters elided to fit the summarization request …]\n\n`;
}

/**
 * A bounded excerpt of an oversized body: head + marker + tail. The tail is
 * the important half — it is what the turn was doing when it ended, which is
 * exactly what a continuation needs.
 */
function elideBody(body: string, allowance: number): string {
  if (body.length <= allowance) return body;
  const markerLength = elisionMarker(body.length).length;
  const keep = allowance - markerLength - 2;
  if (keep < 200) return elisionMarker(body.length).trim();
  const head = Math.floor(keep * 0.7);
  const tail = keep - head;
  return body.slice(0, head) + elisionMarker(body.length - keep) + body.slice(body.length - tail);
}

/**
 * Picks the turns to condense and returns the transcript payload for the
 * summarization request.
 *
 * COVERAGE IS THE CONTRACT: every turn this function puts in `turns` leaves
 * the wire and is replaced by the checkpoint. Two policies used to break that
 * contract on reasoning-heavy agent threads, and both are fixed here:
 *
 *  - every eligible turn is covered; nothing is kept verbatim outside the
 *    checkpoint;
 *  - the transcript cap ELIDES an oversized body instead of dropping the turn
 *    from coverage — the cap exists to fit the summarization request, and the
 *    largest turn is exactly the one it would otherwise exclude.
 *
 */
export function compactCandidate(conversation: Conversation): {
  turns: Turn[];
  transcript: string;
  replacedTokens: number;
  /** Serialized live goal state — rides with the compaction directive. */
  goalBlock: string;
} | null {
  let covered = conversation.turns.filter(
    (turn) =>
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

  const prior = conversation.compaction?.summary;
  const goalBlock = conversation.goals?.length
    ? `CURRENT GOAL STATE (authoritative — restate it verbatim in the Goals & Todos section):\n${serializeGoals(conversation.goals)}\n\n---\n\n`
    : '';
  const preamble =
    (prior ? `PRIOR CHECKPOINT (merge, do not copy verbatim):\n${prior}\n\n---\n\n` : '') + goalBlock;

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
  return {
    ...conversation,
    compaction: {
      summary: outcome.summary,
      coveredTurnIds: outcome.coveredTurnIds,
      trigger,
      createdAt: Date.now(),
    },
  };
}
/**
 * ABORT REGISTRY for in-flight compactions, keyed by conversation id.
 *
 * The summarizer stream lives inside the controller, but the UI teardowns
 * that must kill it (deleting the streaming card, Stop, deleting the
 * conversation) run in the store — this neutral registry is the meeting
 * point, so a deleted card stops its stream instead of committing a
 * checkpoint over its own grave.
 */
const compactionAborters = new Map<string, () => void>();

export function registerCompactionAbort(conversationId: string, abort: () => void): void {
  compactionAborters.set(conversationId, abort);
}

export function clearCompactionAbort(conversationId: string): void {
  compactionAborters.delete(conversationId);
}

/** Fires the live abort (if any) and reports whether one existed. */
export function abortCompaction(conversationId: string): boolean {
  const abort = compactionAborters.get(conversationId);
  if (!abort) return false;
  compactionAborters.delete(conversationId);
  abort();
  return true;
}
