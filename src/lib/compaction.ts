import type {
  ChatMessage,
  ChatSettings,
  Conversation,
  MessageContentPart,
  ModelMeta,
  Turn,
  TurnToolCall,
} from '../types';
import { attachmentRefWireUrl } from './api';
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
 * Measurement philosophy (ported from the DSH token-meter): occupancy is
 * measured from the RECONSTRUCTED WIRE — the exact message list the next
 * request will carry, plus the system prompt and the tool defs the server
 * reports — never from the provider's per-request usage. The provider number
 * describes what ONE round of an agent loop saw at its peak; the rebuilt wire
 * is what the NEXT request actually carries, and the two disagree by design
 * (tool digests, aging, compaction). Anchoring the display to usage is what
 * made the context figure jump 115K → 30K between sends. Reconstruction is
 * deterministic: the number moves only when stored content moves, the three
 * buckets sum exactly to the total (no unaccounted remainder), and
 * `contextPlan()` is the ONE builder both the estimate and the send path use —
 * measure and send can no longer disagree.
 */

const CHARS_PER_TOKEN = 4;
/** Image offload only: live turns newer than this keep their pixels. */
const IMAGE_OFFLOAD_RECENT_TURNS = 4;
/** Fire the context-limit trigger at 95% of the effective limit. */
const LIMIT_TRIGGER_RATIO = 0.95;
/**
 * Fallback context window when NEITHER models.dev metadata nor a user cap is
 * available. Without a ceiling the 95% auto-compaction trigger has nothing to
 * measure against and can never arm — a long session on an uncovered model
 * then runs straight into the provider's own refusal (the reported 180K+
 * "Inference request failed" on 256K-1M-context models). 256K is deliberately
 * generous: a real metadata entry or an explicit user cap ALWAYS wins above it,
 * so this only ever catches "we have no idea what this model accepts".
 */
export const FALLBACK_CONTEXT_LIMIT = 256_000;
/**
 * Structural wire overhead, ported from the DSH token-meter estimator: every
 * message frame and every native tool-call entry costs a few tokens beyond its
 * text (role, delimiters, JSON keys). Counting them keeps the estimate from
 * systematically underpricing tool-heavy history.
 */
const MESSAGE_FRAME_TOKENS = 4;
const TOOL_CALL_FRAME_TOKENS = 4;
/** Fixed price for a binary attachment part (image/file) — not char-countable. */
const ATTACHMENT_PART_TOKENS = 2_048;

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
  /** Context limit: the model's built-in capacity, possibly lowered manually. */
  effectiveLimit: number | null;
  /** Where the limit comes from: the model's metadata (models.dev), a manual
   *  cap, the documented fallback (no metadata and no cap), or null when even
   *  the fallback is disabled. */
  limitSource: 'model' | 'manual' | 'fallback' | null;
}

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

function turnTokens(turn: Turn): number {
  if (typeof turn.content === 'string') return estimateTokens(turn.content);
  return 0;
}

/**
 * Price ONE reconstructed wire message into the user-facing buckets:
 *  - `tools`   — native tool calls and tool results (the "Tool definitions"
 *                row: the calls the model made and the output they returned),
 *  - `messages`— everything conversational: user input, assistant output and
 *                the reasoning hints that ride the wire.
 * Every token of the wire lands in exactly one bucket, and the structural
 * frame cost is included — the sum can never "lose" tokens.
 */
export function priceWireMessage(message: ChatMessage): { tools: number; messages: number } {
  let tools = 0;
  let messages = MESSAGE_FRAME_TOKENS;
  const content = message.content;
  if (typeof content === 'string') {
    const priced = estimateTokens(content);
    if (message.role === 'tool') tools += priced;
    else messages += priced;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') {
        const priced = estimateTokens(part.text);
        if (message.role === 'tool') tools += priced;
        else messages += priced;
      } else if (message.role === 'tool') {
        tools += TOOL_IMAGE_TOKENS;
      } else {
        messages += ATTACHMENT_PART_TOKENS;
      }
    }
  }
  for (const call of message.tool_calls ?? []) {
    tools += TOOL_CALL_FRAME_TOKENS + estimateTokens(`${call.function.name}${call.function.arguments}`);
  }
  return { tools, messages };
}

/** The three user-facing occupancy buckets plus their exact sum. */
export interface ContextEstimate {
  /** Sidebar System Prompt + every harness system-prompt injection. */
  systemTokens: number;
  /** Native tool defs JSON + tool calls made + tool outputs on the wire. */
  toolsTokens: number;
  /** User input + model output + reasoning riding the wire. */
  messagesTokens: number;
  /** Exact sum of the three buckets — nothing unaccounted. */
  totalTokens: number;
}

/**
 * Measure the conversation's ACTIVE context the way the next request will
 * carry it: the composed system message (user prompt + harness injections),
 * the tool defs the server reported riding the request, and the reconstructed
 * wire from `contextPlan` — the SAME builder the send path uses, so the
 * measurement and the payload can never disagree.
 */
export function estimateConversationContext(
  conversation: Conversation,
  opts?: WireOptions,
): ContextEstimate {
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
  let messages = 0;
  for (const message of contextPlan(conversation, opts).messages) {
    const priced = priceWireMessage(message);
    tools += priced.tools;
    messages += priced.messages;
  }
  return { systemTokens, toolsTokens: tools, messagesTokens: messages, totalTokens: systemTokens + tools + messages };
}

/** Context statistics for the composer chip. */
export function contextStats(
  conversation: Conversation,
  modelMeta: ModelMeta | undefined,
): ContextStats {
  const { limit, source } = effectiveContextLimit(conversation.settings, modelMeta);

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
 * The ACTIVE context limit. The model's built-in capacity (models.dev) is
 * the MAXIMUM — pick a 1M-context model and the ceiling is 1M, pick 256K
 * and it is 256K. A manual "lower context limit" can only SHRINK the
 * ceiling (cost control), never exceed what the model actually accepts.
 */
export function effectiveContextLimit(
  settings: ChatSettings,
  modelMeta: ModelMeta | undefined,
): { limit: number | null; source: 'model' | 'manual' | 'fallback' | null } {
  const model = modelMeta?.context ?? null;
  const user = settings.maxContextTokens ?? null;
  if (model && user && user < model) return { limit: user, source: 'manual' };
  if (model) return { limit: model, source: 'model' };
  if (user) return { limit: user, source: 'manual' };
  return { limit: FALLBACK_CONTEXT_LIMIT, source: 'fallback' };
}

export interface ContextBreakdown extends ContextStats {
  /** Sidebar System Prompt + every harness system-prompt injection. */
  systemTokens: number;
  /** Native tool defs + tool calls made + tool outputs riding the wire. */
  toolsTokens: number;
  /** User input + model output + reasoning riding the wire. */
  messagesTokens: number;
  /**
   * Of `messagesTokens`: the reasoning blocks riding the wire — the SAME
   * figure the trim button offers to remove, from one shared definition, so
   * the popover and the button can never disagree.
   */
  reasoningTokens: number;
  /** Of `messagesTokens`: everything else — user input, model prose, framing. */
  outputTokens: number;
}

/**
 * Breakdown of the ACTIVE context into System prompt / Tool definitions /
 * Messages — the DeepSeek-web-style usage popover, measured from the
 * reconstructed wire (see `estimateConversationContext`):
 *  - System prompt   = the sidebar System Prompt + every harness injection,
 *  - Tool definitions = the native tool defs + the tool calls made and the
 *    tool outputs that ride the wire,
 *  - Messages        = user input + model output + reasoning on the wire,
 *    itself split into Output and Reasoning — the row that usually carries
 *    the surprise should say what is inside it.
 * The three rows always sum exactly to `activeTokens` — no remainder bucket,
 * no unaccounted tokens, and the headline can never disagree with the rows.
 * The two sub-rows sum exactly to Messages by construction: Reasoning is
 * measured, Output is the remainder.
 */
export function contextBreakdown(
  conversation: Conversation,
  modelMeta: ModelMeta | undefined,
): ContextBreakdown {
  const stats = contextStats(conversation, modelMeta);
  const estimate = estimateConversationContext(conversation);
  const reasoningTokens = reasoningFootprint(conversation).tokens;
  return {
    ...stats,
    systemTokens: estimate.systemTokens,
    toolsTokens: estimate.toolsTokens,
    messagesTokens: estimate.messagesTokens,
    reasoningTokens,
    outputTokens: Math.max(0, estimate.messagesTokens - reasoningTokens),
  };
}


/**
 * Turns (counted from the END of the thread) whose tool calls ride with a
 * RESULT DIGEST — a bounded slice of the real tool output the model saw
 * in-run. Older turns degrade to a one-line placeholder, so the rebuilt wire
 * never re-bloats, but the model keeps its recent working results instead of
 * losing them to `[tool x — done]` stubs (the mid-task context collapse).
 *
 * EXEMPT: failed tools (see wireToolSegment) always ride with their digest —
 * the error text is the only evidence of what went wrong, and dropping it is
 * exactly the post-error amnesia this family of bugs is about.
 */
export const TOOL_DIGEST_TURNS = 6;
/**
 * Per-tool digest budget (chars). The server prunes every stored result to
 * head 4096 + marker + tail 1024 (≈5.2k chars) at the source, so a digest
 * inside the window carries the FULL result the model saw — no hidden second
 * truncation between "stored" and "sent". This cap only guards legacy turns
 * persisted before server-side pruning existed.
 */
export const TOOL_DIGEST_CHARS = 5_200;
/** Args echo budget (chars), for both digests and one-liners. */
export const TOOL_ARGS_CHARS = 160;
/**
 * How many of the NEWEST tool-result images ride the rebuilt wire inline.
 * An image part is worth roughly a thousand words of context; beyond this
 * budget older results degrade to a text pointer (call read_file again),
 * keeping the estimate honest without rereading every screenshot.
 */
export const TOOL_IMAGE_KEEP = 4;
/** Fixed token estimate charged per inline image part on the wire. */
export const TOOL_IMAGE_TOKENS = 2_048;

/**
 * MODEL-FREE PRE-PASS (DSH compaction-tool-result-pruner): the budgets a
 * PRUNED wire uses instead of the digest defaults above. Trimming oversized
 * tool results costs no model call and can, on its own, bring the context
 * back under the trigger — then no summary is needed at all.
 */
export const PRUNE_DIGEST_CHARS = 1_200;
/** Turns whose digests survive on a pruned wire (vs TOOL_DIGEST_TURNS). */
export const PRUNE_DIGEST_TURNS = 2;

/** Per-message wire variations. */
export interface WireOptions {
  /** PRE-PASS: tighter tool digests (PRUNE_DIGEST_*). */
  prune?: boolean;
  /** IMAGE OFFLOAD: image pixels become read_file placeholders. */
  offloadImages?: boolean;
}

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
 * A bounded tool-result digest. Normal wires cap at TOOL_DIGEST_CHARS (a
 * legacy guard — the server already prunes at the source); a PRUNED wire
 * (pre-pass) cuts to head + marker + tail, the DSH pruner shape, keeping the
 * start of the output and what the tool was doing when it ended.
 */
function boundedDigest(summary: string, opts?: WireOptions): string {
  const budget = opts?.prune ? PRUNE_DIGEST_CHARS : TOOL_DIGEST_CHARS;
  if (summary.length <= budget) return summary;
  if (!opts?.prune) return `${summary.slice(0, budget)}…`;
  const head = Math.floor(budget * 0.7);
  const tail = Math.floor(budget * 0.2);
  return `${summary.slice(0, head)}\n[… tool result middle pruned …]\n${summary.slice(summary.length - tail)}`;
}

function wireToolSegment(
  segment: { toolName: string; args?: string; summary?: string; ok?: boolean },
  withDigest: boolean,
  opts?: WireOptions,
): string {
  const args = shortArgs(segment.args);
  const header = `[tool ${segment.toolName}${args ? ` ${args}` : ''} — ${toolSegmentState(segment)}]`;
  const alwaysDigest = !!(segment.ok === false && segment.summary?.trim());
  if (!withDigest && !alwaysDigest) return header;
  const summary = segment.summary?.trim() ?? '';
  if (!summary) return header;
  return `${header}\n${boundedDigest(summary, opts)}`;
}

/**
 * The wire text for one stored turn. Prose turns ride verbatim; tool-bearing
 * turns ride their SEGMENTS — the ordered text/tool/reasoning blocks — with
 * result digests for recent turns and one-liners for old.
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
export function wireTurnText(
  turn: Pick<Turn, 'content' | 'reasoning' | 'segments'>,
  withDigest: boolean,
  opts?: WireOptions,
): string {
  if (turn.segments?.length) {
    const parts: string[] = [];
    const hasReasoningSegments = turn.segments.some(
      (segment) => segment.type === 'reasoning' && segment.text.trim(),
    );
    if (!hasReasoningSegments && turn.reasoning?.trim()) {
      parts.push(`<thinking>${turn.reasoning.trim()}</thinking>`);
    }
    for (const segment of turn.segments) {
      if (segment.type === 'text' && segment.text.trim()) {
        parts.push(segment.text);
      } else if (segment.type === 'reasoning' && segment.text.trim()) {
        parts.push(`<thinking>${segment.text.trim()}</thinking>`);
      } else if (segment.type === 'steer') {
        if (segment.text.trim()) parts.push(`User (steered mid-run): ${segment.text.trim()}`);
      } else if (segment.type === 'tool') {
        parts.push(wireToolSegment(segment, withDigest, opts));
      }
    }
    if (parts.length) return parts.join('\n');
  }
  const reasoning = turn.reasoning?.trim();
  if (reasoning) {
    return `<thinking>${reasoning}</thinking>\n${turn.content}`;
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
  withDigest: boolean,
  opts?: WireOptions,
): ChatMessage[] {
  const segments = turn.segments;
  if (!segments || segments.length === 0) {
    return [{ role: 'assistant', content: wireTurnText(turn, withDigest, opts) }];
  }

  const messages: ChatMessage[] = [];
  let pendingText = '';
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
      if (pendingText.trim()) messages.push({ role: 'assistant', content: pendingText });
      pendingText = '';
      return;
    }
    const native = pendingCalls.every((call) => call.id && call.result !== undefined);
    if (!native) {
      const parts: string[] = [];
      if (pendingText.trim()) parts.push(pendingText.trim());
      for (const call of pendingCalls) {
        parts.push(
          wireToolSegment(
            { toolName: call.wireName, args: call.args, summary: call.result },
            withDigest,
            opts,
          ),
        );
      }
      if (parts.length) messages.push({ role: 'assistant', content: parts.join('\n') });
      pendingText = '';
      pendingCalls = [];
      return;
    }
    emittedNative = true;
    const allImages = pendingCalls.flatMap((call) => call.images ?? []);
    const imageBudget = new Set(allImages.slice(-TOOL_IMAGE_KEEP));
    messages.push({
      role: 'assistant',
      content: pendingText.trim() ? pendingText : null,
      tool_calls: pendingCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.wireName, arguments: call.args || '{}' },
      })),
    });
    for (const call of pendingCalls) {
      const keptImages = opts?.offloadImages
        ? []
        : (call.images ?? []).filter((image) => imageBudget.has(image));
      const degraded = (call.images?.length ?? 0) - keptImages.length;
      const resultText = toolResultContent(call.result ?? '', withDigest, opts);
      const text =
        degraded > 0
          ? `${resultText}\n\n[${degraded} inline image(s) from this read_file result were left out of the wire (budget/offload) — call read_file { path } again to see them.]`
          : resultText;
      messages.push({
        role: 'tool',
        content: keptImages.length
          ? [
              { type: 'text', text },
              ...keptImages.map((image) => ({
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
      pendingText += segment.text;
    } else if (segment.type === 'reasoning') {
      if (segment.text.trim()) {
        pendingText += `<thinking>${segment.text.trim()}</thinking>\n`;
      }
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
        pendingText += `${wireToolSegment(segment, withDigest)}\n`;
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
    const flat = wireTurnText(turn, withDigest, opts);
    return [{ role: 'assistant', content: flat + appendWireTurnStop(turn) }];
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
 * The content of a native `tool` message. Failed tools always ride their
 * full error text (same rule as the text path): the error is the ONLY record
 * of what went wrong, and dropping it is the post-error amnesia this family
 * of bugs is about. Successful tools keep the budgeted digest window so the
 * rebuilt context never re-bloats.
 */
function toolResultContent(summary: string, withDigest: boolean, opts?: WireOptions): string {
  if (!summary.trim()) return '(no output)';
  if (!withDigest) return '(result omitted — older turn)';
  return boundedDigest(summary, opts);
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
export function wireUserContent(
  turn: Pick<Turn, 'content' | 'attachments'>,
  opts?: WireOptions,
): ChatMessage['content'] {
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
      if (opts?.offloadImages && attachment.path) {
        parts.push({
          type: 'text',
          text: `[image: ${attachment.name} — offloaded from context to save tokens; call read_file { ${attachment.path} } to view it]`,
        });
        continue;
      }
      const url = attachment.dataRef
        ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
        : attachment.dataUrl;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
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
  opts?: WireOptions,
): ChatMessage['content'] {
  if (entry.parts && entry.parts.length > 0) {
    const parts: MessageContentPart[] = [];
    for (const part of entry.parts) {
      if (part.type === 'text') {
        if (part.text) parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        if (opts?.offloadImages) {
          parts.push({
            type: 'text',
            text: '[image: steered mid-run — offloaded from context to save tokens; ask the user to resend it if you need to see it]',
          });
        } else {
          parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        }
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

export function contextPlan(conversation: Conversation, opts?: WireOptions): ContextPlan {
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
    const fromEnd = turns.length - 1 - index;
    const withDigest = fromEnd < (opts?.prune ? PRUNE_DIGEST_TURNS : TOOL_DIGEST_TURNS);
    const offloadImages = opts?.prune
      ? fromEnd >= 1
      : (conversation.settings.imageOffload !== false) && fromEnd >= IMAGE_OFFLOAD_RECENT_TURNS;
    const wireOpts: WireOptions = { prune: opts?.prune, offloadImages };

    if (turn.kind === 'probation') continue;

    if (turn.role === 'user') {
      const next = turns[index + 1];
      const steerEntries = (next && next.role === 'user' ? (next.steers ?? []) : []).filter(
        (entry) => entry.parts?.length || entry.text.trim(),
      );
      if (steerEntries.length > 0) {
        for (const entry of steerEntries) {
          messages.push({ role: 'user', content: steerPartsToContent(entry, wireOpts) });
          tags.push(turn.id);
        }
        index += 1;
        continue;
      }
      messages.push({ role: 'user', content: wireUserContent(turn, wireOpts) });
      tags.push(turn.id);
      continue;
    }
    for (const message of wireMessages(turn, withDigest, wireOpts)) {
      messages.push(message);
      tags.push(turn.id);
    }
    const assistantSteers = (turn.steers ?? []).filter(
      (entry) => entry.parts?.length || entry.text.trim(),
    );
    if (assistantSteers.length > 0) {
      for (const entry of assistantSteers) {
        messages.push({ role: 'user', content: steerPartsToContent(entry, wireOpts) });
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
 * Should the NEXT send auto-compact first?
 *
 * The measurement is the reconstructed wire (the same `contextPlan` the send
 * path builds) plus the not-yet-stored incoming message — what the next
 * request WOULD carry. Never a provider sample, so the trigger and the
 * displayed occupancy can never disagree.
 *
 * - `threshold`: the user's explicit token threshold is reached.
 * - `context-limit`: the estimate reaches 95% of the effective limit —
 *   the limit being whichever is tighter, the model's built-in context
 *   (models.dev) or the user's Lower Context Limit setting.
 *
 * `incomingTokens` is the size of the user's new message that has not been
 * appended to the conversation yet.
 */
/**
 * The trigger for an ALREADY MEASURED occupancy — a round's real prompt-token
 * count from the provider, rather than a reconstruction. Mid-run compaction
 * needs this: the run cannot wait for the next send to notice it is over the
 * limit, and the provider's own count is the honest measurement.
 *
 * Shared with `shouldAutoCompact` so the pre-send and mid-run triggers can
 * never drift apart.
 */
export function triggerForMeasuredTokens(
  settings: ChatSettings,
  modelMeta: ModelMeta | undefined,
  measuredTokens: number,
): Exclude<CompactTrigger, null | 'manual'> | null {
  if (!settings.autoCompact) return null;
  if (!Number.isFinite(measuredTokens) || measuredTokens <= 0) return null;

  const threshold = settings.compactThresholdTokens ?? null;
  if (threshold && measuredTokens >= threshold) return 'threshold';

  const { limit } = effectiveContextLimit(settings, modelMeta);
  const ratio = Math.min(0.98, Math.max(0.5, settings.compactThresholdRatio ?? LIMIT_TRIGGER_RATIO));
  if (limit && measuredTokens >= limit * ratio) return 'context-limit';

  return null;
}

export function shouldAutoCompact(
  conversation: Conversation,
  modelMeta: ModelMeta | undefined,
  incomingTokens: number,
  prune = false,
): Exclude<CompactTrigger, null | 'manual'> | null {
  const settings = conversation.settings;
  if (!settings.autoCompact) return null;

  const estimate =
    estimateConversationContext(conversation, { prune }).totalTokens + incomingTokens;
  return triggerForMeasuredTokens(settings, modelMeta, estimate);
}

/**
 * MODEL-FREE PRE-PASS relief check (DSH tool-result-pruner semantics): would
 * a PRUNED wire (tighter digests, images offloaded) sit under BOTH triggers?
 * When yes, no summarizer call is needed at all — the reduced wire alone
 * carries the conversation.
 */
export function pruneRelieves(
  conversation: Conversation,
  modelMeta: ModelMeta | undefined,
  incomingTokens: number,
): boolean {
  const pruned =
    estimateConversationContext(conversation, { prune: true }).totalTokens + incomingTokens;
  return triggerForMeasuredTokens(conversation.settings, modelMeta, pruned) === null;
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
  // Every eligible turn is summarized — no verbatim tail is kept.
  let covered = conversation.turns.filter(
    (turn) =>
      (turn.role === 'user' || turn.role === 'assistant') &&
      turn.kind !== 'compaction' &&
      turn.kind !== 'probation' &&
      turn.kind !== 'restore',
  );
  if (covered.length === 0) return null;

  const render = (turn: Turn): string => {
    const body = wireTurnText(turn, true);
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
