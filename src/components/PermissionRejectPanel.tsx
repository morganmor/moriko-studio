import { useState } from 'react';


export function PermissionRejectPanel({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div style={{ marginTop: 8, width: '100%' }}>
      <textarea
        rows={2}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional — leave empty to reject without one)…"
        aria-label="Rejection reason"
        disabled={busy}
        style={{
          width: '100%',
          resize: 'vertical',
          borderRadius: 'var(--r-md)',
          border: '1px solid rgb(var(--c-hairline))',
          background: 'rgb(var(--c-canvas))',
          padding: '8px 10px',
          fontSize: 13,
          color: 'rgb(var(--c-ink))',
        }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger sm"
          onClick={() => onSubmit(reason)}
          disabled={busy}
        >
          Confirm reject
        </button>
      </div>
    </div>
  );
}
