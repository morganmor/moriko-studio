/**
 * Addon v2 RPC (A4) — the route `POST /api/addons/:id/rpc/:name` dispatches to
 * a handler the addon registered via `ctx.rpc.handle(name, fn)`. Calls arrive
 * from the addon's UI, so the actor is always `{ kind: 'user' }` — the tool
 * surface stays agent-only, the RPC surface user-only.
 *
 * Auth: the route rides the same Express router as every other /api route —
 * whatever middleware the app mounts in front of /api applies here too.
 */

export type RpcHandler = (
  body: Record<string, unknown>,
  ctx: { actor: { kind: 'user' }; sessionId?: string },
) => unknown | Promise<unknown>;

const handlers = new Map<string, RpcHandler>(); // key: addonId\0name

export function registerRpcHandler(addonId: string, name: string, handler: RpcHandler): () => void {
  const key = `${addonId}\u0000${name}`;
  handlers.set(key, handler);
  return () => handlers.delete(key);
}

export function getRpcHandler(addonId: string, name: string): RpcHandler | undefined {
  return handlers.get(`${addonId}\u0000${name}`);
}
