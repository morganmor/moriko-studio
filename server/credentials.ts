

import { findBuiltIn } from './providers.js';
import { ProviderStore } from './store.js';
import type { ProviderKind } from './contracts.js';

export interface ResolvedCredentials {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
}

export async function resolveCredentials(
  store: ProviderStore,
  providerId: string,
  browserKey?: string,
): Promise<ResolvedCredentials> {
  const builtIn = findBuiltIn(providerId);

  if (builtIn) {
    const envKey = builtIn.envKey ? process.env[builtIn.envKey] : undefined;
    const envBaseUrl = builtIn.envBaseUrl ? process.env[builtIn.envBaseUrl] : undefined;
    const stored = await store.getKey(providerId);
    const apiKey = envKey || stored?.apiKey || browserKey || undefined;
    const baseUrl = envBaseUrl || stored?.baseUrl || builtIn.baseUrl;

    if (!apiKey && !builtIn.keyOptional) {
      throw new Error(
        `No API key configured for ${builtIn.label}. Add ${builtIn.envKey ?? 'an env key'} to your .env file, or paste a key in the provider panel.`,
      );
    }

    return { label: builtIn.label, kind: builtIn.kind, baseUrl, apiKey };
  }

  const custom = await store.get(providerId);
  if (!custom) throw new Error(`Unknown provider "${providerId}".`);

  const stored = await store.getKey(providerId);
  return {
    label: custom.label,
    kind: custom.kind,
    baseUrl: stored?.baseUrl || custom.baseUrl,
    apiKey: stored?.apiKey || browserKey || undefined,
  };
}
