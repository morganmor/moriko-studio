import { useEffect } from 'react';
import { ImagePlus, Loader2, Trash2 } from './icons';

import { useStore } from '../store/useStore';
import { cx } from './ui';

/**
 * The Image Studio session picker: the dropdown that lists every generation
 * session so the user can continue one, delete it, or start a new one. Used
 * as the sidebar popover (Image Studio ▸ History) and as an inline panel
 * inside the studio itself.
 */
export function ImageSessionPicker({ onClose }: { onClose: () => void }) {
  const sessions = useStore((state) => state.imageSessions);
  const activeId = useStore((state) => state.activeImageSessionId);
  const selectImageSession = useStore((state) => state.selectImageSession);
  const createImageSession = useStore((state) => state.createImageSession);
  const deleteImageSession = useStore((state) => state.deleteImageSession);
  const gen = useStore((state) => state.imageGen);
  const generating = gen.phase === 'submitting' || gen.phase === 'generating';

  useEffect(() => {
    void useStore.getState().loadImageSessions();
  }, []);

  return (
    <div
      role="menu"
      aria-label="Image Studio sessions"
      className="w-72 rounded-card border border-hairline bg-surface p-2 shadow-xl"
    >
      <button
        type="button"
        onClick={() => void createImageSession()}
        className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-elevated/60"
      >
        <ImagePlus className="h-4 w-4 text-accent" aria-hidden="true" />
        New session
      </button>

      <div className="my-1 h-px bg-hairline" />

      {sessions.length === 0 ? (
        <p className="px-2.5 py-3 text-[12px] leading-relaxed text-faint">
          No sessions yet. Generate an image — a session is created automatically.
        </p>
      ) : (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto">
          {sessions.map((session) => (
            <li key={session.id} className="group relative">
              <button
                type="button"
                onClick={() => {
                  selectImageSession(session.id);
                  onClose();
                }}
                aria-current={session.id === activeId ? 'true' : undefined}
                className={cx(
                  'flex w-full flex-col items-start gap-0.5 rounded-control px-2.5 py-2 pr-8 text-left transition-colors',
                  session.id === activeId
                    ? 'bg-elevated text-ink'
                    : 'text-muted hover:bg-elevated/60 hover:text-ink',
                )}
              >
                <span className="w-full truncate text-[13px] font-medium">{session.label}</span>
                <span className="flex items-center gap-1.5 text-[11px] text-faint">
                  {session.items.length} image{session.items.length === 1 ? '' : 's'} ·{' '}
                  {new Date(session.updatedAt).toLocaleString()}
                  {generating && session.id === gen.sessionId ? (
                    <span className="flex items-center gap-1 text-accent">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      generating…
                    </span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete session "${session.label}"? Its temporary images are removed too (Gallery copies are kept).`,
                    )
                  ) {
                    void deleteImageSession(session.id);
                  }
                }}
                aria-label={`Delete session "${session.label}"`}
                className="icon-button absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-1 border-t border-hairline px-2.5 pt-2 text-[11px] leading-relaxed text-faint">
        Temporary images auto-delete after the retention window. Images saved to the Gallery are
        permanent.
      </p>
    </div>
  );
}
