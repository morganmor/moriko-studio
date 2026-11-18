

export interface Disposable {
  dispose(): void;
}


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


export class Scope {
  private items: Disposable[] = [];

  
  track<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  
  add(teardown: () => void): Disposable {
    return this.track(disposable(teardown));
  }

  get size(): number {
    return this.items.length;
  }

  
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


export function disposeAddonScope(addonId: string): void {
  const scope = scopes.get(addonId);
  if (scope) {
    scope.disposeAll();
    scopes.delete(addonId);
  }
}
