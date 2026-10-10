/**
 * Browser Panel WebSocket — the user-facing window into the built-in browser.
 * WebRTC P2P video transport; input only dispatched during takeover.
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { browserManager, WS_OPEN } from './manager.js';
import { browserRTC } from './webrtc.js';

/** Panel-server shutdown: sent when Web Access is turned off (or the context
 *  closes). The panel stops reconnecting and closes its own window. */
export function shutdownBrowserPanels(reason: string): void {
  browserManager.broadcast({ type: 'shutdown', reason });
}

/**
 * Omnibox resolution for the panel URL bar — Chrome-style:
 *   "example.com"          → https://example.com
 *   "https://x.y"          → as-is (assertUrl still gates it)
 *   "who is the president" → https://www.google.com/search?q=... (Google is
 *                             the harness's DEFAULT search engine)
 */
function omniboxTarget(raw: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return browserManager.assertUrl(raw, true);
  if (!/\s/.test(raw) && raw.includes('.')) return browserManager.assertUrl(`https://${raw}`, true);
  return browserManager.assertUrl(`https://www.google.com/search?q=${encodeURIComponent(raw)}`, true);
}

let wss: WebSocketServer | null = null;

/** attachBrowserPanelWs(server) — idempotent; call once after app.listen(). */
export function attachBrowserPanelWs(server: Server): void {
  if (wss) return;
  wss = new WebSocketServer({ server, path: '/api/browser/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    if (browserManager.isWebAccessOn() === false) {
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ type: 'shutdown', reason: 'web-access-off' }));
      }
      ws.close(1000, 'web-access-off');
      return;
    }
    const url = new URL(req.url ?? '/api/browser/ws', `http://${req.headers.host ?? '127.0.0.1'}`);
    const session = (url.searchParams.get('session') ?? '').trim();
    void session;

    const subscriber = {
      send: (data: string) => {
        if (ws.readyState === WS_OPEN) ws.send(data);
      },
      readyState: ws.readyState,
    };
    Object.defineProperty(subscriber, 'readyState', {
      get: () => ws.readyState,
    });

    void browserManager.ensureContext().then(() => browserRTC.startForPanel(subscriber)).catch(() => undefined);
    browserManager.subscribe(subscriber);

    void (async () => {
      try {
        const page = await browserManager.getActivePage();
        const url2 = page.url();
        const title = await page.title().catch(() => '');
        const tabs = await browserManager.listTabs();
        ws.send(
          JSON.stringify({
            type: 'hello',
            mode: browserManager.isTakeover() ? 'takeover' : 'agent',
            url: url2,
            title,
            cursor: browserManager.getCursor(),
            tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
            viewport: browserManager.getViewport(),
          }),
        );
      } catch {
      }
    })();

      ws.on('message', (raw) => {
      if (browserManager.isWebAccessOn() === false) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      void handlePanelMessage(ws, subscriber, msg).catch((error: unknown) => {
        console.error(
          '[browser-ws] panel message failed:',
          String(msg.type),
          error instanceof Error ? error.message : error,
        );
      });
    });

    ws.on('close', () => {
      browserManager.unsubscribe(subscriber);
      void browserRTC.stopForPanel(subscriber);
    });
  });
}

async function handlePanelMessage(ws: WebSocket, subscriber: { send: (data: string) => void; readyState: number }, msg: Record<string, unknown>): Promise<void> {
  const type = typeof msg.type === 'string' ? msg.type : '';
  const numOr = (key: string): number | undefined => {
    const v = msg[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };

  switch (type) {
    case 'ping':
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      return;

    case 'rtc-answer':
      if (typeof msg.sdp === 'string') await browserRTC.answer(msg.sdp);
      return;

    case 'rtc-ice':
      if (msg.candidate) await browserRTC.ice(msg.candidate);
      return;

    case 'rtc-restart':
      await browserRTC.startForPanel(subscriber);
      return;

    case 'takeover':
      browserManager.startTakeover('panel');
      await pushStatus();
      await pushTabs();
      return;

    case 'release':
      browserManager.endTakeover();
      await pushStatus();
      return;

    case 'screen-info': {
      const w = numOr('width');
      const h = numOr('height');
      const dpr = numOr('dpr');
      if (w !== undefined && h !== undefined && dpr !== undefined) {
        browserManager.setScreenInfo({ width: w, height: h, dpr });
        const vp = await browserManager.setViewport(w, h);
        if (ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ type: 'viewport', ...vp }));
        }
      }
      return;
    }

    case 'resize': {
      const w = numOr('width');
      const h = numOr('height');
      if (w !== undefined && h !== undefined) {
        const vp = await browserManager.setViewport(w, h);
        if (ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ type: 'viewport', ...vp }));
        }
      }
      return;
    }

    case 'goto': {
      if (!browserManager.isTakeover()) return;
      const raw = typeof msg.url === 'string' ? msg.url.trim() : '';
      if (!raw) return;
      try {
        const target = omniboxTarget(raw);
        const page = await browserManager.getActivePage();
        await page.goto(target.toString(), { waitUntil: 'commit', timeout: 30_000 });
        await pushStatus();
      } catch {
        if (ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Could not open that URL (http(s) only).' }));
        }
      }
      return;
    }

    case 'mouseMove': {
      const x = numOr('x');
      const y = numOr('y');
      if (x !== undefined && y !== undefined) browserManager.forwardMouseMove(x, y);
      return;
    }
    case 'userCursorMove': {
      if (browserManager.isTakeover()) return;
      const x = numOr('x');
      const y = numOr('y');
      if (x !== undefined && y !== undefined) browserManager.moveUserCursor(x, y);
      return;
    }
    case 'annotation': {
      const x = numOr('x');
      const y = numOr('y');
      const w = numOr('w');
      const h = numOr('h');
      if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
        browserManager.pushAnnotation({ x, y, w, h });
        browserManager.broadcast({ type: 'annotation', shape: 'rect', x, y, w, h });
      }
      return;
    }
    case 'mouseClick': {
      const x = numOr('x');
      const y = numOr('y');
      const button = msg.button === 'right' ? 'right' : 'left';
      if (x !== undefined && y !== undefined) await browserManager.forwardMouseClick(x, y, button);
      return;
    }
    case 'scroll': {
      const dx = numOr('deltaX') ?? 0;
      const dy = numOr('deltaY') ?? 0;
      await browserManager.forwardScroll(dx, dy);
      return;
    }
    case 'keyboardType': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (text) await browserManager.forwardKeyboardType(text);
      return;
    }
    case 'keyboardPress': {
      const key = typeof msg.key === 'string' ? msg.key : '';
      if (key) await browserManager.forwardKeyboardPress(key);
      return;
    }
    default:
      return;
  }
}

/** Pushes the current mode/url/title to every watcher. */
async function pushStatus(): Promise<void> {
  let url = '';
  let title = '';
  try {
    const page = await browserManager.getActivePage();
    url = page.url();
    title = await page.title().catch(() => '');
  } catch {
  }
  browserManager.broadcast({
    type: 'statusChange',
    mode: browserManager.isTakeover() ? 'takeover' : 'agent',
    url,
    title,
  });
}

/** Pushes the tab list to every watcher. */
async function pushTabs(): Promise<void> {
  try {
    const list = await browserManager.listTabs();
    browserManager.broadcast({ type: 'tabList', tabs: list, activeTabId: list.find((t) => t.active)?.id ?? '' });
  } catch {
  }
}
