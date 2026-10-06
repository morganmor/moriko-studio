/**
 * SplitDiff — SIDE-BY-SIDE (before | after) diff renderer for the Diff Panel
 * and the restore marker card.
 *
 * Rows come from diffParse's `toSplitRows` pairing policy: dels[i] pairs with
 * adds[i] inside a change run; leftovers render one-sided. Annotations
 * (`⇄ moved`, `│ changed`) render as full-width notes so they never look like
 * code lines. Line numbers are the originals from the @@ header.
 *
 * Colors ride theme tokens (success/danger) so dark, light and mocha all
 * stay readable — no hardcoded hex here.
 */
import { useMemo, useState } from 'react';

import { parseUnifiedDiff, toSplitRows, type ParsedDiffFile } from '../lib/diffParse';
import { cx } from './ui';

export function SplitDiff({
  diff,
  files: preParsed,
  onlyPath,
}: {
  /** Raw unified diff (multi-file ok) — parsed internally. */
  diff?: string;
  /** Pre-parsed files (when the caller already parsed). */
  files?: ParsedDiffFile[];
  /** Render only this file when the diff carries several. */
  onlyPath?: string;
}) {
  const [wrap, setWrap] = useState(false);
  const files = useMemo(() => {
    const parsed = preParsed ?? parseUnifiedDiff(diff ?? '');
    const filtered = onlyPath ? parsed.filter((file) => file.path === onlyPath) : parsed;
    return filtered;
  }, [diff, preParsed, onlyPath]);

  if (files.length === 0) {
    return (
      <p className="px-3 py-2 text-[11.5px] text-faint">
        No line detail to show (the change may be binary, or the diff was not captured for this
        tool).
      </p>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-end px-2 pb-1">
          <button
            type="button"
            onClick={() => setWrap((value) => !value)}
            className="rounded-control px-1.5 py-0.5 text-[10px] font-medium text-faint transition-colors hover:text-ink"
          >
            {wrap ? 'Wrap' : 'Scroll'}
          </button>
      </div>
      {files.map((file) => (
        <div key={file.path} className="border-t border-hairline">
          {/* File header */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-elevated/60 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">
              {file.path}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] font-medium tabular-nums">
              <span className="text-success">+{file.added}</span>
              <span className="text-danger">−{file.removed}</span>
            </span>
            {file.truncated ? (
              <span className="rounded-control bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                diff terpotong
              </span>
            ) : null}
          </div>
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={`${file.path}-${hunkIndex}`}>
              {/* Hunk header — spans both columns */}
              <div className="border-y border-hairline bg-surface px-2.5 py-1 font-mono text-[10.5px] text-faint">
                {hunk.header}
              </div>
              {/* Two-column grid: [before no | before text | after no | after text] */}
              <div
                className={cx(
                  'grid font-mono text-[11.5px] leading-[1.55]',
                  // Scroll: content-sized columns (w-max + max-content) widen the
                  // TABLE itself — the outer overflow-auto scrolls it. Fixed 50%
                  // columns made long `whitespace-pre` lines spill across the
                  // sibling column (text collision). Wrap keeps equal halves.
                  wrap
                    ? 'w-full grid-cols-[2.75rem_1fr_2.75rem_1fr]'
                    : 'w-max min-w-full grid-cols-[2.75rem_max-content_2.75rem_max-content]',
                )}
              >
                {toSplitRows(hunk.rows).map((row, rowIndex) => {
                  if (row.kind === 'note') {
                    return (
                      <div
                        key={rowIndex}
                        className="col-span-4 border-b border-hairline/60 bg-elevated/30 px-2.5 py-0.5 text-[10.5px] italic text-faint"
                      >
                        {row.text}
                      </div>
                    );
                  }
                  const isCtx = row.kind === 'ctx';
                  const beforeBg = isCtx
                    ? ''
                    : row.kind === 'del'
                      ? 'bg-danger/10'
                      : 'bg-danger/5';
                  const afterBg = isCtx ? '' : row.kind === 'add' ? 'bg-success/10' : 'bg-success/5';
                  return (
                    <div key={rowIndex} className="col-span-4 grid grid-cols-subgrid border-b border-hairline/40">
                      {/* BEFORE side */}
                      <div
                        className={cx(
                          'select-none border-r border-hairline px-1.5 text-right text-[10px] tabular-nums text-faint',
                          beforeBg,
                        )}
                      >
                        {row.before?.no ?? ''}
                      </div>
                      <div
                        className={cx(
                          'min-w-0 overflow-hidden whitespace-pre px-2',
                          wrap && 'whitespace-pre-wrap break-all',
                          beforeBg,
                          isCtx ? 'text-muted' : 'text-danger',
                        )}
                        style={{ overflowWrap: wrap ? 'anywhere' : 'normal' }}
                      >
                        {row.before ? `${isCtx ? ' ' : '−'}${row.before.text}` : ''}
                      </div>
                      {/* AFTER side */}
                      <div
                        className={cx(
                          'select-none border-r border-hairline px-1.5 text-right text-[10px] tabular-nums text-faint',
                          afterBg,
                        )}
                      >
                        {row.after?.no ?? ''}
                      </div>
                      <div
                        className={cx(
                          'min-w-0 overflow-hidden whitespace-pre px-2',
                          wrap && 'whitespace-pre-wrap break-all',
                          afterBg,
                          isCtx ? 'text-muted' : 'text-success',
                        )}
                        style={{ overflowWrap: wrap ? 'anywhere' : 'normal' }}
                      >
                        {row.after ? `${isCtx ? ' ' : '+'}${row.after.text}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
