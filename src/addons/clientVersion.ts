/**
 * Addon client module version — cache-buster for lazy addon imports.
 *
 * The browser's module map caches a dynamic import() by URL forever, so after
 * an addon reload/edit the old component would keep rendering until a full
 * page refresh. Bumping this counter on every registry change gives the next
 * lazy import a fresh `?v=` query (the server strips it before resolving).
 */
let clientModuleVersion = 0;

export function bumpAddonClientVersion(): void {
  clientModuleVersion++;
}

export function addonClientVersion(): number {
  return clientModuleVersion;
}
