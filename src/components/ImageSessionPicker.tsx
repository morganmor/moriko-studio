import { useEffect } from 'react';
import { ImagePlus, Loader2, Trash2 } from './icons';

import { useStore } from '../store/useStore';
import './ui';

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
      className="pop open"
      style={{ width: 288, padding: 8, transformOrigin: 'top left' }}
    >
      <button
        type="button"
        onClick={() => void createImageSession()}
        className="mi"
        style={{ fontWeight: 500, fontSize: 13 }}
      >
        <ImagePlus className="ic" style={{ color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        New session
      </button>

      <div className="sep" />

      {sessions.length === 0 ? (
        <p style={{ padding: '12px 10px', fontSize: 12, lineHeight: 1.625, color: 'var(--faint)' }}>
          No sessions yet. Generate an image — a session is created automatically.
        </p>
      ) : (
        <ul style={{ maxHeight: 288, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: 0, margin: 0, listStyle: 'none' }}>
          {sessions.map((session) => (
            <li key={session.id} style={{ position: 'relative' }} className="pk-row">
              <button
                type="button"
                onClick={() => {
                  selectImageSession(session.id);
                  onClose();
                }}
                aria-current={session.id === activeId ? 'true' : undefined}
                className="mi"
                style={{
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  padding: '8px 10px 8px 10px',
                  paddingRight: 32,
                  background: session.id === activeId ? 'rgb(var(--c-elev))' : undefined,
                  color: session.id === activeId ? 'rgb(var(--c-ink))' : 'var(--muted)',
                }}
              >
                <span style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500 }}>{session.label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--faint)' }}>
                  {session.items.length} image{session.items.length === 1 ? '' : 's'} ·{' '}
                  {new Date(session.updatedAt).toLocaleString()}
                  {generating && session.id === gen.sessionId ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'rgb(var(--c-accent))' }}>
                      <Loader2 className="ic spin" aria-hidden="true" />
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
                className="ib sm hdel"
                style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
              >
                <Trash2 className="ic" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p style={{ margin: 0, borderTop: '1px solid var(--line)', padding: '8px 10px 0', fontSize: 11, lineHeight: 1.625, color: 'var(--faint)' }}>
        Temporary images auto-delete after the retention window. Images saved to the Gallery are
        permanent.
      </p>
    </div>
  );
}
