import { useEffect, useMemo, useState } from 'react';
import { History, Images, Pencil, Search, Trash2 } from './icons';

import { useStore } from '../store/useStore';
import type { ImageSession } from '../types';
import { EmptyState, cx } from './ui';

/** Groups sessions by calendar day, newest first (HistoryView's mechanism). */
function groupByDay(sessions: ImageSession[]) {
  const groups = new Map<string, ImageSession[]>();
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  for (const session of sorted) {
    const date = new Date(session.updatedAt);
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
    bucket.push(session);
    groups.set(key, bucket);
  }
  return groups;
}

/** One session card: click opens it in the studio; hover shows rename/delete. */
function SessionRow({ session }: { session: ImageSession }) {
  const selectImageSession = useStore((state) => state.selectImageSession);
  const setView = useStore((state) => state.setView);
  const deleteImageSession = useStore((state) => state.deleteImageSession);
  const renameImageSession = useStore((state) => state.renameImageSession);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.label);

  const openSession = () => {
    selectImageSession(session.id);
    setView('imagestudio');
  };

  const commitRename = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== session.label) {
      void renameImageSession(session.id, draft);
    }
  };

  return (
    <div
      className={cx(
        'group flex items-center gap-2 rounded-card border border-hairline bg-surface px-3.5 py-3',
        'transition-colors hover:border-accent/40 hover:bg-elevated',
      )}
    >
      {editing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              setEditing(false);
              setDraft(session.label);
            }
          }}
          aria-label={`Rename session "${session.label}"`}
          className="field min-w-0 flex-1"
        />
      ) : (
        <button type="button" onClick={openSession} className="min-w-0 flex-1 text-left">
          <p className="truncate text-[13.5px] font-medium text-ink">{session.label}</p>
          <p className="mt-0.5 truncate text-[11.5px] text-faint">
            {session.items.length} image{session.items.length === 1 ? '' : 's'} ·{' '}
            {new Date(session.updatedAt).toLocaleString()}
          </p>
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          setDraft(session.label);
          setEditing(true);
        }}
        aria-label={`Rename session "${session.label}"`}
        className="icon-button h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void deleteImageSession(session.id)}
        aria-label={`Delete session "${session.label}"`}
        className="icon-button h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Image Studio history: every generation session, grouped by day and
 * searchable — the same full-page mechanism as the Chat History view (click a
 * session to open it in the studio; rename/delete on the card).
 */
export function ImageHistoryView() {
  const sessions = useStore((state) => state.imageSessions);
  const loadImageSessions = useStore((state) => state.loadImageSessions);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void loadImageSessions();
  }, [loadImageSessions]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => session.label.toLowerCase().includes(needle));
  }, [sessions, query]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const imageCount = useMemo(
    () => sessions.reduce((total, session) => total + session.items.length, 0),
    [sessions],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h2 className="text-2xl font-normal tracking-tight text-ink">Image History</h2>
        <p className="mt-1 text-sm text-muted">
          {sessions.length} session{sessions.length === 1 ? '' : 's'} ·{' '}
          {imageCount} image{imageCount === 1 ? '' : 's'} stored on this device.
        </p>
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
          placeholder="Search session names"
          aria-label="Search sessions"
          className="field pl-9"
        />
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={<Images className="h-5 w-5" />}
          title="No sessions yet"
          description="Generate an image in the Image Studio and it will show up here."
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
              <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
                <History className="h-3 w-3" aria-hidden="true" />
                {label}
              </h3>
              <ul className="space-y-1.5">
                {items.map((session) => (
                  <li key={session.id}>
                    <SessionRow session={session} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
