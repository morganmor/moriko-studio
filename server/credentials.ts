/**
 * Credential resolution shared by the chat stream, the vision tool and any
 * other server-side path that must speak a provider's API.
 *
 * Extracted from index.ts so the agent tools can use it without a circular
 * import (index → agents/routes → agents/tools). Resolution order is
 * IDENTICAL to what the chat stream uses: .env override → a key the user
 * saved from the UI (the ~/.moriko/api-keys.json vault, custom and built-in
 * alike, each entry carrying its provider endpoint) → a browser-supplied key.
 */

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
