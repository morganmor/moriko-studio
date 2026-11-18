import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { browserManager, normalizeSessionId, WS_OPEN, type PanelSubscriber } from './manager.js';
import { browserRTC } from './webrtc.js';

export function shutdownBrowserPanels(reason: string, sessionId?: string): void {
  if (sessionId !== undefined) {
    browserManager.broadcast({ type: 'shutdown', reason }, normalizeSessionId(sessionId));
    return;
  }
  browserManager.broadcast({ type: 'shutdown', reason });
}

function omniboxTarget(raw: string): URL {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return browserManager.assertUrl(withScheme, true);
}

let wss: WebSocketServer | null = null;

export function attachBrowserPanelWs(server: Server): void {
  if (wss) return;
  wss = new WebSocketServer({
    server,
    path: '/api/browser/ws',
    maxPayload: 32 * 1024 * 1024,
  });

  wss.on('connection', async (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '/api/browser/ws', 'http://localhost');
    const sessionId = normalizeSessionId(url.searchParams.get('session') ?? undefined);

    if (browserManager.isWebAccessOn(sessionId) === false) {
      try {
        ws.send(JSON.stringify({ type: 'shutdown', reason: 'web-access-off' }));
      } catch {
      }
      ws.close(1000, 'web-access-off');
      return;
    }

    const sub: PanelSubscriber = {
      get readyState() {
        return ws.readyState;
      },
      send(data: string) {
        if (ws.readyState === WS_OPEN) ws.send(data);
      },
    };
    browserManager.subscribe(sub, sessionId);

    try {
      await browserManager.ensureContext(sessionId);
    } catch (error) {
      if (ws.readyState === WS_OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    if (ws.readyState !== WS_OPEN) {
      browserManager.unsubscribe(sub, sessionId);
      return;
    }

    const tabs = await browserManager.listTabs(sessionId).catch(() => []);
    ws.send(
      JSON.stringify({
        type: 'hello',
        sessionId,
        mode: browserManager.isTakeover(sessionId) ? 'takeover' : 'agent',
        handoverMessage: browserManager.getHandoverMessage(sessionId),
        cursor: browserManager.getCursor(sessionId),
        tabs,
        activeTabId: tabs.find((t) => t.active)?.id ?? '',
        viewport: browserManager.getViewport(sessionId),
        pendingDialog: browserManager.getPendingDialog(sessionId),
        pendingFileChooser: browserManager.getPendingFileChooser(sessionId),
      }),
    );

    void browserRTC.startForPanel(sessionId, sub);

    ws.on('message', (raw) => {
      if (browserManager.isWebAccessOn(sessionId) === false) {
        try {
          ws.send(JSON.stringify({ type: 'shutdown', reason: 'web-access-off' }));
        } catch {
        }
        ws.close(1000, 'web-access-off');
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      void handlePanelMessage(sessionId, ws, sub, msg);
    });

    ws.on('close', () => {
      browserManager.unsubscribe(sub, sessionId);
      void browserRTC.stopForPanel(sessionId, sub);
    });

    ws.on('error', () => {
      browserManager.unsubscribe(sub, sessionId);
      void browserRTC.stopForPanel(sessionId, sub);
    });
  });
}

async function handlePanelMessage(
  sessionId: string,
  ws: WebSocket,
  sub: PanelSubscriber,
  msg: Record<string, unknown>,
): Promise<void> {
  const type = typeof msg.type === 'string' ? msg.type : '';
  switch (type) {
    case 'ping': {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    case 'rtc-answer': {
      if (typeof msg.sdp === 'string') void browserRTC.answer(sessionId, msg.sdp);
      return;
    }
    case 'rtc-ice': {
      if (msg.candidate) void browserRTC.ice(sessionId, msg.candidate);
      return;
    }
    case 'rtc-restart': {
      void browserRTC.startForPanel(sessionId, sub);
      return;
    }
    case 'takeover': {
      browserManager.startTakeover('user:panel', '', sessionId);
      await pushTabs(sessionId);
      return;
    }
    case 'release': {
      browserManager.endTakeover(sessionId);
      await pushTabs(sessionId);
      return;
    }
    case 'screen-info': {
      const width = Number(msg.width);
      const height = Number(msg.height);
      const dpr = Number(msg.dpr);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        browserManager.setScreenInfo(
          { width, height, dpr: Number.isFinite(dpr) && dpr > 0 ? dpr : 1 },
          sessionId,
        );
      }
      return;
    }
    case 'resize': {
      const width = Number(msg.width);
      const height = Number(msg.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      const vp = await browserManager.setViewport(width, height, sessionId);
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: 'viewport', ...vp }));
      return;
    }
    case 'new-tab': {
      if (!browserManager.isTakeover(sessionId)) browserManager.startTakeover('user:new-tab', '', sessionId);
      await browserManager.openInNewTab(sessionId);
      await pushTabs(sessionId);
      return;
    }
    case 'switch-tab': {
      const tabId = typeof msg.tabId === 'string' ? msg.tabId : '';
      if (!tabId) return;
      if (!browserManager.isTakeover(sessionId)) browserManager.startTakeover('user:switch-tab', '', sessionId);
      await browserManager.switchTo(tabId, sessionId).catch(() => undefined);
      await pushTabs(sessionId);
      return;
    }
    case 'close-tab': {
      const tabId = typeof msg.tabId === 'string' ? msg.tabId : '';
      if (!tabId) return;
      if (!browserManager.isTakeover(sessionId)) browserManager.startTakeover('user:close-tab', '', sessionId);
      await browserManager.closePage(tabId, sessionId);
      await pushTabs(sessionId);
      return;
    }
    case 'back': {
      if (!browserManager.isTakeover(sessionId)) browserManager.startTakeover('user:nav', '', sessionId);
      await browserManager.navigateBack(sessionId);
      await pushTabs(sessionId);
      return;
    }
    case 'forward': {
      if (!browserManager.isTakeover(sessionId)) browserManager.startTakeover('user:nav', '', sessionId);
      await browserManager.navigateForward(sessionId);
      await pushTabs(sessionId);
      return;
    }
    case 'reload': {
      if (!browserManager.isTakeover(sessionId)) browserManager.startTakeover('user:nav', '', sessionId);
      await browserManager.reloadPage(sessionId);
      await pushTabs(sessionId);
      return;
    }
    case 'stop': {
      await browserManager.stopLoading(sessionId);
      return;
    }
    case 'goto': {
      const raw = typeof msg.url === 'string' ? msg.url : '';
      if (!raw.trim()) return;
      if (!browserManager.isTakeover(sessionId)) {
        browserManager.startTakeover('user:omnibox', '', sessionId);
      }
      let target: URL;
      try {
        target = omniboxTarget(raw);
      } catch (error) {
        if (ws.readyState === WS_OPEN) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Could not open that URL (http/https only).',
            }),
          );
        }
        return;
      }
      try {
        const page = await browserManager.getActivePage(sessionId);
        await page.goto(target.toString(), { waitUntil: 'commit', timeout: 30_000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
      } catch (error) {
        if (ws.readyState === WS_OPEN) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: `Navigation failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
        }
      }
      await pushTabs(sessionId);
      return;
    }
    case 'mouseMove': {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        browserManager.forwardMouseMove(x, y, sessionId);
      }
      return;
    }
    case 'mouseDown': {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const btn = msg.button === 'right' || msg.button === 'middle' ? msg.button : 'left';
      if (Number.isFinite(x) && Number.isFinite(y)) {
        void browserManager.forwardMouseDown(x, y, btn, sessionId);
      }
      return;
    }
    case 'mouseUp': {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const btn = msg.button === 'right' || msg.button === 'middle' ? msg.button : 'left';
      if (Number.isFinite(x) && Number.isFinite(y)) {
        void browserManager.forwardMouseUp(x, y, btn, sessionId);
      }
      return;
    }
    case 'mouseClick': {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const btn = msg.button === 'right' || msg.button === 'middle' ? msg.button : 'left';
      if (Number.isFinite(x) && Number.isFinite(y)) {
        void browserManager.forwardMouseClick(x, y, btn, sessionId);
      }
      return;
    }
    case 'scroll': {
      const dx = Number(msg.deltaX) || 0;
      const dy = Number(msg.deltaY) || 0;
      void browserManager.forwardScroll(dx, dy, sessionId);
      return;
    }
    case 'keyboardType': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (text) void browserManager.forwardKeyboardType(text, sessionId);
      return;
    }
    case 'keyboardPress': {
      const key = typeof msg.key === 'string' ? msg.key : '';
      if (!key) return;
      const modifiers = {
        ctrlKey: msg.ctrlKey === true,
        altKey: msg.altKey === true,
        shiftKey: msg.shiftKey === true,
        metaKey: msg.metaKey === true,
      };
      void browserManager.forwardKeyboardPress(key, modifiers, sessionId);
      return;
    }
    case 'paste': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (text) void browserManager.forwardPaste(text, sessionId);
      return;
    }
    case 'clipboard-copy-req': {
      const text = await browserManager.copySelection(sessionId).catch(() => '');
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ type: 'clipboard-copy', text }));
      }
      return;
    }
    case 'dialog-response': {
      const id = typeof msg.id === 'string' ? msg.id : '';
      const accept = msg.accept === true;
      const promptText = typeof msg.promptText === 'string' ? msg.promptText : undefined;
      browserManager.respondToDialog(id, accept, promptText, sessionId);
      return;
    }
    case 'file-chooser-upload': {
      const id = typeof msg.id === 'string' ? msg.id : '';
      const rawFiles = Array.isArray(msg.files) ? msg.files : [];
      const files = rawFiles
        .filter(
          (f): f is { name: string; mimeType?: string; bufferBase64: string } =>
            Boolean(f) &&
            typeof (f as { name?: unknown }).name === 'string' &&
            typeof (f as { bufferBase64?: unknown }).bufferBase64 === 'string',
        )
        .slice(0, 10);
      await browserManager.uploadFileChooser(id, files, sessionId);
      return;
    }
    case 'file-chooser-cancel': {
      const id = typeof msg.id === 'string' ? msg.id : '';
      await browserManager.cancelFileChooser(id, sessionId);
      return;
    }
    case 'userCursorMove': {
      if (browserManager.isTakeover(sessionId)) return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        browserManager.moveUserCursor(x, y, sessionId);
      }
      return;
    }
    case 'annotation': {
      if (browserManager.isTakeover(sessionId)) return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      const w = Number(msg.w);
      const h = Number(msg.h);
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(w) &&
        Number.isFinite(h) &&
        w > 2 &&
        h > 2
      ) {
        browserManager.pushAnnotation({ x, y, w, h }, sessionId);
        browserManager.broadcast({ type: 'annotation', shape: 'rect', x, y, w, h }, sessionId);
      }
      return;
    }
    default:
      return;
  }
}

async function pushTabs(sessionId: string): Promise<void> {
  const list = await browserManager.listTabs(sessionId).catch(() => []);
  browserManager.broadcast(
    {
      type: 'tabList',
      tabs: list,
      activeTabId: list.find((t) => t.active)?.id ?? '',
    },
    sessionId,
  );
}
