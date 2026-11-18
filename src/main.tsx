import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { adoptLegacyProviderKeys } from './lib/providerKeys';
import { adoptLegacyBrowserState, bootUiState, uiStateReachable } from './lib/storage';
import type { AddonBusPayload } from './types/addonBus';
import './styles/index.css';
import './styles/addon.css';
import './styles/sidebar.css';

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';


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
