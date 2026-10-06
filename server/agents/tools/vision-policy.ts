/**
 * Per-session vision-policy tracker (in-memory only).
 *
 * The strict rule: a model with NATIVE image input (models.dev `imageIn`) may
 * not delegate to agent__vision until it has called read_file on an image
 * itself this session — read_file now returns the image inline, so delegating
 * before a read means the model never even tried its own eyes. Text-only models
 * are untouched: agent__vision stays their only sight. In-memory only: a
 * restart merely re-arms the guard after the first read.
 */

const visionPolicy = new Map<string, { readImages: Set<string>; visionCalls: number }>();
/** Backstop so a long-lived server cannot grow the map without bound. */
const VISION_POLICY_MAX_SESSIONS = 500;

export function visionPolicyFor(session: string | undefined): { readImages: Set<string>; visionCalls: number } | null {
  if (!session) return null;
  return visionPolicy.get(session) ?? null;
}

export function noteImageRead(session: string | undefined, absolute: string): void {
  if (!session) return;
  if (!visionPolicy.has(session) && visionPolicy.size >= VISION_POLICY_MAX_SESSIONS) {
    const oldest = visionPolicy.keys().next().value;
    if (oldest !== undefined) visionPolicy.delete(oldest);
  }
  const entry = visionPolicy.get(session) ?? { readImages: new Set<string>(), visionCalls: 0 };
  entry.readImages.add(absolute);
  visionPolicy.set(session, entry);
}

export function noteVisionCall(session: string | undefined): void {
  if (!session) return;
  const entry = visionPolicy.get(session) ?? { readImages: new Set<string>(), visionCalls: 0 };
  entry.visionCalls += 1;
  visionPolicy.set(session, entry);
}
