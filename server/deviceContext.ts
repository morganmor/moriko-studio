import os from 'node:os';

import type { ChatMessage } from './contracts.js';

/**
 * DEVICE CONTEXT — tells the model the local date, time, timezone and
 * platform of the machine the user is actually running on (the local proxy
 * IS that machine).
 *
 * The block rides on the NEWEST USER MESSAGE instead of the system prompt:
 * the system prompt must stay byte-identical across turns so the provider's
 * prompt cache (harness blocks are tens of KB) stays valid, while the newest
 * user message is new bytes anyway.
 */
export function deviceContextBlock(): string {
  const now = new Date();
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local';
  return [
    '[Device context — the machine this conversation runs on. The local date/time below is CURRENT.]',
    `Date: ${now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
    `Time: ${now.toLocaleTimeString('id-ID')} (${offset}, ${timezone})`,
    `Platform: ${os.type()} ${os.release()} ${os.arch()}`,
    '[/Device context]',
  ].join('\n');
}

/** Appends the device-context block to the newest user message. */
export function appendDeviceContext(messages: ChatMessage[]): ChatMessage[] {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      index = i;
      break;
    }
  }
  if (index < 0) return messages;

  const last = messages[index];
  const suffix = `\n\n${deviceContextBlock()}`;
  const augmented: ChatMessage = {
    ...last,
    content: typeof last.content === 'string'
      ? last.content + suffix
      : [...(last.content ?? []), { type: 'text', text: suffix }],
  };
  return [...messages.slice(0, index), augmented, ...messages.slice(index + 1)];
}
