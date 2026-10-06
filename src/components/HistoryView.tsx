import { useMemo, useState } from 'react';
import { Download, MessageSquare, Search, Trash2, Upload } from './icons';

import { isPhantomConversation, useStore } from '../store/useStore';
import { EmptyState, Modal, cx } from './ui';
import { exportAll, importBundle } from '../lib/exportImport';

/** Groups conversations by calendar day, newest first. */
function groupByDay(conversations: ReturnType<typeof useStore.getState>['conversations']) {
  const groups = new Map<string, typeof conversations>();
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  for (const conversation of sorted) {
    const date = new Date(conversation.updatedAt);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const key =
      date.toDateString() === today.toDateString()
        ? 'Today'
        : date.toDateString() === yesterday.toDateString()
          ? 'Yesterday'
          : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

    const bucket = groups.get(key) ?? [];
    bucket.push(conversation);
    groups.set(key, bucket);
  }
  return groups;
}

/** History view: every saved thread, searchable, with bulk export. */
export function HistoryView() {
  const allConversations = useStore((state) => state.conversations);
  const conversations = useMemo(
    () => allConversations.filter((conversation) => !isPhantomConversation(conversation)),
    [allConversations],
  );
  const selectConversation = useStore((state) => state.selectConversation);
  const deleteConversation = useStore((state) => state.deleteConversation);
  const clearAll = useStore((state) => state.clearAllConversations);
  const showNotice = useStore((state) => state.showNotice);
  const loadProviders = useStore((state) => state.loadProviders);

  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(needle) ||
        conversation.turns.some((turn) => turn.content.toLowerCase().includes(needle)),
    );
  }, [conversations, query]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-normal tracking-tight text-ink">History</h2>
          <p className="mt-1 text-sm text-muted">
            {conversations.length} conversation{conversations.length === 1 ? '' : 's'} stored in this
            browser.
          </p>
        </div>

        <div className="flex gap-1.5">
          <label className="pill-button cursor-pointer border border-hairline text-[12px] text-muted hover:text-ink">
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Import
            <input
              type="file"
              accept="application/json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importBundle(file, loadProviders);
                event.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void exportAll()}
            disabled={conversations.length === 0}
            className="pill-button border border-hairline text-[12px] text-muted hover:text-ink"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export
          </button>
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={conversations.length === 0}
            className="pill-button border border-danger/40 text-[12px] text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Clear
          </button>
        </div>
      </header>

      <div className="relative mb-6">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles and message text"
          aria-label="Search conversations"
          className="field pl-9"
        />
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          icon={<MessageSquare className="h-5 w-5" />}
          title="No conversations yet"
          description="Start a chat in the Playground and it will show up here."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="No matches"
          description={`Nothing matched “${query}”. Try a different term.`}
        />
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([label, items]) => (
            <section key={label}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
                {label}
              </h3>
              <ul className="space-y-1.5">
                {items.map((conversation) => (
                  <li key={conversation.id}>
                    <div
                      className={cx(
                        'group flex items-center gap-2 rounded-card border border-hairline bg-panel px-3.5 py-3',
                        'transition-colors hover:border-accent/40 hover:bg-elevated',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => selectConversation(conversation.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-[13.5px] font-medium text-ink">
                          {conversation.title}
                        </p>
                        <p className="mt-0.5 truncate text-[11.5px] text-faint">
                          {conversation.turns.length} turn
                          {conversation.turns.length === 1 ? '' : 's'} · {conversation.model || 'no model'}{' '}
                          · {new Date(conversation.updatedAt).toLocaleTimeString()}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteConversation(conversation.id)}
                        aria-label={`Delete chat "${conversation.title}"`}
                        className="icon-button h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear all conversations?"
        description="This removes every saved thread from this browser. Export first if you want a copy."
        size="max-w-md"
        footer={
          <>
            <button
              type="button"
              className="pill-button text-muted hover:text-ink"
              onClick={() => setConfirmClear(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pill-button bg-danger text-white"
              onClick={() => {
                clearAll();
                setConfirmClear(false);
                showNotice('conversations.cleared');
              }}
            >
              Delete everything
            </button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {conversations.length} conversation{conversations.length === 1 ? '' : 's'} will be removed
          from this device. Provider keys in the device vault are kept.
        </p>
      </Modal>
    </div>
  );
}
