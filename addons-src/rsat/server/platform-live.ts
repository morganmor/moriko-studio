/**
 * Live session access for the RSA/T addon — a thin indirection so the rest
 * of the addon never touches the platform API shape directly.
 */

export function listSessions(api) {
  return api.sessions.list() || [];
}

export function isRunning(api, sessionId) {
  return Boolean(api.sessions.get?.(sessionId));
}
