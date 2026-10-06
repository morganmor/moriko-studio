import { useState } from 'react';
import { FolderOpen, Loader2, ShieldAlert, SquareTerminal } from './icons';

import { useStore } from '../store/useStore';
import { Modal } from './ui';

/**
 * SANDBOX PERMISSION dialog.
 *
 * When the agent wants to operate on paths OUTSIDE the active workspace, the
 * server pauses that tool call and emits a permission_request. This dialog is
 * the user's decision point: Deny, Allow once, or Allow for this session
 * (the exact paths are remembered in server memory only, cleared on restart).
 *
 * Deliberately not dismissible via Escape/backdrop: the agent is blocked
 * waiting, and an undecided request auto-denies after 2 minutes.
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

  if (!request) return null;

  return (
    <Modal
      open
      onClose={() => undefined}
      title="Sandbox permission required"
      size="max-w-lg"
      footer={
        <>
          <span className="mr-auto text-[11px] text-faint">
            {requests.length > 1 ? `${requests.length} request(s) pending · ` : ''}
            Without a decision, this is automatically denied after 2 minutes.
          </span>
          <button
            type="button"
            className="pill-button border border-danger/40 text-danger hover:bg-danger/10"
            onClick={() => void decidingNow(false, false)}
            disabled={deciding}
          >
            Deny
          </button>
          <button
            type="button"
            className="pill-button bg-accent text-accent-ink hover:brightness-110"
            onClick={() => void decidingNow(true, false)}
            disabled={deciding}
          >
            Allow once
          </button>
          <button
            type="button"
            className="pill-button border border-accent/40 bg-accent-soft text-ink hover:brightness-105"
            onClick={() => void decidingNow(true, true)}
            disabled={deciding}
          >
            Allow for this session
          </button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-control bg-warning/10 p-2">
          <ShieldAlert className="h-5 w-5 text-warning" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          {request.command ? (
            <>
              <p className="text-sm font-medium text-ink">
                The agent wants to run a command.
              </p>
              <p className="mt-1 text-[13px] text-muted">
                Tool <code className="rounded bg-elevated px-1 py-0.5 text-[12px]">{request.tool}</code>{' '}
                will run the following command inside the workspace — review it before approving:
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-ink">
                The agent wants to access outside the workspace.
              </p>
              <p className="mt-1 text-[13px] text-muted">
                Tool <code className="rounded bg-elevated px-1 py-0.5 text-[12px]">{request.tool}</code>{' '}
                will touch the following paths — outside the workspace root, so your approval is required:
              </p>
            </>
          )}
        </div>
      </div>

      {request.command ? (
        <div className="mt-3 flex items-start gap-2 break-all rounded-control border border-warning/30 bg-warning/5 px-2.5 py-2 font-mono text-[12.5px] text-ink">
          <SquareTerminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 break-all">{request.command}</span>
        </div>
      ) : (
        <ul className="mt-3 space-y-1">
          {request.paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-2 break-all rounded-control border border-warning/30 bg-warning/5 px-2.5 py-2 font-mono text-[12px] text-ink"
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
              {path}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[11px] text-faint">
        Workspace root: <span className="font-mono">{request.root}</span>
      </p>

      {deciding ? (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-muted" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Sending decision…
        </div>
      ) : null}
    </Modal>
  );
}
