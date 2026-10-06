/**
 * Handling for reasoning models that inline their thinking in the content
 * stream as tags (`<think>…</think>`, `<thought>…</thought>`,
 * `<thinking>…</thinking>`) — minimax, QwQ, DeepSeek-R1 distills, and many
 * OpenAI-compatible relays do this instead of emitting a separate
 * `reasoning_content` channel.
 */

const OPEN_RE = /<(think|thought|thinking)>([\s\S]*?)<\/\1>/gi;
const UNCLOSED_RE = /<(think|thought|thinking)>([\s\S]*)$/i;
/** Loose close (any name) — mirrors the server's THINK_CLOSE. */
const CLOSE_RE = /^([\s\S]*?)<\/(?:think|thought|thinking)>/i;
/** Lone boundary tags (stray closes, unbalanced pairs): noise, never prose. */
const ANY_TAG_RE = /<\/?(?:think|thought|thinking)>/gi;

export interface SplitThinking {
  content: string;
  reasoning: string;
}

/** Moves tag-wrapped reasoning out of a reply into a separate channel. */
export function splitInlineThinking(content: string): SplitThinking {
  const reasoningParts: string[] = [];
  let rest = content.replace(OPEN_RE, (_match, _tag: string, inner: string) => {
    if (inner.trim()) reasoningParts.push(inner.trim());
    return '';
  });

  const unclosed = rest.match(UNCLOSED_RE);
  if (unclosed?.index !== undefined) {
    const tail = unclosed[2];
    const closed = tail.match(CLOSE_RE);
    if (closed) {
      if (closed[1].trim()) reasoningParts.push(closed[1].trim());
      rest = rest.slice(0, unclosed.index) + tail.slice(closed[0].length);
    } else {
      if (tail.trim()) reasoningParts.push(tail.trim());
      rest = rest.slice(0, unclosed.index);
    }
  }

  rest = rest.replace(ANY_TAG_RE, '');

  return {
    content: rest.trim(),
    reasoning: reasoningParts.join('\n\n').trim(),
  };
}

/** Strips reasoning tags entirely — for titles, previews, and prompts. */
export function stripInlineThinking(text: string): string {
  return splitInlineThinking(text).content;
}
