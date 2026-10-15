import { useEffect, useState } from 'react';
import { FolderOpen, Loader2, ShieldAlert, SquareTerminal } from './icons';

import { useStore } from '../store/useStore';
import { Modal } from './ui';

/**
 * SANDBOX PERMISSION dialog.
 *
 * When the agent wants to operate on paths OUTSIDE the active workspace, the
 * server pauses that tool call and emits a permission_request. Decision UI:
 * an INLINE .ask box inside the turn's run pill (desain Design2) — pill yang
 * menunggu render kotak ask sendiri; dialog modal ini HANYA fallback bila
 * pill turn yang menunggu tidak terlihat (turn sudah discroll jauh ke atas /
 * thread tidak merender pill). Not dismissible: agent is blocked waiting,
 * dan keputusan kosong auto-deny setelah 2 menit.
 */
export function AgentPermissionDialog() {
  const requests = useStore((state) => state.pendingPermissions);
  const resolvePermissionRequest = useStore((state) => state.resolvePermissionRequest);
  const [deciding, setDeciding] = useState(false);

  const request = requests[0];
  const decidingNow = async (approve: boolean, remember: boolean) => {
    if (!request || deciding) return;
    setDeciding(true);
    try {
      await resolvePermissionRequest(request.id, approve, remember);
    } finally {
      setDeciding(false);
    }
  };

  /** Mekanisme Design2: approval utama INLINE di run pill turn yang
   *  menunggu; modal ini hanya FALLBACK. Kotak inline dirender pill sebagai
   *  `[data-waiting-permission="<id>"]` pada commit pertamanya. Modal tampil
   *  HANYA bila kotak inline tidak ter-deteksi di DOM, dan deteksinya REAKTIF
   *  via MutationObserver — kalau kotak inline baru muncul setelah modal
   *  sempat render (pill mount belakangan), modal langsung menutup sehingga
   *  tidak pernah dobel dengan kotak inline di run-live. */
  const [inlineDetected, setInlineDetected] = useState(false);
  const [graceDone, setGraceDone] = useState(false);

  useEffect(() => {
    const id = request?.id;
    if (!id) {
      setInlineDetected(false);
      setGraceDone(false);
      return;
    }
    setInlineDetected(false);
    setGraceDone(false);
    const selector = `[data-waiting-permission="${id}"]`;
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      setInlineDetected(document.querySelector(selector) !== null);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    // Grace window singkat: beri pill waktu men-mount kotak inline di commit
    // pertama, mencegah modal kedip sekilas sebelum deteksi sempat berjalan.
    const timer = window.setTimeout(() => {
      if (!cancelled) setGraceDone(true);
    }, 150);
    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [request]);

  if (!request) return null;
  if (inlineDetected) return null;
  if (!graceDone) return null;

  return (
    <Modal
      open
      onClose={() => undefined}
      title="Sandbox permission required"
      size=""
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--faint)' }}>
            {requests.length > 1 ? `${requests.length} request(s) pending · ` : ''}
            Without a decision, this is automatically denied after 2 minutes.
          </span>
          <button
            type="button"
            className="btn danger sm"
            onClick={() => void decidingNow(false, false)}
            disabled={deciding}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn primary sm"
            onClick={() => void decidingNow(true, false)}
            disabled={deciding}
          >
            Allow once
          </button>
          <button
            type="button"
            className="btn sm"
            style={{ borderColor: 'rgb(var(--c-accent) / 0.4)', background: 'var(--c-accent-soft)', color: 'rgb(var(--c-ink))' }}
            onClick={() => void decidingNow(true, true)}
            disabled={deciding}
          >
            Allow for this session
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ marginTop: 2, borderRadius: 'var(--r-md)', background: 'rgb(var(--c-warn) / 0.1)', padding: 8 }}>
          <ShieldAlert className="ic" style={{ width: 20, height: 20, color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          {request.command ? (
            <>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
                The agent wants to run a command.
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
                Tool <code style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '1px 4px', fontSize: 12 }}>{request.tool}</code>{' '}
                will run the following command inside the workspace — review it before approving:
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
                The agent wants to access outside the workspace.
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
                Tool <code style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '1px 4px', fontSize: 12 }}>{request.tool}</code>{' '}
                will touch the following paths — outside the workspace root, so your approval is required:
              </p>
            </>
          )}
        </div>
      </div>

      {request.command ? (
        <div className="card" style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8, overflowWrap: 'break-word', borderRadius: 'var(--r-md)', padding: '8px 10px', fontFamily: 'var(--f-mono)', fontSize: 12.5, color: 'rgb(var(--c-ink))', borderColor: 'rgb(var(--c-warn) / 0.3)', background: 'rgb(var(--c-warn) / 0.05)' }}>
          <SquareTerminal className="ic" style={{ marginTop: 2, width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
          <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>{request.command}</span>
        </div>
      ) : (
        <ul style={{ margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4, listStyle: 'none' }}>
          {request.paths.map((path) => (
            <li
              key={path}
              className="card"
              style={{ display: 'flex', alignItems: 'center', gap: 8, overflowWrap: 'break-word', borderRadius: 'var(--r-md)', padding: '8px 10px', fontFamily: 'var(--f-mono)', fontSize: 12, color: 'rgb(var(--c-ink))', borderColor: 'rgb(var(--c-warn) / 0.3)', background: 'rgb(var(--c-warn) / 0.05)' }}
            >
              <FolderOpen className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
              {path}
            </li>
          ))}
        </ul>
      )}

      <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--faint)' }}>
        Workspace root: <span style={{ fontFamily: 'var(--f-mono)' }}>{request.root}</span>
      </p>

      {deciding ? (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }} role="status">
          <Loader2 className="ic spin" aria-hidden="true" />
          Sending decision…
        </div>
      ) : null}
    </Modal>
  );
}
