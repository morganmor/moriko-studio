
import { splitInlineThinking } from './reasoningLexer';

export { splitInlineThinking };


export function stripInlineThinking(text: string): string {
  return splitInlineThinking(text).content;
}
