import type { ProviderPublic } from '../types';


export function isProviderConfigured(provider: ProviderPublic | undefined): boolean {
  return Boolean(provider?.hasServerKey);
}
