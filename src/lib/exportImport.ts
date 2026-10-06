/**
 * Export / import of the whole workspace as a JSON bundle.
 *
 * Lives in its OWN module (not ProvidersDialog) on purpose: three views use
 * these helpers, and if they stayed in a 49 KB dialog module, importing them
 * eagerly would defeat the dialog's lazy-loading entirely.
 */

import { useStore } from '../store/useStore';

export async function exportAll(): Promise<void> {
  const { buildExportBundle, downloadJson, hydrateConversationPayloads } = await import('../lib/api');
  const conversations = useStore.getState().conversations;
  await hydrateConversationPayloads(conversations);
  const bundle = buildExportBundle(conversations, {});
  downloadJson(`moriko-export-${new Date().toISOString().slice(0, 10)}.json`, bundle);
  useStore.getState().showNotice('export.done', { count: conversations.length });
}

export async function importBundle(file: File, onDone: () => void | Promise<void>): Promise<void> {
  const showNotice = useStore.getState().showNotice;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as {
      kind?: string;
      conversations?: unknown[];
      providerKeys?: Record<string, string>;
    };

    if (parsed.kind !== 'nova-ai-studio-export' || !Array.isArray(parsed.conversations)) {
      showNotice('export.notBundle');
      return;
    }

    const { sanitizeConversations } = await import('../lib/importExport');
    const conversations = sanitizeConversations(parsed.conversations);
    useStore.getState().replaceConversations(conversations);

    if (parsed.providerKeys && typeof parsed.providerKeys === 'object') {
      const { adoptProviderKeys } = await import('../lib/providerKeys');
      const { moved, failed } = await adoptProviderKeys(parsed.providerKeys);
      if (moved > 0) showNotice('export.keysMoved', { count: moved });
      if (failed.length > 0) {
        showNotice('export.keysFailed', { count: failed.length });
      }
    }

    await onDone();
    showNotice('export.importDone', { count: conversations.length });
  } catch (error) {
    showNotice('export.importFailed', undefined, {
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}
