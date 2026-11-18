

const visionPolicy = new Map<string, { readImages: Set<string>; visionCalls: number }>();

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
