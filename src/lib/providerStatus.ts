import type { ProviderPublic } from '../types';

/**
 * Whether a provider can actually be used right now.
 *
 * A provider is ready once its key exists — in the server environment or in
 * the device vault (`~/.moriko/api-keys.json`), which is what `hasServerKey`
 * reports. There is no browser-held key any more: the browser stores nothing,
 * so a key that is not on the device does not exist.
 *
 * Local runtimes (Ollama, LM Studio) report as configured because the server
 * marks them key-optional.
 */
export function isProviderConfigured(provider: ProviderPublic | undefined): boolean {
  return Boolean(provider?.hasServerKey);
}
