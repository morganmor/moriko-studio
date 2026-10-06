/** browserRTC — Node-side signaling relay for WebRTC panel transport.
 * No media bytes pass through Node; only SDP/ICE relay + tab re-pointing. */
import { browserManager, WS_OPEN, type PanelSubscriber } from './manager.js';

type Page = import('playwright-core').Page;

interface ActiveSession {
  panel: PanelSubscriber;
  page: Page;
}

let active: ActiveSession | null = null;
let clearWatchdog: (() => void) | null = null;
let navDebounce: ReturnType<typeof setTimeout> | null = null;

function sendToPanel(message: Record<string, unknown>): void {
  if (!active || active.panel.readyState !== WS_OPEN) return;
  try {
    active.panel.send(JSON.stringify(message));
  } catch {
  }
}

async function evalOnPage(page: Page, expression: string): Promise<void> {
  try {
    await page.evaluate(expression);
  } catch {
  }
}

/** Stops the current page peer (fresh start follows immediately). */
async function stopActive(): Promise<void> {
  clearWatchdog?.();
  const current = active;
  active = null;
  if (current) await evalOnPage(current.page, 'window.__morikoRtc && window.__morikoRtc.stop()');
}

/** Starts/restarts the WebRTC session for one panel. */
export async function startForPanel(panel: PanelSubscriber): Promise<void> {
  const previous = active;
  if (previous && previous.panel !== panel && previous.panel.readyState === WS_OPEN) {
    try {
      previous.panel.send(JSON.stringify({ type: 'rtc-state', state: 'superseded' }));
    } catch {
    }
  }
  await stopActive();
  let page: Page;
  try {
    page = await browserManager.getActivePage();
  } catch {
    return;
  }
  active = { panel, page };
  // 12 s watchdog — if no offer, surface error instead of hanging.
  clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    clearWatchdog = null;
  };
  let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (active && active.panel === panel) {
      sendToPanel({
        type: 'rtc-error',
        error: 'No capture offer within 12 s — getDisplayMedia is blocked or hanging in the harness page.',
      });
    }
  }, 12_000);
  try {
    await page.evaluate('window.__morikoRtc && window.__morikoRtc.start()');
  } catch (error) {
    clearWatchdog?.();
    sendToPanel({
      type: 'rtc-error',
      error: `Tab capture failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Panel socket closed → tear down the page peer when it was ours. */
export async function stopForPanel(panel: PanelSubscriber): Promise<void> {
  if (active && active.panel === panel) await stopActive();
}

/** Panel → page: SDP answer. */
export async function answer(sdp: string): Promise<void> {
  if (!active) return;
  await evalOnPage(active.page, `window.__morikoRtc && window.__morikoRtc.accept(${JSON.stringify(sdp)})`);
}

/** Panel → page: one remote ICE candidate. */
export async function ice(candidate: unknown): Promise<void> {
  if (!active || !candidate) return;
  await evalOnPage(active.page, `window.__morikoRtc && window.__morikoRtc.addIce(${JSON.stringify(candidate)})`);
}

/** Signaling sink — only the active tab's peer is honored. */
export function onSignaling(msg: Record<string, unknown>): void {
  if (!active || msg.__page !== active.page) return;
  const type = typeof msg.type === 'string' ? msg.type : '';
  if (type === 'offer') {
    clearWatchdog?.();
    sendToPanel({ type: 'rtc-offer', sdp: msg.sdp });
  } else if (type === 'ice') {
    sendToPanel({ type: 'rtc-ice', candidate: msg.candidate });
  } else if (type === 'state') {
    sendToPanel({ type: 'rtc-state', state: msg.state });
  } else if (type === 'stats') {
    sendToPanel({ type: 'rtc-stats', fps: msg.fps, kbps: msg.kbps, width: msg.width, height: msg.height });
  } else if (type === 'log') {
    sendToPanel({ type: 'rtc-log', text: msg.text });
  } else if (type === 'rtc-ended') {
    sendToPanel({ type: 'rtc-state', state: 'capture-ended' });
  } else if (type === 'acquiring') {
    sendToPanel({ type: 'rtc-state', state: 'acquiring' });
  } else if (type === 'acquire-attempt-failed') {
    sendToPanel({ type: 'rtc-state', state: 'acquire-failed', error: msg.error });
  } else if (type === '__pageNavigated') {
    if (navDebounce) clearTimeout(navDebounce);
    navDebounce = setTimeout(() => {
      navDebounce = null;
      if (active) void startForPanel(active.panel);
    }, 300);
  }
}

/** Active tab changed → re-point the capture at the new tab. */
async function retarget(): Promise<void> {
  if (active) await startForPanel(active.panel);
}

browserManager.registerTransport({ retarget, onSignaling });

export const browserRTC = { startForPanel, stopForPanel, answer, ice };
