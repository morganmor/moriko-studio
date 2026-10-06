/**
 * Shared text coercion for provider streams.
 *
 * Providers disagree on the shape of streamed content: plain strings are the
 * norm, but array-of-parts content, single part objects, or even nested
 * attribute-style payloads show up in the wild. Implicit stringification of
 * an object produces "[object Object]", which then sprays the UI transcript
 * as garbage and RE-ENTERS the model's context as noise on the next request
 * (the self-poisoning loop). Every adapter must push its text deltas and
 * error messages through this before accumulating or forwarding them.
 */
export function coerceText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      const nested = coerceText(part);
      if (nested !== null && nested !== '') parts.push(nested);
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fromText = coerceText(record.text);
    if (fromText) return fromText;
    const fromContent = coerceText(record.content);
    if (fromContent) return fromContent;
  }
  return null;
}