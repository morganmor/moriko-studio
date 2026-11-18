
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