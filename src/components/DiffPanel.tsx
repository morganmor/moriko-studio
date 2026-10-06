/**
 * DiffPanel — the 4th right-dock panel (Config | Tree | Addons | Diff).
 *
 * Clicking a turn's ±Lines badge opens this panel scoped to that turn. It
 * lists every file the agent created / edited / deleted (derived from the
 * tool segments' persisted diffs), shows the change SIDE-BY-SIDE (SplitDiff),
 * and lets the user restore ONE file to an earlier turn's state via the file
 * vault (DiffRestoreModal) — never a blind full-conversation rollback.
 */
import { useEffect, useMemo, useState } from 'react';

import { RotateCcw } from './icons';
import { RightDockCloseButton, RightDockSlot, cx } from './ui';
import { SplitDiff } from './SplitDiff';
import { DiffRestoreModal } from './DiffRestoreModal';
import { useStore } from '../store/useStore';
import { parseUnifiedDiff } from '../lib/diffParse';
import { diffStat } from '../lib/diffStat';
import type { Turn } from '../types';

export type FileStatus = 'created' | 'edited' | 'deleted';

export interface FileChangeRow {
  key: string;
  turnId: string;
  turnNumber: number;
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  /** Full unified diff string of the segment (SplitDiff filters per path). */
  diff?: string;
}

/** Thread numbering replica: user turns count up; the assistant turn that
 *  answers carries the same number (see Thread turnNumbers). */
function turnNumberAt(turns: Turn[], index: number): number {
  let counter = 0;
  for (let i = 0; i <= index; i += 1) {
    const turn = turns[i];
    if (turn.kind !== undefined) continue;
    if (turn.role === 'user') counter += 1;
  }
  return counter;
}

/** Derives the per-file change list from persisted tool segments. */
export function collectFileChanges(turns: Turn[]): FileChangeRow[] {
  const rows: FileChangeRow[] = [];
  turns.forEach((turn, index) => {
    if (turn.kind !== undefined || turn.role !== 'assistant') return;
    const turnNumber = turnNumberAt(turns, index);
    (turn.segments ?? []).forEach((segment, segmentIndex) => {
      if (segment.type !== 'tool') return;
      const summary = segment.summary ?? '';
      // Pre-pass / preview results never touched the disk.
      if (summary.startsWith('dryRun')) return;

      if (segment.diff && segment.diff.includes('--- a/')) {
        const status: FileStatus = /^Created /.test(summary)
          ? 'created'
          : /^Deleted /.test(summary)
            ? 'deleted'
            : 'edited';
        for (const file of parseUnifiedDiff(segment.diff)) {
          rows.push({
            key: `${turn.id}:${segmentIndex}:${file.path}`,
            turnId: turn.id,
            turnNumber,
            path: file.path,
            status,
            added: file.added,
            removed: file.removed,
            diff: segment.diff,
          });
        }
        return;
      }
      if (summary.startsWith('Deleted ')) {
        // Delete carries no diff — parse the path out of the result text.
        const rest = summary.slice('Deleted '.length).split(/ Previous version| NOT vaulted/)[0];
        const path = rest.replace(/ \(directory, recursive\)\.$/, '').replace(/\.$/, '').trim();
        if (path) {
          rows.push({
            key: `${turn.id}:${segmentIndex}:${path}`,
            turnId: turn.id,
            turnNumber,
            path,
            status: 'deleted',
            added: 0,
            removed: segment.diffstat?.removed ?? 0,
          });
        }
        return;
      }
      // Diff-less edit fallback (older server builds): counts only.
      const stat = segment.diffstat ?? (segment.diff ? diffStat(segment.diff) : null);
      if (!stat) return;
      const match = /--- a\/(.+)$/m.exec(segment.diff ?? '');
      const path = match?.[1]?.trim() ?? summary.slice(0, 60);
      rows.push({
        key: `${turn.id}:${segmentIndex}:${path}`,
        turnId: turn.id,
        turnNumber,
        path,
        status: 'edited',
        added: stat.added,
        removed: stat.removed,
      });
    });
  });
  return rows;
}

const STATUS_DOT: Record<FileStatus, string> = {
  created: 'bg-success',
  edited: 'bg-accent',
  deleted: 'bg-danger',
};
const STATUS_LABEL: Record<FileStatus, string> = {
  created: 'created',
  edited: 'edited',
  deleted: 'deleted',
};

export function DiffPanel({ width: _width }: { width?: number }) {
  const conversation = useStore((state) => state.activeConversation());
  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const setRightPanelMode = useStore((state) => state.setRightPanelMode);
  const diffPanelTurnId = useStore((state) => state.diffPanelTurnId);
  const setDiffPanelTurnId = useStore((state) => state.setDiffPanelTurnId);

  const turns = conversation?.turns ?? [];
  const changes = useMemo(() => collectFileChanges(turns), [turns]);
  const turnIds = useMemo(() => [...new Set(changes.map((row) => row.turnId))], [changes]);

  const [scope, setScope] = useState<string>(diffPanelTurnId ?? 'all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [restorePath, setRestorePath] = useState<string | null>(null);

  // Badge click sets the store scope → mirror it into the local selector.
  useEffect(() => {
    if (diffPanelTurnId) setScope(diffPanelTurnId);
  }, [diffPanelTurnId]);

  const scopedRows = scope === 'all' ? changes : changes.filter((row) => row.turnId === scope);
  const selected = scopedRows.find((row) => row.key === selectedKey) ?? scopedRows[0] ?? null;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <RightDockCloseButton />
      </div>

      {/* Scope: which turn */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <select
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
            setDiffPanelTurnId(event.target.value === 'all' ? null : event.target.value);
            setSelectedKey(null);
          }}
          className="field w-full text-[12px]"
          aria-label="Diff scope"
        >
          <option value="all">All turns · {changes.length} change{changes.length === 1 ? '' : 's'}</option>
          {turnIds.map((turnId) => {
            const rows = changes.filter((row) => row.turnId === turnId);
            const added = rows.reduce((sum, row) => sum + row.added, 0);
            const removed = rows.reduce((sum, row) => sum + row.removed, 0);
            return (
              <option key={turnId} value={turnId}>
                Turn {rows[0]?.turnNumber ?? '?'} · +{added} −{removed} · {rows.length} file
                {rows.length === 1 ? '' : 's'}
              </option>
            );
          })}
        </select>
      </div>

      {/* File list */}
      <div className="max-h-52 shrink-0 overflow-y-auto px-3 py-2">
        {scopedRows.length === 0 ? (
          <p className="px-1 py-2 text-[11.5px] leading-snug text-faint">
            No file changes recorded for this scope yet.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {scopedRows.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => setSelectedKey(row.key)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left transition-colors',
                    selected?.key === row.key ? 'bg-elevated text-ink' : 'text-muted hover:bg-elevated/60 hover:text-ink',
                  )}
                >
                  <span
                    className={cx('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[row.status])}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {row.path}
                  </span>
                  <span className="shrink-0 text-[10px] text-faint">{STATUS_LABEL[row.status]}</span>
                  <span className="shrink-0 text-[10px] font-medium tabular-nums">
                    <span className="text-success">+{row.added}</span>{' '}
                    <span className="text-danger">−{row.removed}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Detail */}
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
              {selected.path}
            </span>
              <button
                type="button"
                onClick={() => setRestorePath(selected.path)}
                className="pill-button border border-hairline px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Restore file…
              </button>
          </div>
          <div className="inner-scroll min-h-0 flex-1 overflow-auto">
            <SplitDiff diff={selected.diff} onlyPath={selected.path} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="text-center text-[11.5px] leading-snug text-faint">
            Select a file above to inspect its changes line by line.
          </p>
        </div>
      )}

      {conversation && restorePath ? (
        <DiffRestoreModal
          conversationId={conversation.id}
          path={restorePath}
          onClose={() => setRestorePath(null)}
        />
      ) : null}
    </div>
  );
}
