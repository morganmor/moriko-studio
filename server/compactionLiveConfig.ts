/**
 * LIVE COMPACTION CONFIG — the running tool loop reads THIS, not the request
 * snapshot. The user can flip Auto-compact, set a token threshold, change the
 * ratio, or lower the context limit while a run streams; POST
 * `/api/compaction/config` lands the new values here and the guard's next
 * round evaluates them (see `createLoopGuard` in server/mcp/loop.ts).
 *
 * Indexed per conversation id. A conversation absent from the map simply keeps
 * the snapshot its request started with — the registry OVERRIDES
 * field-by-field, never replaces wholesale, so a partial push cannot zero out
 * values the client did not send.
 */

export interface LiveCompactionConfig {
  autoCompact: boolean;
  /** Absolute token trigger; wins over the ratio when set (> 0). */
  compactThresholdTokens: number | null;
  /** Ratio of the effective window (client clamps to 0.5–0.98). */
  compactThresholdRatio: number | null;
  /** The user's "Lower context limit" — lowers the effective window when set. */
  maxContextTokens: number | null;
}

const configs = new Map<string, LiveCompactionConfig>();

/** Hard cap so abandoned conversations cannot grow the map without bound. */
const MAX_ENTRIES = 512;

export function setLiveCompactionConfig(
  conversationId: string,
  config: LiveCompactionConfig,
): void {
  if (configs.size >= MAX_ENTRIES && !configs.has(conversationId)) {
    const oldest = configs.keys().next().value;
    if (typeof oldest === 'string') configs.delete(oldest);
  }
  configs.set(conversationId, { ...config });
}

export function getLiveCompactionConfig(
  conversationId: string | undefined | null,
): LiveCompactionConfig | undefined {
  if (!conversationId) return undefined;
  return configs.get(conversationId);
}

/**
 * The chat route clears the entry when a NEW run starts: the request body's
 * settings snapshot is then the fresh authority, and only a mid-run change
 * re-populates the registry.
 */
export function clearLiveCompactionConfig(conversationId: string): void {
  configs.delete(conversationId);
}
