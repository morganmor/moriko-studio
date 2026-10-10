/**
 * DiffRestoreModal — per-file restore-point picker backed by the FILE VAULT.
 *
 * Every agent edit/delete snapshotted the file first, so the snapshots ARE
 * the per-turn states. Each snapshot is labelled by the turn whose edit it
 * protected against ("before edit in Turn N" — i.e. the file as it stood at
 * the end of the previous turn). Restoring one file NEVER rolls back the
 * conversation or other files.
 *
 * The preview is a dry-run (read-only); the apply takes a pre-restore
 * snapshot first, so even THIS restore is undoable — and it lands in the
 * thread as a 'restore' marker turn carrying the resulting diff.
 */
import { useEffect, useMemo, useState } from 'react';

import { Loader2, RotateCcw, Trash2 } from './icons';
import { Modal } from './ui';
import { SplitDiff } from './SplitDiff';
import {
  fetchVaultSnapshots,
  previewVaultRestore,
  removeCreatedFile,
  restoreVaultSnapshot,
  type VaultSnapshotMeta,
} from '../lib/api';
import { useStore } from '../store/useStore';
import { uid } from '../lib/storage';
import type { Turn } from '../types';

/** Snapshot timestamps map to turns; legacy snapshots lack turnId. */
function labelFor(entry: VaultSnapshotMeta, turns: Turn[]): { label: string; turnNumber: number | null } {
  let counter = 0;
  let matched: number | null = null;
  for (const turn of turns) {
    if (turn.kind !== undefined) continue;
    if (turn.role === 'user') counter += 1;
    if (turn.createdAt <= entry.createdAt) matched = counter;
    else break;
  }
  const op =
    entry.operation === 'edit_file'
      ? 'edit'
      : entry.operation === 'apply_patch'
        ? 'patch'
        : entry.operation === 'delete'
          ? 'delete'
          : entry.operation === 'write'
            ? 'write'
            : entry.operation;
  return {
    label: matched ? `Before ${op} in Turn ${matched}` : `Before ${op} (${new Date(entry.createdAt).toLocaleString()})`,
    turnNumber: matched,
  };
}

export function DiffRestoreModal({
  conversationId,
  path,
  onClose,
}: {
  conversationId: string;
  path: string;
  onClose: () => void;
}) {
  const turns = useStore((state) => state.conversations.find((entry) => entry.id === conversationId)?.turns ?? []);
  const appendTurn = useStore((state) => state.appendTurn);
  const showNotice = useStore((state) => state.showNotice);

  const [entries, setEntries] = useState<VaultSnapshotMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ diff?: string; text: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const fileEntries = useMemo(() => {
    if (!entries) return [];
    const norm = (value: string) => value.replace(/\\/g, '/').toLowerCase();
    const target = norm(path);
    return entries.filter((entry) => norm(entry.originalPath).endsWith(`/${target}`) || norm(entry.originalPath) === target);
  }, [entries, path]);

  useEffect(() => {
    let cancelled = false;
    void fetchVaultSnapshots(conversationId, path.split(/[\\/]/).pop() ?? path)
      .then((snapshots) => {
        if (!cancelled) setEntries(snapshots);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, path]);

  // Dry-run preview whenever the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewBusy(true);
    void previewVaultRestore(conversationId, selectedId)
      .then((result) => {
        if (!cancelled) setPreview({ diff: result.diff, text: result.text });
      })
      .catch((err: unknown) => {
        if (!cancelled) setPreview({ text: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, selectedId]);

  const selectedEntry = fileEntries.find((entry) => entry.id === selectedId) ?? null;
  const selectedLabel = selectedEntry ? labelFor(selectedEntry, turns) : null;

  const applyRestore = async () => {
    if (!selectedEntry) return;
    setBusy(true);
    try {
      const result = await restoreVaultSnapshot(conversationId, selectedEntry.id);
      const label = selectedLabel?.label ?? 'earlier state';
      appendTurn(conversationId, {
        id: uid('turn'),
        role: 'assistant',
        kind: 'restore',
        content: '',
        createdAt: Date.now(),
        restoreMeta: {
          entries: [
            {
              path,
              snapshotId: selectedEntry.id,
              label,
              operation: selectedEntry.operation,
              previousEntryId: result.previousEntryId,
            },
          ],
          diff: result.diff,
          diffstat: result.diffstat,
        },
      });
      showNotice('diff.restoreDone', { file: path, label });
      onClose();
    } catch (err: unknown) {
      showNotice('diff.restoreFailed', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const applyRemove = async () => {
    setBusy(true);
    try {
      const result = await removeCreatedFile(conversationId, path);
      appendTurn(conversationId, {
        id: uid('turn'),
        role: 'assistant',
        kind: 'restore',
        content: '',
        createdAt: Date.now(),
        restoreMeta: {
          entries: [
            {
              path,
              snapshotId: result.snapshotId ?? '',
              label: 'file removed (created by the agent)',
              operation: 'remove-created',
            },
          ],
          diff: result.diff,
          diffstat: result.diffstat,
        },
      });
      showNotice('diff.removeDone', { file: path });
      onClose();
    } catch (err: unknown) {
      showNotice('diff.restoreFailed', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Restore file"
      description={`Choose the state to return ${path} to. Only THIS file changes — and the restore is undoable.`}
      size="wide"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn ghost sm"
          >
            Cancel
          </button>
          {fileEntries.length > 0 ? (
            <button
              type="button"
              onClick={() => void applyRestore()}
              disabled={!selectedEntry || busy || previewBusy}
              className="btn sm"
              style={{ borderColor: 'rgb(var(--c-accent) / 0.6)', background: 'rgb(var(--c-accent) / 0.1)', color: 'rgb(var(--c-ink))' }}
            >
              {busy ? (
                <Loader2 className="ic spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="ic" aria-hidden="true" />
              )}
              Restore this file
            </button>
          ) : entries !== null ? (
            <button
              type="button"
              onClick={() => void applyRemove()}
              disabled={busy}
              className="btn danger sm"
            >
              <Trash2 className="ic" aria-hidden="true" />
              Delete file (created by agent)
            </button>
          ) : null}
        </>
      }
    >
      {error ? (
        <p style={{ margin: 0, fontSize: 12, color: 'rgb(var(--c-danger))' }}>Could not load the vault: {error}</p>
      ) : entries === null ? (
        <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
          <Loader2 className="ic spin" aria-hidden="true" />
          Reading vault snapshots…
        </p>
      ) : fileEntries.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.625, color: 'var(--muted)' }}>
            No earlier state exists for this file — the agent <strong style={{ color: 'rgb(var(--c-ink))' }}>created</strong> it,
            so there is nothing to restore to.
          </p>
          {!confirmRemove ? (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className="btn ghost xs"
              style={{ alignSelf: 'flex-start', color: 'var(--muted)' }}
            >
              <Trash2 className="ic" aria-hidden="true" />
              Delete this file instead…
            </button>
          ) : (
            <p style={{ margin: 0, borderRadius: 'var(--r-md)', border: '1px solid rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.05)', padding: '6px 10px', fontSize: 11.5, lineHeight: 1.375, color: 'rgb(var(--c-danger))' }}>
              Deleting removes the file from disk. A pre-delete snapshot is taken first, so the
              &quot;Restore file&quot; button on the marker can bring it back. Use the footer button to confirm.
            </p>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 0, margin: 0, listStyle: 'none' }}>
            {fileEntries.map((entry) => {
              const info = labelFor(entry, turns);
              return (
                <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className="mi"
                      style={{
                        border: `1px solid ${selectedId === entry.id ? 'rgb(var(--c-accent) / 0.5)' : 'transparent'}`,
                        background: selectedId === entry.id ? 'rgb(var(--c-accent) / 0.1)' : undefined,
                        padding: '6px 8px',
                      }}
                    >
                      <RotateCcw className="ic" style={{ width: 12, height: 12, flexShrink: 0 }} aria-hidden="true" />
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 }}>{info.label}</span>
                      <span style={{ flexShrink: 0, fontSize: 10, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}>
                        {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </button>
                </li>
              );
            })}
          </ul>
          <div className="card" style={{ borderRadius: 'var(--r-md)', padding: 0, overflow: 'hidden' }}>
            <div style={{ borderBottom: '1px solid var(--line)', padding: '4px 10px', fontSize: 10.5, fontWeight: 500, color: 'var(--faint)' }}>
              Preview — what restoring would change (dry-run)
            </div>
            <div className="inner-scroll" style={{ maxHeight: 288, overflow: 'auto' }}>
              {previewBusy ? (
                <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontSize: 11.5, color: 'var(--muted)' }}>
                  <Loader2 className="ic spin" aria-hidden="true" />
                  Building preview…
                </p>
              ) : preview ? (
                preview.diff ? (
                  <SplitDiff diff={preview.diff} />
                ) : (
                  <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, color: 'var(--muted)' }}>{preview.text}</p>
                )
              ) : (
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, color: 'var(--faint)' }}>
                  Pick a restore point above to preview it.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
