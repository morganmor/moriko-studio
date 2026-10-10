import { useState, useCallback } from 'react';

export function use{{Name}}() {
  const [ready, setReady] = useState(false);
  const start = useCallback(() => setReady(true), []);
  return { ready, start };
}
