import { browserManager, normalizeSessionId, WS_OPEN, type PanelSubscriber } from './manager.js';

type Page = import('playwright-core').Page;

interface ActiveSession {
  sessionId: string;
  panel: PanelSubscriber;
  page: Page;
  clearWatchdog: (() => void) | null;
  navDebounce: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  resizeCheckTimer: ReturnType<typeof setTimeout> | null;
  desiredViewport: { width: number; height: number };
  lastResizedRetargetKey: string;
  retryCount: number;
  generation: number;
}

const MAX_AUTO_RETRIES = 2;
const NAV_DEBOUNCE_MS = 40;
const OFFER_WATCHDOG_MS = 4_500;
const RESIZE_SETTLE_MS = 220;
const RESIZE_TOLERANCE_PX = 8;

const activeSessions = new Map<string, ActiveSession>();
let nextGeneration = 1;

function sendToPanel(session: ActiveSession | undefined, message: Record<string, unknown>): void {
  if (!session || session.panel.readyState !== WS_OPEN) return;
  try {
    session.panel.send(JSON.stringify(message));
  } catch {
  }
}

async function evalOnPageResult<T>(page: Page, expression: string): Promise<T | null> {
  try {
    if (!page.isClosed()) return (await page.evaluate(expression)) as T;
  } catch {
  }
  return null;
}

async function evalOnPage(page: Page, expression: string): Promise<void> {
  await evalOnPageResult(page, expression);
}

function clearTimers(session: ActiveSession): void {
  session.clearWatchdog?.();
  if (session.navDebounce) {
    clearTimeout(session.navDebounce);
    session.navDebounce = null;
  }
  if (session.retryTimer) {
    clearTimeout(session.retryTimer);
    session.retryTimer = null;
  }
  if (session.resizeCheckTimer) {
    clearTimeout(session.resizeCheckTimer);
    session.resizeCheckTimer = null;
  }
}

async function stopActive(rawSessionId: string): Promise<void> {
  const sid = normalizeSessionId(rawSessionId);
  const current = activeSessions.get(sid);
  if (!current) return;
  activeSessions.delete(sid);
  clearTimers(current);
  await evalOnPage(current.page, 'window.__morikoRtc && window.__morikoRtc.stop()');
}

function scheduleRetry(session: ActiveSession, delayMs: number): void {
  if (session.panel.readyState !== WS_OPEN) return;
  if (activeSessions.get(session.sessionId) !== session) return;
  if (session.retryCount >= MAX_AUTO_RETRIES) return;
  if (session.retryTimer) clearTimeout(session.retryTimer);
  const nextRetry = session.retryCount + 1;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    if (activeSessions.get(session.sessionId) !== session) return;
    if (session.panel.readyState !== WS_OPEN) return;
    void startForPanel(session.sessionId, session.panel, { retryCount: nextRetry });
  }, delayMs);
}

export async function startForPanel(
  rawSessionId: string,
  panel: PanelSubscriber,
  opts: { retryCount?: number; retargetKey?: string } = {},
): Promise<void> {
  const sid = normalizeSessionId(rawSessionId);
  const previous = activeSessions.get(sid);
  if (previous && previous.panel !== panel && previous.panel.readyState === WS_OPEN) {
    try {
      previous.panel.send(JSON.stringify({ type: 'rtc-state', state: 'superseded' }));
    } catch {
    }
  }
  await stopActive(sid);

  let page: Page;
  try {
    page = await browserManager.getActivePage(sid);
  } catch {
    return;
  }

  const startVp = browserManager.getViewport(sid);
  await browserManager.syncPageViewportAndBounds(page, sid);

  const generation = nextGeneration++;
  const session: ActiveSession = {
    sessionId: sid,
    panel,
    page,
    clearWatchdog: null,
    navDebounce: null,
    retryTimer: null,
    resizeCheckTimer: null,
    desiredViewport: { ...startVp },
    lastResizedRetargetKey: opts.retargetKey ?? '',
    retryCount: opts.retryCount ?? 0,
    generation,
  };

  let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    const cur = activeSessions.get(sid);
    if (!cur || cur.generation !== generation) return;
    if (cur.retryCount < MAX_AUTO_RETRIES) {
      scheduleRetry(cur, 250);
      return;
    }
    sendToPanel(cur, {
      type: 'rtc-error',
      error: `No capture offer within ${Math.round(OFFER_WATCHDOG_MS / 1000)}s — capture may be blocked on this page.`,
    });
  }, OFFER_WATCHDOG_MS);

  session.clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    session.clearWatchdog = null;
  };

  activeSessions.set(sid, session);
  try {
    await browserManager.ensurePageSignalingReady(sid, page);
    await page.evaluate(`window.__morikoRtc && window.__morikoRtc.start(${startVp.width}, ${startVp.height})`);
    if (activeSessions.get(sid)?.generation !== generation) return;
    const latestVp = browserManager.getViewport(sid);
    if (latestVp.width !== startVp.width || latestVp.height !== startVp.height) {
      void resize(sid, latestVp.width, latestVp.height);
    } else {
      scheduleGeometrySync(session);
    }
  } catch (error) {
    session.clearWatchdog?.();
    if (activeSessions.get(sid)?.generation !== generation) return;
    if (session.retryCount < MAX_AUTO_RETRIES) {
      scheduleRetry(session, 300);
      return;
    }
    sendToPanel(session, {
      type: 'rtc-error',
      error: `Tab capture failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export async function stopForPanel(rawSessionId: string, panel: PanelSubscriber): Promise<void> {
  const sid = normalizeSessionId(rawSessionId);
  const current = activeSessions.get(sid);
  if (current && current.panel === panel) {
    await stopActive(sid);
  }
}

export async function stopSession(rawSessionId: string): Promise<void> {
  await stopActive(rawSessionId);
}

export async function answer(rawSessionId: string, sdp: string): Promise<void> {
  const sid = normalizeSessionId(rawSessionId);
  const current = activeSessions.get(sid);
  if (!current) return;
  await evalOnPage(current.page, `window.__morikoRtc && window.__morikoRtc.accept(${JSON.stringify(sdp)})`);
}

export async function ice(rawSessionId: string, candidate: unknown): Promise<void> {
  const sid = normalizeSessionId(rawSessionId);
  const current = activeSessions.get(sid);
  if (!current || !candidate) return;
  await evalOnPage(current.page, `window.__morikoRtc && window.__morikoRtc.addIce(${JSON.stringify(candidate)})`);
}

export function onSignaling(msg: Record<string, unknown>): void {
  const sid = typeof msg.__sessionId === 'string' ? msg.__sessionId : 'default';
  const current = activeSessions.get(sid);
  if (!current || msg.__page !== current.page) return;
  const type = typeof msg.type === 'string' ? msg.type : '';
  if (type === 'offer') {
    current.clearWatchdog?.();
    current.retryCount = 0;
    sendToPanel(current, { type: 'rtc-offer', sdp: msg.sdp });
  } else if (type === 'ice') {
    sendToPanel(current, { type: 'rtc-ice', candidate: msg.candidate });
  } else if (type === 'state') {
    const state = typeof msg.state === 'string' ? msg.state : '';
    sendToPanel(current, { type: 'rtc-state', state });
    if (state === 'failed' || state === 'disconnected') {
      scheduleRetry(current, 250);
    }
  } else if (type === 'log') {
    sendToPanel(current, { type: 'rtc-log', text: msg.text });
  } else if (type === 'rtc-ended') {
    sendToPanel(current, { type: 'rtc-state', state: 'capture-ended' });
    scheduleRetry(current, 180);
  } else if (type === 'acquiring') {
    sendToPanel(current, { type: 'rtc-state', state: 'acquiring' });
  } else if (type === 'acquire-attempt-failed') {
    sendToPanel(current, { type: 'rtc-state', state: 'acquire-failed', error: msg.error });
  } else if (type === '__pageNavigated') {
    if (current.navDebounce) clearTimeout(current.navDebounce);
    current.navDebounce = setTimeout(() => {
      current.navDebounce = null;
      const latest = activeSessions.get(sid);
      if (latest && latest.generation === current.generation) {
        void startForPanel(sid, latest.panel, { retryCount: 0 });
      }
    }, NAV_DEBOUNCE_MS);
  }
}

function scheduleGeometrySync(session: ActiveSession): void {
  if (session.resizeCheckTimer) {
    clearTimeout(session.resizeCheckTimer);
    session.resizeCheckTimer = null;
  }
  const sid = session.sessionId;
  const scheduledGen = session.generation;
  session.resizeCheckTimer = setTimeout(() => {
    session.resizeCheckTimer = null;
    const latest = activeSessions.get(sid);
    if (!latest || latest.generation !== scheduledGen || latest.page.isClosed()) return;
    void (async () => {
      const target = latest.desiredViewport;
      const readSettings = () =>
        evalOnPageResult<{ active?: boolean; width?: number; height?: number }>(
          latest.page,
          'window.__morikoRtc && window.__morikoRtc.getSettings()',
        );
      let settings = await readSettings();
      if (!settings?.active || !(settings.width && settings.height)) return;

      for (let pass = 0; pass < 2; pass++) {
        const boundsUpdated = await browserManager.calibrateWindowInsetFromCapture(
          sid,
          settings.width,
          settings.height,
        );
        if (!boundsUpdated) break;
        await new Promise((r) => setTimeout(r, 140));
        if (activeSessions.get(sid)?.generation !== scheduledGen || latest.page.isClosed()) return;
        await evalOnPageResult(
          latest.page,
          `window.__morikoRtc && window.__morikoRtc.resize(${target.width}, ${target.height})`,
        );
        await new Promise((r) => setTimeout(r, 200));
        if (activeSessions.get(sid)?.generation !== scheduledGen || latest.page.isClosed()) return;
        settings = await readSettings();
        if (!settings?.active || !(settings.width && settings.height)) return;
      }

      const sizeKey = `${target.width}x${target.height}`;
      const dw = Math.abs(settings.width - target.width);
      const dh = Math.abs(settings.height - target.height);
      if ((dw > RESIZE_TOLERANCE_PX || dh > RESIZE_TOLERANCE_PX) && latest.lastResizedRetargetKey !== sizeKey) {
        void startForPanel(sid, latest.panel, { retryCount: 0, retargetKey: sizeKey });
      }
    })();
  }, RESIZE_SETTLE_MS);
}

export async function resize(rawSessionId: string, width: number, height: number): Promise<void> {
  const sid = normalizeSessionId(rawSessionId);
  const current = activeSessions.get(sid);
  if (!current || current.page.isClosed()) return;
  const w = Math.min(3840, Math.max(320, Math.round(width) & ~1));
  const h = Math.min(2160, Math.max(240, Math.round(height) & ~1));
  current.desiredViewport = { width: w, height: h };

  await evalOnPageResult(current.page, `window.__morikoRtc && window.__morikoRtc.resize(${w}, ${h})`);
  scheduleGeometrySync(current);
}

async function retarget(rawSessionId: string): Promise<void> {
  const sid = normalizeSessionId(rawSessionId);
  const current = activeSessions.get(sid);
  if (current) {
    await startForPanel(sid, current.panel, { retryCount: 0 });
  }
}

browserManager.registerTransport({ retarget, resize, onSignaling, stopSession });

export const browserRTC = { startForPanel, stopForPanel, stopSession, resize, answer, ice };
