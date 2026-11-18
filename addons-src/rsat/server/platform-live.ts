

export function listSessions(api) {
  return api.sessions.list() || [];
}

export function isRunning(api, sessionId) {
  return Boolean(api.sessions.get?.(sessionId));
}
