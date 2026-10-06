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
import { Modal, cx } from './ui';
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

  // Only snapshots of THIS file (the vault query is a loose substring match).
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
      size="max-w-3xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="pill-button px-3 py-1.5 text-[12px] text-muted hover:text-ink"
          >
            Cancel
          </button>
          {fileEntries.length > 0 ? (
            <button
              type="button"
              onClick={() => void applyRestore()}
              disabled={!selectedEntry || busy || previewBusy}
              className="pill-button border border-accent/60 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-accent/20 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Restore this file
            </button>
          ) : entries !== null ? (
            <button
              type="button"
              onClick={() => void applyRemove()}
              disabled={busy}
              className="pill-button border border-danger/50 px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete file (created by agent)
            </button>
          ) : null}
        </>
      }
    >
      {error ? (
        <p className="text-[12px] text-danger">Could not load the vault: {error}</p>
      ) : entries === null ? (
        <p className="flex items-center gap-2 text-[12px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Reading vault snapshots…
        </p>
      ) : fileEntries.length === 0 ? (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-muted">
            No earlier state exists for this file — the agent <strong className="text-ink">created</strong> it,
            so there is nothing to restore to.
          </p>
          {!confirmRemove ? (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className="pill-button border border-hairline px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Delete this file instead…
            </button>
          ) : (
            <p className="rounded-control border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-[11.5px] leading-snug text-danger">
              Deleting removes the file from disk. A pre-delete snapshot is taken first, so the
              &quot;Restore file&quot; button on the marker can bring it back. Use the footer button to confirm.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <ul className="space-y-0.5">
            {fileEntries.map((entry) => {
              const info = labelFor(entry, turns);
              return (
                <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className={cx(
                        'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors',
                        selectedId === entry.id
                          ? 'border border-accent/50 bg-accent/10 text-ink'
                          : 'border border-transparent text-muted hover:bg-elevated/60 hover:text-ink',
                      )}
                    >
                      <RotateCcw className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-[11.5px]">{info.label}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-faint">
                        {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </button>
                </li>
              );
            })}
          </ul>
          <div className="rounded-control border border-hairline">
            <div className="border-b border-hairline px-2.5 py-1 text-[10.5px] font-medium text-faint">
              Preview — what restoring would change (dry-run)
            </div>
            <div className="inner-scroll max-h-72 overflow-auto">
              {previewBusy ? (
                <p className="flex items-center gap-2 px-2.5 py-2 text-[11.5px] text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Building preview…
                </p>
              ) : preview ? (
                preview.diff ? (
                  <SplitDiff diff={preview.diff} />
                ) : (
                  <p className="px-2.5 py-2 text-[11.5px] text-muted">{preview.text}</p>
                )
              ) : (
                <p className="px-2.5 py-2 text-[11.5px] text-faint">
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
