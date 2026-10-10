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
  created: 'rgb(var(--c-ok))',
  edited: 'rgb(var(--c-accent))',
  deleted: 'rgb(var(--c-danger))',
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

  useEffect(() => {
    if (diffPanelTurnId) setScope(diffPanelTurnId);
  }, [diffPanelTurnId]);

  const scopedRows = scope === 'all' ? changes : changes.filter((row) => row.turnId === scope);
  const selected = scopedRows.find((row) => row.key === selectedKey) ?? scopedRows[0] ?? null;

  return (
    <div className="dock-card" style={{ display: 'flex', height: '100%', minWidth: 0, flexDirection: 'column' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 6, borderBottom: '1px solid var(--line)', padding: '10px 12px' }}>
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <RightDockCloseButton />
      </div>

      {}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 0' }}>
        <select
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
            setDiffPanelTurnId(event.target.value === 'all' ? null : event.target.value);
            setSelectedKey(null);
          }}
          className="field"
          style={{ width: '100%', fontSize: 12 }}
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

      {}
      <div style={{ maxHeight: 208, flexShrink: 0, overflowY: 'auto', padding: '8px 12px' }}>
        {scopedRows.length === 0 ? (
          <p style={{ margin: 0, padding: '8px 4px', fontSize: 11.5, lineHeight: 1.375, color: 'var(--faint)' }}>
            No file changes recorded for this scope yet.
          </p>
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 0, margin: 0, listStyle: 'none' }}>
            {scopedRows.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => setSelectedKey(row.key)}
                  className={cx(selected?.key === row.key && 'on')}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 8,
                    borderRadius: 'var(--r-sm)',
                    padding: '4px 6px',
                    textAlign: 'left',
                    fontSize: 11.5,
                    color: selected?.key === row.key ? 'rgb(var(--c-ink))' : 'var(--muted)',
                    background: selected?.key === row.key ? 'rgb(var(--c-elev))' : undefined,
                  }}
                >
                  <span
                    style={{ width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: STATUS_DOT[row.status] }}
                    aria-hidden="true"
                  />
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--f-mono)', fontSize: 11 }}>
                    {row.path}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--faint)' }}>{STATUS_LABEL[row.status]}</span>
                  <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: 'rgb(var(--c-ok))' }}>+{row.added}</span>{' '}
                    <span style={{ color: 'rgb(var(--c-danger))' }}>−{row.removed}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {}
      {selected ? (
        <div style={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column', borderTop: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, padding: '8px 12px' }}>
            <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--f-mono)', fontSize: 11, color: 'rgb(var(--c-ink))' }}>
              {selected.path}
            </span>
              <button
                type="button"
                onClick={() => setRestorePath(selected.path)}
                className="btn ghost xs"
              >
                <RotateCcw className="ic" aria-hidden="true" />
                Restore file…
              </button>
          </div>
          <div className="inner-scroll sd-scroll" style={{ minHeight: 0, flex: 1, overflow: 'auto' }}>
            <SplitDiff diff={selected.diff} onlyPath={selected.path} />
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', minHeight: 0, flex: 1, alignItems: 'center', justifyContent: 'center', padding: '0 24px' }}>
          <p style={{ margin: 0, textAlign: 'center', fontSize: 11.5, lineHeight: 1.375, color: 'var(--faint)' }}>
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
