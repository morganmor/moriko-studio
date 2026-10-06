/**
 * STEER — inject user input into an in-flight generation (DSH-style).
 *
 * Modeled 1:1 on deepseek-harness's `agent.steer(UserMessage)`: a steer is a
 * REAL user message — plain content parts, no harness framing — queued in a
 * server-side per-conversation FIFO and consumed by the running adapter at the
 * next step boundary (between tool rounds; mid-token is impossible, SSE is
 * one-way). The drained messages ride as an ordinary `user` turn on the wire,
 * exactly like any other user input — deepseek-style: the model simply sees
 * the user spoke, it is not told it was "steered".
 *
 * Content parts mirror the client's ChatMessage parts: text plus IMAGE (and
 * file) attachments, so a steer can carry a screenshot the same way a normal
 * message does. Wire URLs use the `moriko-ref://<mime>/<hash>` pseudo-protocol
 * — POST /api/chat resolves them to real bytes (resolveWireRefs) at the
 * provider boundary, the same as regular attachment parts.
 *
 * Lifecycle: register on stream start → push on POST → drain between rounds →
 * unregister on close. Unregister always clears, so a finished conversation
 * leaves no dangling state; a stream that ends before draining drops it (the
 * reply is already complete — the note would be noise).
 */

/** Wire content part a steer carries — identical shape to the client's parts. */
export type SteerPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface SteerEntry {
  id: string;
  /** Ordered content parts: the message text plus any image/file parts. */
  parts: SteerPart[];
  /** Epoch ms — older steers drain first, in send order. */
  at: number;
}

/** Per-conversation FIFO of un-delivered steers. */
const steerBuffer = new Map<string, SteerEntry[]>();

/** Conversations whose stream is live and therefore steerable. */
const activeSessions = new Set<string>();

export function pushSteer(sessionId: string, parts: SteerPart[]): SteerEntry {
  const entry: SteerEntry = { id: `steer-${Math.random().toString(36).slice(2, 10)}`, parts, at: Date.now() };
  const existing = steerBuffer.get(sessionId) ?? [];
  existing.push(entry);
  steerBuffer.set(sessionId, existing);
  return entry;
}

/** Remove and return every pending steer for a session, oldest first. */
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

/**
 * Drains pending steers for this session and notifies the UI as each one is
 * delivered. Call it AFTER `executeCalls` finishes and BEFORE the next upstream
 * fetch — that seam is the only honest injection point (mid-token is
 * impossible: SSE is one-way). Returns the entries that were delivered.
 */
export function drainSteers(sessionId: string | undefined): SteerEntry[] {
  if (!sessionId) return [];
  return takeSteers(sessionId);
}

/**
 * Flattens drained steers into ONE generic user message — no "STEERED" framing.
 * The parts concatenate in FIFO order (each steer's parts in order), exactly
 * how deepseek's loop claims its next-step messages: plain user content, the
 * model just sees the user spoke.
 */
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

/** The text-only projection of a steer — what the `steer` stream event and the
 *  UI bubble show. Image parts surface as a bracketed attachment note, exactly
 *  like the client's own attachment echo, so the transcript stays readable. */
export function steerTextOf(entry: SteerEntry): string {
  const lines: string[] = [];
  for (const part of entry.parts) {
    if (part.type === 'text') lines.push(part.text);
    else if (part.type === 'image_url') lines.push('[image attached]');
    else lines.push(`[file attached: ${part.file.filename}]`);
  }
  return lines.filter((line) => line.trim().length > 0).join('\n\n');
}
