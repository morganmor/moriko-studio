import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { adoptLegacyProviderKeys } from './lib/providerKeys';
import { adoptLegacyBrowserState, bootUiState, uiStateReachable } from './lib/storage';
import type { AddonBusPayload } from './types/addonBus';
import './styles/index.css';

// SPA scroll ownership: the browser's automatic scroll restoration on reload
// races the app's own anchor restore (it reapplies stale pixel offsets against
// fresh layout). The app restores scroll itself — see the G5 anchor in Thread.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

/**
 * BOOT ORDER — the device (`~/.moriko`) is the source of truth, so the first
 * paint must already carry it:
 *
 *  1. bootUiState()     one GET, awaited. Without it the app paints the
 *                       defaults and then snaps to the real theme/zoom — that
 *                       flash is the visible symptom of a wrong source of truth.
 *  2. adoptLegacy…()    a browser that predates this change still holds the
 *                       values (and possibly provider keys). Adopt them into
 *                       the device copy; the first acknowledged patch then
 *                       erases the browser's.
 *  3. import the app    DYNAMICALLY, and only now. The store builds its initial
 *                       state from the device view (theme, zoom, font, the
 *                       last provider/model, the active chat, Image Studio,
 *                       the run journal), and a module is evaluated exactly
 *                       once — a static import would freeze every one of those
 *                       at its default for the whole session (a light-theme
 *                       user boots dark and STAYS dark, and the model pill
 *                       comes up empty even though the device holds the choice).
 *
 * The render is NOT blocked on the provider-key push: it calls the provider
 * API, and a key that lands a second late is harmless.
 */
async function boot(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) throw new Error('Root element #root is missing from index.html.');
  await bootUiState();
  adoptLegacyBrowserState();
  const [{ default: App }, { useStore }] = await Promise.all([
    import('./App'),
    import('./store/useStore'),
  ]);
  // VISUAL v2 LIVE BUS — one EventSource per tab: addon bus frames carry
  // visual-rendered/updated/picked so every open browser re-binds cards live
  // (VisualCard reads useStore.addonEvent). Failure is non-fatal: the thread
  // still re-binds on the next conversation hydration.
  try {
    const bus = new EventSource('/api/addons/events');
    bus.onmessage = (message) => {
      try {
        const frame = JSON.parse(message.data) as AddonBusPayload;
        if (frame && typeof frame.topic === 'string') useStore.getState().pushAddonEvent(frame);
      } catch {
        // malformed frame — skip it, the stream continues
      }
    };
  } catch {
    // EventSource constructor failure (older proxy) — live re-bind stays off.
  }
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  if (!uiStateReachable()) {
    useStore
      .getState()
      .showNotice('device.unreachableSave');
  }
  void adoptLegacyProviderKeys();
}

void boot();
