import { useMemo, useState } from 'react';
import { Download, MessageSquare, RotateCcw, Search, Trash2, Upload } from './icons';

import { isPhantomConversation, refreshConversationList, useStore } from '../store/useStore';
import { EmptyState, Modal } from './ui';
import { exportAll, importBundle } from '../lib/exportImport';

/** Satu entri trash dari GET /api/conversations/trash. */
interface TrashEntry {
  id: string;
  folder: string;
  title: string;
  updatedAt: number;
  turnCount: number;
  deletedAt: number;
}

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
  /** TRASH — picker restore: daftar percakapan terhapus (folder server
   *  conversation/trash), user memilih mana yang dipulihkan. */
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [trashBusy, setTrashBusy] = useState(false);

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
    <div className="page view-enter">
      <header style={{ marginBottom: 24, display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 400, letterSpacing: '-0.02em', color: 'rgb(var(--c-ink))' }}>History</h2>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--muted)' }}>
            {conversations.length} conversation{conversations.length === 1 ? '' : 's'} stored in this
            browser.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
            <Upload className="ic" aria-hidden="true" />
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
            className="btn ghost sm"
          >
            <Download className="ic" aria-hidden="true" />
            Export
          </button>
          <button
            type="button"
            onClick={async () => {
              setTrashOpen(true);
              setTrashBusy(true);
              try {
                const resp = await fetch('/api/conversations/trash');
                if (resp.ok) setTrash(((await resp.json()) as { trash: TrashEntry[] }).trash);
              } finally {
                setTrashBusy(false);
              }
            }}
            className="btn ghost sm"
          >
            <RotateCcw className="ic" aria-hidden="true" />
            Restore
          </button>
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={conversations.length === 0}
            className="btn danger sm"
          >
            <Trash2 className="ic" aria-hidden="true" />
            Clear
          </button>
        </div>
      </header>

      <div style={{ position: 'relative', marginBottom: 24 }}>
        <Search
          style={{ pointerEvents: 'none', position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: 'var(--faint)' }}
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles and message text"
          aria-label="Search conversations"
          className="field"
          style={{ paddingLeft: 36 }}
        />
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          icon={<MessageSquare className="ic" style={{ width: 20, height: 20 }} />}
          title="No conversations yet"
          description="Start a chat in the Playground and it will show up here."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search className="ic" style={{ width: 20, height: 20 }} />}
          title="No matches"
          description={`Nothing matched “${query}”. Try a different term.`}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {[...groups.entries()].map(([label, items]) => (
            <section key={label}>
              <h3 style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--faint)' }}>
                {label}
              </h3>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 0, margin: 0, listStyle: 'none' }}>
                {items.map((conversation) => (
                  <li key={conversation.id}>
                    <div
                      className="card hrow"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px' }}
                    >
                      <button
                        type="button"
                        onClick={() => selectConversation(conversation.id)}
                        style={{ minWidth: 0, flex: 1, textAlign: 'left', background: 'none', border: 0, padding: 0 }}
                      >
                        <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
                          {conversation.title}
                        </p>
                        <p style={{ margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--faint)' }}>
                          {conversation.turns.length} turn
                          {conversation.turns.length === 1 ? '' : 's'} · {conversation.model || 'no model'}{' '}
                          · {new Date(conversation.updatedAt).toLocaleTimeString()}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteConversation(conversation.id)}
                        aria-label={`Delete chat "${conversation.title}"`}
                        className="ib hdel"
                      >
                        <Trash2 className="ic" aria-hidden="true" />
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
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setConfirmClear(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              style={{ background: 'rgb(var(--c-danger))', color: '#fff' }}
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
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.625, color: 'var(--muted)' }}>
          {conversations.length} conversation{conversations.length === 1 ? '' : 's'} will be removed
          from this device. Provider keys in the device vault are kept.
        </p>
      </Modal>

      {/* RESTORE PICKER — percakapan terhapus tinggal di folder trash server
          30 hari sebelum di-sweep otomatis; Empty trash menghapus semua. */}
      <Modal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        title="Restore deleted conversations"
        description="Deleted chats stay in the server trash for 30 days before being removed automatically."
        size="md"
        footer={
          <>
            <button
              type="button"
              className="btn ghost"
              disabled={trashBusy || trash.length === 0}
              onClick={async () => {
                setTrashBusy(true);
                try {
                  const resp = await fetch('/api/conversations/trash/empty', { method: 'POST' });
                  if (resp.ok) setTrash([]);
                } finally {
                  setTrashBusy(false);
                }
              }}
            >
              <Trash2 className="ic" aria-hidden="true" />
              Empty trash
            </button>
            <button type="button" className="btn ghost" onClick={() => setTrashOpen(false)}>
              Close
            </button>
          </>
        }
      >
        {trash.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            {trashBusy ? 'Loading…' : 'Trash is empty — nothing to restore.'}
          </p>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 0, margin: 0, listStyle: 'none', maxHeight: 320, overflowY: 'auto' }}>
            {trash.map((entry) => (
              <li key={entry.folder}>
                <div className="card hrow" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
                      {entry.title}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--faint)' }}>
                      {entry.turnCount} turn{entry.turnCount === 1 ? '' : 's'} · deleted{' '}
                      {new Date(entry.deletedAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={trashBusy}
                    onClick={async () => {
                      setTrashBusy(true);
                      try {
                        const resp = await fetch('/api/conversations/trash/restore', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ folder: entry.folder }),
                        });
                        if (resp.ok) {
                          setTrash((rows) => rows.filter((row) => row.folder !== entry.folder));
                          showNotice('conversations.restored');
                          void refreshConversationList();
                        }
                      } finally {
                        setTrashBusy(false);
                      }
                    }}
                  >
                    <RotateCcw className="ic" aria-hidden="true" />
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
