/**
 * THE ONE TOKEN ESTIMATOR — imported by BOTH the client (src/) and the server
 * (server/), so both sides price the same wire with the same arithmetic and
 * can never drift apart. The client prices the stored conversation; the server
 * prices the exact request it receives, seeds the buckets, then adds every
 * streamed delta — that is the shared, per-second figure.
 *
 * BUCKETS (the user's specification):
 *   system    — sidebar system prompt + harness injections (priced separately)
 *   tools     — native tool defs + tool calls made + tool outputs
 *   input     — user messages (text, file pointers, attachment frames)
 *   output    — assistant prose
 *   reasoning — assistant chain-of-thought riding `reasoning_content`
 *
 * NOTHING MAY SHRINK OUTSIDE COMPACTION: tool results and images always ride
 * exactly as stored. The buckets only grow while a run streams, except when
 * the user trims reasoning or a compaction checkpoint replaces history.
 */

/** Chars per token for the estimator (no real tokenizer on either side). */
export const CHARS_PER_TOKEN = 4;
/** Structural wire overhead per message frame (role, delimiters, JSON keys). */
export const MESSAGE_FRAME_TOKENS = 4;
/** Structural overhead per native tool-call entry. */
export const TOOL_CALL_FRAME_TOKENS = 4;
/** Fixed price for a binary attachment part (image/file) — not char-countable. */
export const ATTACHMENT_PART_TOKENS = 2_048;
/** Fixed token estimate charged per inline image part in a tool result. */
export const TOOL_IMAGE_TOKENS = 2_048;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Minimal structural shape both the client and server message types satisfy. */
export interface PriceMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  reasoning_content?: string | null;
}

/** The four wire buckets a single message prices into. */
export interface FrameBuckets {
  tools: number;
  input: number;
  output: number;
  reasoning: number;
}

/**
 * Price ONE reconstructed wire message. Tool results and tool calls belong to
 * `tools` EXCLUSIVELY — nothing tool-shaped may leak into input/output.
 * The message frame cost is charged to the same bucket as the message body.
 */
export function priceFrame(message: PriceMessage): FrameBuckets {
  const buckets: FrameBuckets = { tools: 0, input: 0, output: 0, reasoning: 0 };
  const body = message.role === 'tool' ? 'tools' : message.role === 'user' ? 'input' : 'output';
  buckets[body] += MESSAGE_FRAME_TOKENS;
  const content = message.content;
  if (typeof content === 'string') {
    buckets[body] += estimateTokens(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') {
        buckets[body] += estimateTokens(part.text ?? '');
      } else {
        buckets[body] += message.role === 'tool' ? TOOL_IMAGE_TOKENS : ATTACHMENT_PART_TOKENS;
      }
    }
  }
  for (const call of message.tool_calls ?? []) {
    buckets.tools += TOOL_CALL_FRAME_TOKENS + estimateTokens(`${call.function.name}${call.function.arguments}`);
  }
  if (message.reasoning_content) buckets.reasoning += estimateTokens(message.reasoning_content);
  return buckets;
}

export function sumBuckets(buckets: FrameBuckets): number {
  return buckets.tools + buckets.input + buckets.output + buckets.reasoning;
}

/** The five user-facing buckets, system included — one shape, one sum. */
export interface BucketTotals extends FrameBuckets {
  system: number;
  total: number;
}

export function sumTotals(totals: BucketTotals): number {
  return sumBuckets(totals) + totals.system;
}

