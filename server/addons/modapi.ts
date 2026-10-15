/**
 * Mod-to-mod API (Addon v2, A4) — `$.api.expose(name, impl)` / `$.api.use(id)`.
 * Minimal name-scoped registry; disposal is automatic with the addon scope.
 */

const exposed = new Map<string, { addonId: string; name: string; impl: object }>(); // key owner\0name

export function exposeModApi(addonId: string, name: string, impl: object): () => void {
  const key = `${addonId}\u0000${name}`;
  exposed.set(key, { addonId, name, impl });
  return () => exposed.delete(key);
}

export function useModApi(ownerAddonId: string): object | null {
  for (const entry of exposed.values()) {
    if (entry.addonId === ownerAddonId) return entry.impl;
  }
  return null;
}

export function clearModApi(addonId: string): void {
  for (const key of [...exposed.keys()]) {
    if (key.startsWith(`${addonId}\u0000`)) exposed.delete(key);
  }
}
