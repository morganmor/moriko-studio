

export interface LiveCompactionConfig {
  autoCompact: boolean;
  
  compactThresholdTokens: number | null;
  
  compactThresholdRatio: number | null;
  
  maxContextTokens: number | null;
}

const configs = new Map<string, LiveCompactionConfig>();


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


export function clearLiveCompactionConfig(conversationId: string): void {
  configs.delete(conversationId);
}
