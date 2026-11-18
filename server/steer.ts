


export type SteerPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface SteerEntry {
  id: string;
  
  parts: SteerPart[];
  
  at: number;
}


const steerBuffer = new Map<string, SteerEntry[]>();


const activeSessions = new Set<string>();

export function pushSteer(sessionId: string, parts: SteerPart[]): SteerEntry {
  const entry: SteerEntry = { id: `steer-${Math.random().toString(36).slice(2, 10)}`, parts, at: Date.now() };
  const existing = steerBuffer.get(sessionId) ?? [];
  existing.push(entry);
  steerBuffer.set(sessionId, existing);
  return entry;
}


export function takeSteers(sessionId: string): SteerEntry[] {
  const entries = steerBuffer.get(sessionId);
  if (!entries || entries.length === 0) return [];
  steerBuffer.delete(sessionId);
  return entries;
}

export function pendingSteerCount(sessionId: string): number {
  return steerBuffer.get(sessionId)?.length ?? 0;
}

export function registerSteerSession(sessionId: string): void {
  activeSessions.add(sessionId);
}

export function unregisterSteerSession(sessionId: string): void {
  activeSessions.delete(sessionId);
  steerBuffer.delete(sessionId);
}

export function isSteerable(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}


export function drainSteers(sessionId: string | undefined): SteerEntry[] {
  if (!sessionId) return [];
  return takeSteers(sessionId);
}


export function steersToUserParts(
  entries: SteerEntry[],
): Array<NonNullable<Exclude<import('./contracts.js').ChatMessage['content'], string | null>>[number]> {
  const parts: Array<NonNullable<Exclude<import('./contracts.js').ChatMessage['content'], string | null>>[number]> = [];
  for (const entry of entries) {
    for (const part of entry.parts) {
      parts.push(part);
    }
  }
  return parts;
}


export function steerTextOf(entry: SteerEntry): string {
  const lines: string[] = [];
  for (const part of entry.parts) {
    if (part.type === 'text') lines.push(part.text);
    else if (part.type === 'image_url') lines.push('[image attached]');
    else if (part.type === 'video_url') lines.push('[video attached]');
    else lines.push(`[file attached: ${part.file.filename}]`);
  }
  return lines.filter((line) => line.trim().length > 0).join('\n\n');
}
