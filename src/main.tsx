import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { adoptLegacyProviderKeys } from './lib/providerKeys';
import { adoptLegacyBrowserState, bootUiState, uiStateReachable } from './lib/storage';
import type { AddonBusPayload } from './types/addonBus';
import './styles/index.css';
import './styles/addon.css';
import './styles/sidebar.css';

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
  try {
    const { installAddonHost, dispatchAddonBusFrame } = await import('./addons/host');
    installAddonHost();
    const bus = new EventSource('/api/addons/events');
    bus.onmessage = (message) => {
      try {
        const frame = JSON.parse(message.data) as AddonBusPayload;
        if (frame && typeof frame.topic === 'string') {
          useStore.getState().pushAddonEvent(frame);
          dispatchAddonBusFrame(frame);
          if (frame.topic === 'addons.registry') {
            window.dispatchEvent(new Event('moriko:addons-reloaded'));
            const view = useStore.getState().view;
            if (typeof view === 'string' && view.startsWith('addon:')) {
              const addonId = view.slice('addon:'.length).split('/')[0] ?? '';
              if (frame.payload?.addonId === addonId && (frame.payload?.enabled === false || frame.payload?.reason === 'delete')) {
                useStore.getState().setView('addons');
              }
            }
          }
        }
      } catch {
      }
    };
  } catch {
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
