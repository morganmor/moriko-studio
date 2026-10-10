/**
 * SplitDiff — dual-mode diff renderer for the Diff Panel.
 *
 * MODE "split"  : side-by-side (before | after) — the original Moriko renderer.
 * MODE "inline" : GitHub-style inline diff (design-1): full-width lines with
 *   +/- prefix, green/red background, monospace.  One line per change, no
 *   column pairing.
 *
 * Colors ride theme tokens (success/danger) so dark, light and mocha all
 * stay readable — no hardcoded hex here.
 */
import { useMemo, useState } from 'react';

import { parseUnifiedDiff, toSplitRows, type ParsedDiffFile } from '../lib/diffParse';
import { cx } from './ui';

export type DiffMode = 'split' | 'inline';

export function SplitDiff({
  diff,
  files: preParsed,
  onlyPath,
  mode: modeProp,
}: {
  /** Raw unified diff (multi-file ok) — parsed internally. */
  diff?: string;
  /** Pre-parsed files (when the caller already parsed). */
  files?: ParsedDiffFile[];
  /** Render only this file when the diff carries several. */
  onlyPath?: string;
  /** Controlled mode. When omitted, an internal toggle is used. */
  mode?: DiffMode;
}) {
  const [internalMode, setInternalMode] = useState<DiffMode>(modeProp ?? 'split');
  const [wrap, setWrap] = useState(false);
  const mode = modeProp ?? internalMode;

  const files = useMemo(() => {
    const parsed = preParsed ?? parseUnifiedDiff(diff ?? '');
    const filtered = onlyPath ? parsed.filter((file) => file.path === onlyPath) : parsed;
    return filtered;
  }, [diff, preParsed, onlyPath]);

  if (files.length === 0) {
    return (
      <p style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--faint)' }}>
        No line detail to show (the change may be binary, or the diff was not captured for this
        tool).
      </p>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      <div className="sd-head">
        {modeProp === undefined ? (
          <div className="sd-seg">
            <button
              type="button"
              onClick={() => setInternalMode('split')}
              className={cx(mode === 'split' && 'on')}
            >
              Split
            </button>
            <button
              type="button"
              onClick={() => setInternalMode('inline')}
              className={cx(mode === 'inline' && 'on')}
            >
              Inline
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setWrap((value) => !value)}
          className="sd-wrap"
        >
          {wrap ? 'Wrap' : 'Scroll'}
        </button>
      </div>
      {mode === 'inline' ? (
        <InlineDiffView files={files} />
      ) : (
        <SplitDiffView files={files} wrap={wrap} />
      )}
    </div>
  );
}

/** GitHub-style inline diff (design-1 inspired). */
function InlineDiffView({ files }: { files: ParsedDiffFile[] }) {
  return (
    <>
      {files.map((file) => (
        <div key={file.path} className="diff-inline-file">
          <div className="diff-inline-header">{file.path}</div>
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={`${file.path}-${hunkIndex}`}>
              <div className="diff-inline-note">{hunk.header}</div>
              <div className="diff-inline">
                {hunk.rows.map((row, rowIndex) => {
                  if (row.kind === 'note') {
                    return (
                      <span key={rowIndex} className="diff-inline-note">
                        {row.text}
                      </span>
                    );
                  }
                  const cls =
                    row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'ctx';
                  const prefix = row.kind === 'add' ? '+ ' : row.kind === 'del' ? '− ' : '  ';
                  const text = row.kind === 'ctx' ? row.text : row.text;
                  return (
                    <span key={rowIndex} className={`diff-inline-line ${cls}`}>
                      {prefix}
                      {text}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** Side-by-side split view (original). */
function SplitDiffView({ files, wrap }: { files: ParsedDiffFile[]; wrap: boolean }) {
  return (
    <>
      {files.map((file) => (
        <div key={file.path} className="sd-file">
          {}
          <div className="sd-fhead">
            <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--f-mono)', fontSize: 11.5, color: 'rgb(var(--c-ink))' }}>
              {file.path}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: 'rgb(var(--c-ok))' }}>+{file.added}</span>
              <span style={{ color: 'rgb(var(--c-danger))' }}>−{file.removed}</span>
            </span>
            {file.truncated ? (
              <span style={{ borderRadius: 'var(--r-md)', background: 'rgb(var(--c-warn) / 0.15)', padding: '2px 6px', fontSize: 10, color: 'rgb(var(--c-warn))' }}>
                diff terpotong
              </span>
            ) : null}
          </div>
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={`${file.path}-${hunkIndex}`}>
              {}
              <div className="sd-hunk">
                {hunk.header}
              </div>
              {}
              <div
                className={cx('sd-grid', wrap ? 'wrap' : 'nowrap')}
              >
                {toSplitRows(hunk.rows).map((row, rowIndex) => {
                  if (row.kind === 'note') {
                    return (
                      <div
                        key={rowIndex}
                        className="sd-note"
                      >
                        {row.text}
                      </div>
                    );
                  }
                  const isCtx = row.kind === 'ctx';
                  const beforeBg = isCtx
                    ? undefined
                    : row.kind === 'del'
                      ? { background: 'rgb(var(--c-danger) / 0.1)' }
                      : { background: 'rgb(var(--c-danger) / 0.05)' };
                  const afterBg = isCtx
                    ? undefined
                    : row.kind === 'add'
                      ? { background: 'rgb(var(--c-ok) / 0.1)' }
                      : { background: 'rgb(var(--c-ok) / 0.05)' };
                  return (
                    <div key={rowIndex} className="sd-row">
                      {}
                      <div
                        className="sd-no"
                        style={beforeBg}
                      >
                        {row.before?.no ?? ''}
                      </div>
                      <div
                        className={cx('sd-cell', wrap && 'wrap')}
                        style={{ ...beforeBg, overflowWrap: wrap ? 'anywhere' : 'normal', color: isCtx ? 'var(--muted)' : 'rgb(var(--c-danger))' }}
                      >
                        {row.before ? `${isCtx ? ' ' : '−'}${row.before.text}` : ''}
                      </div>
                      {}
                      <div
                        className="sd-no"
                        style={afterBg}
                      >
                        {row.after?.no ?? ''}
                      </div>
                      <div
                        className={cx('sd-cell', wrap && 'wrap')}
                        style={{ ...afterBg, overflowWrap: wrap ? 'anywhere' : 'normal', color: isCtx ? 'var(--muted)' : 'rgb(var(--c-ok))' }}
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
    </>
  );
}
