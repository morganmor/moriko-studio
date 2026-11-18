


export const CHARS_PER_TOKEN = 4;

export const MESSAGE_FRAME_TOKENS = 4;

export const TOOL_CALL_FRAME_TOKENS = 4;

export const ATTACHMENT_PART_TOKENS = 2_048;

export const TOOL_IMAGE_TOKENS = 2_048;

export const FRAME_CHAR_WEIGHT = MESSAGE_FRAME_TOKENS * CHARS_PER_TOKEN;

export const CALL_FRAME_CHAR_WEIGHT = TOOL_CALL_FRAME_TOKENS * CHARS_PER_TOKEN;

export const ATTACHMENT_CHAR_WEIGHT = ATTACHMENT_PART_TOKENS * CHARS_PER_TOKEN;

export const TOOL_IMAGE_CHAR_WEIGHT = TOOL_IMAGE_TOKENS * CHARS_PER_TOKEN;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}


export interface PriceMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  reasoning_content?: string | null;
}


export interface FrameBuckets {
  tools: number;
  input: number;
  output: number;
  reasoning: number;
}

function measureContentWeight(
  content: PriceMessage['content'],
  role: PriceMessage['role'],
): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') {
      total += (part.text ?? '').length;
    } else {
      total += role === 'tool' ? TOOL_IMAGE_CHAR_WEIGHT : ATTACHMENT_CHAR_WEIGHT;
    }
  }
  return total;
}

/**
 * Measures structural char-equivalent weights per message in a single uniform unit
 * strictly matching Moriko Studio's 5-bucket domain rules:
 * - role='tool' -> tools
 * - role='user' -> input
 * - role='assistant' text -> output; tool_calls -> tools; reasoning_content -> reasoning (only when included)
 */
export function measureMessageWeights(
  message: PriceMessage,
  options?: { includeReasoning?: boolean },
): FrameBuckets {
  const buckets: FrameBuckets = { tools: 0, input: 0, output: 0, reasoning: 0 };
  const body = message.role === 'tool' ? 'tools' : message.role === 'user' ? 'input' : 'output';
  const bodyWeight = FRAME_CHAR_WEIGHT + measureContentWeight(message.content, message.role);
  buckets[body] += bodyWeight;
  for (const call of message.tool_calls ?? []) {
    buckets.tools +=
      CALL_FRAME_CHAR_WEIGHT +
      (call.function.name?.length ?? 0) +
      (call.function.arguments?.length ?? 0);
  }
  if (options?.includeReasoning !== false && message.reasoning_content) {
    buckets.reasoning += message.reasoning_content.length;
  }
  return buckets;
}

/**
 * Exact integer Hamilton (Largest-Remainder) apportionment whose sum equals `Math.max(0, Math.round(budget))`
 * with zero rounding drift and non-zero preservation for active buckets when budget permits.
 */
export function apportionBuckets<K extends string>(
  budget: number,
  weights: Record<K, number>,
  fallbackKey?: NoInfer<K>,
): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;

  const target = Math.max(0, Math.round(budget));
  if (target === 0) return out;

  const active = keys.filter((key) => Number.isFinite(weights[key]) && weights[key] > 0);
  if (active.length === 0) {
    if (fallbackKey && fallbackKey in out) out[fallbackKey] = target;
    return out;
  }

  let totalWeight = 0;
  for (const key of active) totalWeight += weights[key];

  const remainders: Array<{ key: K; rem: number; weight: number }> = [];
  let allocated = 0;
  for (const key of active) {
    const exact = (target * weights[key]) / totalWeight;
    const floor = Math.floor(exact);
    out[key] = floor;
    allocated += floor;
    remainders.push({ key, rem: exact - floor, weight: weights[key] });
  }

  let leftover = target - allocated;
  remainders.sort((a, b) => (b.rem !== a.rem ? b.rem - a.rem : b.weight - a.weight));
  for (let i = 0; i < remainders.length && leftover > 0; i += 1) {
    out[remainders[i].key] += 1;
    leftover -= 1;
  }

  // Ensure no active (non-empty) bucket rounds down to 0 when total budget >= active bucket count.
  if (target >= active.length) {
    for (const key of active) {
      if (out[key] > 0) continue;
      let donor: K | null = null;
      let maxVal = 1;
      for (const candidate of active) {
        if (out[candidate] > maxVal) {
          maxVal = out[candidate];
          donor = candidate;
        }
      }
      if (!donor) break;
      out[donor] -= 1;
      out[key] = 1;
    }
  }

  return out;
}


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


export interface BucketTotals extends FrameBuckets {
  system: number;
  total: number;
}

export function sumTotals(totals: BucketTotals): number {
  return sumBuckets(totals) + totals.system;
}

