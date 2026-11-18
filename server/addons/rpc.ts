

export type RpcHandler = (
  body: Record<string, unknown>,
  ctx: { actor: { kind: 'user' }; sessionId?: string },
) => unknown | Promise<unknown>;

const handlers = new Map<string, RpcHandler>();

export function registerRpcHandler(addonId: string, name: string, handler: RpcHandler): () => void {
  const key = `${addonId}\u0000${name}`;
  handlers.set(key, handler);
  return () => handlers.delete(key);
}

export function getRpcHandler(addonId: string, name: string): RpcHandler | undefined {
  return handlers.get(`${addonId}\u0000${name}`);
}
