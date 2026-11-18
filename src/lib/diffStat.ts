

export interface DiffStat {
  added: number;
  removed: number;
}


export function diffStat(diff: string): DiffStat | null {
  if (!diff) return null;
  const lines = diff.split('\n');
  const looksLikeDiff = lines.some((line) => line.startsWith('--- a/') || line.startsWith('+++ b/') || line.startsWith('@@'));
  if (!looksLikeDiff) return null;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}


export function diffStatLabel(diff: string | undefined): string {
  const stat = diff ? diffStat(diff) : null;
  if (!stat || (stat.added === 0 && stat.removed === 0)) return '';
  const parts: string[] = [];
  if (stat.added > 0) parts.push(`+${stat.added}`);
  if (stat.removed > 0) parts.push(`-${stat.removed}`);
  return parts.join(' ');
}


function countLines(text: string | undefined): number {
  if (!text) return 0;
  const normalized = text.replace(/\r\n/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body ? body.split('\n').length : 0;
}


export function statFromEditArgs(toolName: string, args: string | undefined): DiffStat | null {
  if (!args) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const bag = parsed as Record<string, unknown>;
  const asText = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

  if (toolName === 'multi_edit' && Array.isArray(bag.edits)) {
    let added = 0;
    let removed = 0;
    for (const entry of bag.edits) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      added += countLines(asText(item.new_string));
      removed += countLines(asText(item.old_string));
    }
    return added || removed ? { added, removed } : null;
  }

  if (toolName === 'edit_lines') {
    const from = typeof bag.from === 'number' ? bag.from : null;
    const to = typeof bag.to === 'number' ? bag.to : null;
    const added = countLines(asText(bag.new_string));
    const removed = from !== null && to !== null ? Math.max(0, to - from + 1) : 0;
    return added || removed ? { added, removed } : null;
  }

  if (toolName === 'write' || toolName === 'write_file' || toolName === 'overwrite') {
    const added = countLines(asText(bag.content));
    return added ? { added, removed: 0 } : null;
  }

  const oldText = asText(bag.old_string);
  const newText = asText(bag.new_string);
  if (oldText === undefined && newText === undefined) return null;
  const added = countLines(newText);
  const removed = countLines(oldText);
  return added || removed ? { added, removed } : null;
}