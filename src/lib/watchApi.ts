/**
 * watchApi.ts — typed helpers for /api/watch (Mobile Watching).
 */

export interface WatchTarget {
  id: string;
  label: string;
  installed: boolean;
  runsHere: boolean;
}

export interface WatchPort {
  port: number;
  label?: string;
  pid?: number;
}

export interface WatchInstallProgress {
  phase: 'idle' | 'downloading' | 'extracting' | 'error';
  targetId: string | null;
  received: number;
  total: number;
  error?: string;
}

export interface WatchStatus {
  installed: boolean;
  hostTarget: string;
  version: string | null;
  tunnel: {
    running: boolean;
    url: string | null;
    port: number | null;
    pid: number | null;
    startedAt: string | null;
    adopted: boolean;
  };
  install: WatchInstallProgress;
  targets: WatchTarget[];
  ports: WatchPort[];
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* keep status text */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export function fetchWatchStatus(): Promise<WatchStatus> {
  return fetch('/api/watch/status').then((res) => jsonOrThrow<WatchStatus>(res));
}

export function fetchInstallProgress(): Promise<WatchInstallProgress> {
  return fetch('/api/watch/install-progress').then((res) => jsonOrThrow<WatchInstallProgress>(res));
}

/** Downloads the selected platform asset; server skips when already installed. */
export function installWatch(target?: string): Promise<{ skipped: boolean; path: string }> {
  return fetch('/api/watch/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(target ? { target } : {}),
  }).then((res) => jsonOrThrow<{ skipped: boolean; path: string }>(res));
}

export function startWatch(port: number, target?: string): Promise<{ url: string; port: number }> {
  return fetch('/api/watch/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port, ...(target ? { target } : {}) }),
  }).then((res) => jsonOrThrow<{ url: string; port: number }>(res));
}

export function stopWatch(): Promise<{ stopped: boolean }> {
  return fetch('/api/watch/stop', { method: 'POST' }).then((res) =>
    jsonOrThrow<{ stopped: boolean }>(res),
  );
}

/** SVG QR endpoint — use directly as an <img src>. */
export function watchQrUrl(text: string): string {
  return `/api/watch/qr?text=${encodeURIComponent(text)}`;
}
