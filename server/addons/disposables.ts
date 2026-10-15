/**
 * Disposables — per-addon lifetime scope (Addon v2, A1).
 *
 * Everything an addon registers (hooks, tools, bus subscriptions, timers,
 * context providers, widgets) returns a Disposable that lands in the addon's
 * scope. Deactivation = disposeAll() — no leaked listeners/timers across
 * reloads (closes audit A-08).
 */

export interface Disposable {
  dispose(): void;
}

/** Create a Disposable from a plain teardown function. */
export function disposable(teardown: () => void): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        teardown();
      } catch (error) {
        console.error('[addons] dispose error:', error);
      }
    },
  };
}

/** A tracked set of disposables owned by one addon. */
export class Scope {
  private items: Disposable[] = [];

  /** Track an externally created disposable; returns it unchanged. */
  track<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  /** Create + track a disposable from a teardown function. */
  add(teardown: () => void): Disposable {
    return this.track(disposable(teardown));
  }

  get size(): number {
    return this.items.length;
  }

  /** Dispose everything in REVERSE registration order, once. */
  disposeAll(): void {
    const items = this.items;
    this.items = [];
    for (let i = items.length - 1; i >= 0; i--) items[i].dispose();
  }
}

const scopes = new Map<string, Scope>();

export function getAddonScope(addonId: string): Scope {
  let scope = scopes.get(addonId);
  if (!scope) {
    scope = new Scope();
    scopes.set(addonId, scope);
  }
  return scope;
}

/** Dispose + forget one addon's scope (called by unregisterAddon). */
export function disposeAddonScope(addonId: string): void {
  const scope = scopes.get(addonId);
  if (scope) {
    scope.disposeAll();
    scopes.delete(addonId);
  }
}
