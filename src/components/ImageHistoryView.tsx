import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Search, Sparkles, Trash2 } from './icons';

import { useStore } from '../store/useStore';
import { brandEmptyHistorySvg } from '../lib/brandAssets';
import type { ImageSession, ImageSessionItem } from '../types';
import { EmptyState } from './ui';
import { ImageLightbox } from './ImageLightbox';

/** Groups sessions by calendar day, newest first (design day labels). */
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
          : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    const bucket = groups.get(key) ?? [];
    bucket.push(session);
    groups.set(key, bucket);
  }
  return groups;
}

/** Design time label: "14:05". */
const hm = (iso: string) => {
  const date = new Date(iso);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** Hover overlay actions shared by every card (design .acts buttons). */
function SessionActions({ session, onRename }: { session: ImageSession; onRename: () => void }) {
  const selectImageSession = useStore((state) => state.selectImageSession);
  const setView = useStore((state) => state.setView);
  const deleteImageSession = useStore((state) => state.deleteImageSession);

  const openInStudio = () => {
    selectImageSession(session.id);
    setView('imagestudio');
  };

  return (
    <div className="tbtns">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openInStudio();
        }}
        aria-label={`Open "${session.label}" in Image Studio`}
      >
        <Sparkles className="ic" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRename();
        }}
        aria-label={`Rename session "${session.label}"`}
      >
        <Pencil className="ic" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void deleteImageSession(session.id);
        }}
        aria-label={`Delete session "${session.label}"`}
      >
        <Trash2 className="ic" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Inline rename field pinned to the card overlay (design .field). */
function RenameInput({
  session,
  draft,
  onDraft,
  onCommit,
  onCancel,
}: {
  session: ImageSession;
  draft: string;
  onDraft: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={(event) => onDraft(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          onCommit();
        } else if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Rename session "${session.label}"`}
      className="tren"
    />
  );
}

/**
 * One image card (design .card from image-viewer.html): a 4:3 tile that
 * opens the lightbox; hover reveals the session caption plus open-in-
 * studio / rename / delete.
 */
function ImageCard({
  session,
  item,
  editing,
  draft,
  onDraft,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onPreview,
}: {
  session: ImageSession;
  item: ImageSessionItem;
  editing: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onPreview: (url: string) => void;
}) {
  const label = item.prompt || session.label;

  return (
    <div
      className="icard"
      role="button"
      tabIndex={0}
      aria-label={`Open image — ${label.slice(0, 60)}`}
      onClick={() => onPreview(item.url)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPreview(item.url);
        }
      }}
    >
      <img src={item.url} alt="" loading="lazy" draggable={false} />
      <div className="tov">
        <SessionActions session={session} onRename={onStartRename} />
        {editing ? (
          <RenameInput
            session={session}
            draft={draft}
            onDraft={onDraft}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="tcap" title={session.label}>
            {hm(session.updatedAt)} · {label}
          </span>
        )}
      </div>
    </div>
  );
}

/** Placeholder for a session that has no images yet (New session flow). */
function GhostCard({
  session,
  editing,
  draft,
  onDraft,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  session: ImageSession;
  editing: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  return (
    <div className="icard ghost">
      <b>{session.label}</b>
      <span>No images yet</span>
      <div className="tov">
        <SessionActions session={session} onRename={onStartRename} />
        {editing ? (
          <RenameInput
            session={session}
            draft={draft}
            onDraft={onDraft}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Image History — the design's card grid (design/image-viewer.html): a
 * page-head with a live count and a New session action, day groups of 4:3
 * image cards, click → lightbox browsing every visible image. Search,
 * rename and delete stay available on the card overlay.
 */
export function ImageHistoryView() {
  const sessions = useStore((state) => state.imageSessions);
  const loadImageSessions = useStore((state) => state.loadImageSessions);
  const createImageSession = useStore((state) => state.createImageSession);
  const renameImageSession = useStore((state) => state.renameImageSession);
  const requestImageStudioPrompt = useStore((state) => state.requestImageStudioPrompt);
  const setView = useStore((state) => state.setView);
  const galleryImages = useStore((state) => state.galleryImages);
  const addToGallery = useStore((state) => state.addToGallery);
  const removeFromGallery = useStore((state) => state.removeFromGallery);
  const [query, setQuery] = useState('');
  /** Open lightbox preview: current url + every visible image. */
  const [preview, setPreview] = useState<{ url: string; urls: string[] } | null>(null);
  /** Inline rename target; url: null marks the session's ghost card. */
  const [editing, setEditing] = useState<{ id: string; url: string | null } | null>(null);
  const [draft, setDraft] = useState('');

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

  /** Flat browse list — same order as the grouped cards (design viewer). */
  const allUrls = useMemo(
    () => filtered.flatMap((session) => session.items.map((item) => item.url)),
    [filtered],
  );

  /** Viewer fields by url: prompt + session label (design title/prompt). */
  const infoByUrl = useMemo(() => {
    const map = new Map<string, { prompt: string; label: string }>();
    for (const session of filtered) {
      for (const item of session.items) {
        if (!map.has(item.url)) map.set(item.url, { prompt: item.prompt, label: session.label });
      }
    }
    return map;
  }, [filtered]);

  // Deleting a session shrinks the list — drop stale preview/rename targets.
  useEffect(() => {
    if (preview && !allUrls.includes(preview.url)) setPreview(null);
    if (editing && !sessions.some((session) => session.id === editing.id)) setEditing(null);
  }, [allUrls, editing, preview, sessions]);

  const openPreview = (url: string) => {
    if (!allUrls.includes(url)) return;
    setPreview({ url, urls: allUrls });
  };

  const startRename = (session: ImageSession, url: string | null) => {
    setDraft(session.label);
    setEditing({ id: session.id, url });
  };

  const commitRename = () => {
    const target = editing;
    setEditing(null);
    if (!target) return;
    const trimmed = draft.trim();
    const current = sessions.find((session) => session.id === target.id);
    if (trimmed && current && trimmed !== current.label) {
      void renameImageSession(target.id, trimmed);
    }
  };

  const cancelRename = () => {
    if (editing) {
      const current = sessions.find((session) => session.id === editing.id);
      setDraft(current?.label ?? '');
    }
    setEditing(null);
  };

  const startNewSession = () => {
    void (async () => {
      try {
        await createImageSession();
        setView('imagestudio');
      } catch {
      }
    })();
  };

  return (
    <div className="page view-enter">
      <div className="page-head">
        <div>
          <h2>Image history</h2>
          <p>
            {sessions.length} session{sessions.length === 1 ? '' : 's'} · {imageCount} image
            {imageCount === 1 ? '' : 's'} · Select an image to open the viewer.
          </p>
        </div>
        <div className="acts">
          <button type="button" className="btn ghost" onClick={startNewSession}>
            <Plus className="ic" aria-hidden="true" />
            New session
          </button>
        </div>
      </div>

      <div style={{ position: 'relative', marginBottom: 20 }}>
        <Search
          style={{ pointerEvents: 'none', position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: 'var(--faint)' }}
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search session names"
          aria-label="Search sessions"
          className="field"
          style={{ paddingLeft: 36 }}
        />
      </div>

      {sessions.length === 0 ? (
        <div className="empty">
          <div className="eic">
            <span
              className="ic"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: brandEmptyHistorySvg }}
            />
          </div>
          <b>No image sessions yet</b>
          <p>Sessions appear after your first generation in Image Studio.</p>
          <button type="button" className="btn sm primary" onClick={startNewSession}>
            <Plus className="ic" aria-hidden="true" />
            New session
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search className="ic" style={{ width: 20, height: 20 }} />}
          title="No matches"
          description={`Nothing matched “${query}”. Try a different term.`}
        />
      ) : (
        <>
          {[...groups.entries()].map(([label, group]) => (
            <section className="hg" key={label}>
              <div className="hg-h">{label}</div>
              <div className="icards">
                {group.flatMap((session) =>
                  session.items.length === 0
                    ? [
                        <GhostCard
                          key={`${session.id}:empty`}
                          session={session}
                          editing={
                            editing !== null && editing.id === session.id && editing.url === null
                          }
                          draft={draft}
                          onDraft={setDraft}
                          onStartRename={() => startRename(session, null)}
                          onCommitRename={commitRename}
                          onCancelRename={cancelRename}
                        />,
                      ]
                    : session.items.map((item) => (
                        <ImageCard
                          key={item.url}
                          session={session}
                          item={item}
                          editing={
                            editing !== null &&
                            editing.id === session.id &&
                            editing.url === item.url
                          }
                          draft={draft}
                          onDraft={setDraft}
                          onStartRename={() => startRename(session, item.url)}
                          onCommitRename={commitRename}
                          onCancelRename={cancelRename}
                          onPreview={openPreview}
                        />
                      )),
                )}
              </div>
            </section>
          ))}
        </>
      )}

      {preview ? (
        <ImageLightbox
          url={preview.url}
          urls={preview.urls}
          onNavigate={(url) => setPreview((state) => (state ? { ...state, url } : state))}
          title={infoByUrl.get(preview.url)?.label}
          prompt={infoByUrl.get(preview.url)?.prompt}
          onUsePrompt={(value) => {
            requestImageStudioPrompt(value);
            setView('imagestudio');
          }}
          saved={galleryImages.includes(preview.url)}
          onToggleSave={() => {
            if (galleryImages.includes(preview.url)) void removeFromGallery(preview.url);
            else void addToGallery([preview.url]);
          }}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
