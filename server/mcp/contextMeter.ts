/**
 * THE SERVER CONTEXT METER — the per-second authority over the context
 * buckets, built on the SHARED estimator (shared/contextAccounting) so client
 * and server price the identical wire with identical arithmetic.
 *
 * Seeded from the exact request the adapter is about to send (system message,
 * tool defs, the full messages array), then incremented by EVERY streamed
 * delta: text deltas into `output`, reasoning deltas into `reasoning`. The
 * tool outputs that land mid-run are priced into `tools` by the adapter via
 * `addToolChars`.
 *
 * Emission is THROTTLED to ~1 s (`maybeEmit`) so every delta does not become a
 * wire frame; `flush()` emits immediately at round boundaries. Each frame
 * carries the full five-bucket breakdown — the client stores it verbatim, and
 * the composer's cx-top is the exact sum of the buckets plus the frozen
 * provider gap.
 */
import {
  CHARS_PER_TOKEN,
  MESSAGE_FRAME_TOKENS,
  estimateTokens,
  priceFrame,
  sumTotals,
  type BucketTotals,
  type PriceMessage,
} from '../../shared/contextAccounting.js';
import type { StreamEvent } from '../contracts.js';

/** Emission throttle: at most one `context_live` frame per interval. */
const EMIT_INTERVAL_MS = 1_000;

export interface ContextMeter {
  /** Price a system segment (e.g. Anthropic's stable+volatile blocks). */
  addSystemSegments(text: string): void;
  /**
   * Move the frame cost of tool messages the ADAPTER reshapes into user-role
   * frames (Anthropic) back out of `input` — the tool bodies stay priced in
   * `tools` by the seed pass, only the frame token moves.
   */
  repriceToolMessages(count: number): void;
  /** Price the tool outputs that just landed into the `tools` bucket. */
  addToolChars(chars: number): void;
  /** Price a mid-run user frame (steer, addon injection) into `input`. */
  addInputChars(chars: number): void;
  /** Account one streamed text delta (assistant prose). */
  addOutputChars(chars: number): void;
  /** Account one streamed reasoning delta (chain-of-thought). */
  addReasoningChars(chars: number): void;
  /** Fold the round's provider usage back in, replacing the estimated tail. */
  recordUsage(usage: { promptTokens?: number; completionTokens?: number } | undefined): void;
  /** Emit a throttled `context_live` frame (drops when inside the window). */
  maybeEmit(onEvent: (event: StreamEvent) => void): void;
  /** Emit `context_live` NOW — round boundaries and run end. */
  flush(onEvent: (event: StreamEvent) => void): void;
  /** The per-second meter's snapshot — used by the compaction handoff. */
  snapshot(): BucketTotals & { liveContextTokens: number };
}

export function createContextMeter(input: {
  systemInstruction: string;
  systemSegments?: string[];
  toolDefsChars: number;
  messages: PriceMessage[];
}): ContextMeter {
  const totals: BucketTotals = { system: 0, tools: 0, input: 0, output: 0, reasoning: 0, total: 0 };

  // SYSTEM: the composed system message (user prompt + harness injections).
  totals.system += estimateTokens(input.systemInstruction);
  for (const segment of input.systemSegments ?? []) totals.system += estimateTokens(segment);

  // TOOLS: the native tool defs JSON riding this request.
  totals.tools += Math.ceil(input.toolDefsChars / CHARS_PER_TOKEN);

  // The full messages array as it will ride the request.
  for (const message of input.messages) {
    const priced = priceFrame(message);
    totals.tools += priced.tools;
    totals.input += priced.input;
    totals.output += priced.output;
    totals.reasoning += priced.reasoning;
  }
  totals.total = sumTotals(totals);

  /** In-flight delta chars awaiting their token rounding, per bucket. */
  let pendingOutputChars = 0;
  let pendingReasoningChars = 0;
  /** Tool tokens added via addToolChars since the last recordUsage — needed to
   *  separate new tool outputs (not yet in the provider's promptTokens) from
   *  the prompt-side tools the provider already counted. */
  let toolTokensSinceCalibration = 0;
  let lastEmit = 0;

  const pendingOutputTokens = (): number => Math.ceil(pendingOutputChars / CHARS_PER_TOKEN);
  const pendingReasoningTokens = (): number => Math.ceil(pendingReasoningChars / CHARS_PER_TOKEN);

  const emit = (onEvent: (event: StreamEvent) => void): void => {
    const output = pendingOutputTokens();
    const reasoning = pendingReasoningTokens();
    onEvent({
      type: 'context_live',
      systemTokens: totals.system,
      toolsTokens: totals.tools,
      inputTokens: totals.input,
      outputTokens: totals.output + output,
      reasoningTokens: totals.reasoning + reasoning,
      totalTokens: totals.total + output + reasoning,
    });
    lastEmit = Date.now();
  };

  const meter: ContextMeter = {
    addSystemSegments(text) {
      const tokens = estimateTokens(text);
      totals.system += tokens;
      totals.total += tokens;
    },
    repriceToolMessages(count) {
      const tokens = count * MESSAGE_FRAME_TOKENS;
      totals.input -= tokens;
      totals.tools += tokens;
    },
    addToolChars(chars) {
      const tokens = Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
      totals.tools += tokens;
      totals.total += tokens;
      toolTokensSinceCalibration += tokens;
    },
    addInputChars(chars) {
      const tokens = Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
      totals.input += tokens;
      totals.total += tokens;
    },
    addOutputChars(chars) {
      pendingOutputChars += Math.max(0, chars);
    },
    addReasoningChars(chars) {
      pendingReasoningChars += Math.max(0, chars);
    },
    recordUsage(usage) {
      const providerPrompt = usage?.promptTokens ?? 0;
      const providerCompletion = usage?.completionTokens ?? 0;

      if (providerPrompt > 0) {
        // 1. COMPLETION SIDE: lock Output + Reasoning to provider's real count.
        //    Split proportionally by their char ratio — NOT blind scaling of all
        //    five buckets, just reconciling two against one real number.
        const pendingOut = pendingOutputTokens();
        const pendingReas = pendingReasoningTokens();
        const pendingTotal = pendingOut + pendingReas;
        let thisRoundOutput = 0;
        let thisRoundReasoning = 0;
        if (providerCompletion > 0 && pendingTotal > 0) {
          const ratio = providerCompletion / pendingTotal;
          thisRoundOutput = Math.round(pendingOut * ratio);
          thisRoundReasoning = providerCompletion - thisRoundOutput;
        } else if (providerCompletion > 0) {
          thisRoundOutput = providerCompletion;
        }
        totals.output += thisRoundOutput;
        totals.reasoning += thisRoundReasoning;

        // 2. PROMPT SIDE: promptTokens is the absolute truth. System and Input
        //    stay at their payload-based estimates (chars/4 is accurate for
        //    plain text). Tools absorbs ALL BPE/structural deviation:
        //      promptTokens + completionTokens = system + tools(prompt-side)
        //        + input + all_output + all_reasoning
        //      tools(prompt-side) = promptTokens + completionTokens
        //        - system - input - output - reasoning
        //    New tool outputs (added via addToolChars, not yet in the prompt)
        //    are added back on top.
        const promptSideTools = providerPrompt + providerCompletion
          - totals.system - totals.input - totals.output - totals.reasoning;
        totals.tools = Math.max(0, promptSideTools) + toolTokensSinceCalibration;
        totals.total = sumTotals(totals);
      }

      pendingOutputChars = 0;
      pendingReasoningChars = 0;
      toolTokensSinceCalibration = 0;
    },
    maybeEmit(onEvent) {
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
        output: totals.output + pendingOutputTokens(),
        reasoning: totals.reasoning + pendingReasoningTokens(),
        total: totals.total + pendingOutputTokens() + pendingReasoningTokens(),
        liveContextTokens: totals.total + pendingOutputTokens() + pendingReasoningTokens(),
      };
    },
  };
  return meter;
}

export { MESSAGE_FRAME_TOKENS };
