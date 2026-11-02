/**
 * Client-side reasoning handling for models that inline their thinking in the
 * content stream as tags (`<thinking>…</thinking>`, `<thought>…</thought>`,
 * `<reasoning>…</reasoning>`) — minimax, QwQ, DeepSeek-R1 distills, and many
 * OpenAI-compatible relays do this instead of emitting a separate
 * `reasoning_content` channel.
 *
 * The parsing itself lives in `reasoningLexer.ts` and is shared with the
 * proxy: a tag the live stream treated as prose must stay prose when a
 * finished reply is re-split for titles, previews, or a recovered turn.
 */
import { splitInlineThinking } from './reasoningLexer';

export { splitInlineThinking };

/** Strips reasoning tags entirely — for titles, previews, and prompts. */
export function stripInlineThinking(text: string): string {
  return splitInlineThinking(text).content;
}
