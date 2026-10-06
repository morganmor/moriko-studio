/**
 * agent__layout_edit — INTENT-based layout editing (F2).
 *
 * The model NEVER writes pixel coordinates here. It declares a relation —
 * move-right-of / move-below / swap / resize-relative / align — and the
 * deterministic compiler (applyLayoutIntent in ../spatial.ts) computes every
 * number from the CURRENT map, applies the text edit, vaults the file, and
 * runs a post-edit spatial diff so collision candidates surface IMMEDIATELY.
 *
 * This is the root-cause fix for P1: no guessed pixels, no blind edits.
 * Static tier contract: target + reference must be absolutely positioned
 * with complete px boxes (top/left/width/height) in the SAME file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, resolveWithPermission } from './shared.js';
import { snapshotFile } from '../vault.js';
import {
  applyLayoutIntent,
  buildSpatialMap,
  diffSpatialMaps,
  renderSpatialDiff,
  invalidateSpatialMapCache,
  type LayoutIntent,
} from '../spatial.js';

const INTENT_TYPES = ['move-right-of', 'move-below', 'swap', 'resize-relative', 'align'] as const;

export async function layoutEditTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const fileRaw = str(args, 'path').trim();
  if (!fileRaw) {
    return { ok: false, isError: true, text: 'layout_edit needs a "path" (the CSS/JSX file that declares the target region).' };
  }
  const intentType = str(args, 'type').trim().toLowerCase();
  if (!INTENT_TYPES.includes(intentType as (typeof INTENT_TYPES)[number])) {
    return {
      ok: false,
      isError: true,
      text: `Unknown intent type "${intentType}". Use one of: ${INTENT_TYPES.join(', ')}.`,
    };
  }
  const target = str(args, 'target').trim();
  if (!target) return { ok: false, isError: true, text: 'layout_edit needs a "target" region id (from agent__spatial {mode:"map"}).' };

  const intent: LayoutIntent = {
    type: intentType as LayoutIntent['type'],
    target,
    reference: str(args, 'reference').trim() || undefined,
    scale: num(args, 'scale'),
    axis: (['x', 'y', 'both'].includes(str(args, 'axis')) ? str(args, 'axis') : 'both') as LayoutIntent['axis'],
    mode: (['left', 'top', 'center-x', 'center-y', 'right', 'bottom'].includes(str(args, 'mode'))
      ? str(args, 'mode')
      : undefined) as LayoutIntent['mode'],
    gap: num(args, 'gap'),
  };

  const dryRun = args.dryRun === true;
  const resolved = await resolveWithPermission('layout_edit', fileRaw, ctx, 'write');
  const absolute = resolved.absolute;
  const relative = resolved.relative;

  let src: string;
  try {
    src = readFileSync(absolute, 'utf-8');
  } catch (error) {
    return { ok: false, isError: true, text: `Cannot read ${relative}: ${error instanceof Error ? error.message : 'read failed'}.` };
  }

  const outcome = applyLayoutIntent(src, relative, intent);
  if ('error' in outcome) {
    return { ok: false, isError: true, text: outcome.error };
  }
  const { plan } = outcome;
  const edit = plan.edits[0];
  if (!edit) return { ok: false, isError: true, text: 'The intent compiled to no edits (nothing to do).' };

  const lines = [
    `LAYOUT INTENT ${intent.type} — target ${intent.target}${intent.reference ? ` ∥ reference ${intent.reference}` : ''}`,
    ...plan.explanation.map((e) => `  = ${e}`),
    ...plan.warnings.map((w) => `  ! ${w}`),
    `  edit ${relative}:${edit.line}`,
  ];

  if (dryRun) {
    lines.push('');
    lines.push('DRY RUN — nothing written. Re-run without dryRun to apply.');
    return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
  }

  const snap = snapshotFile(ctx.sessionId, absolute, 'layout_edit');
  const vaultNote = snap.entry
    ? `vault: ${snap.entry.id}`
    : `vault skipped (${snap.skipped ?? 'unknown'})`;

  let next: string;
  if (src.includes(edit.oldText)) {
    next = src.replace(edit.oldText, edit.newText);
  } else {
    return {
      ok: false,
      isError: true,
      text: `The compiled old text no longer matches ${relative} — the file changed since the map was built. Re-run agent__spatial {mode:"map"} and retry.`,
    };
  }
  try {
    writeFileSync(absolute, next, 'utf-8');
  } catch (error) {
    return { ok: false, isError: true, text: `Write failed on ${relative}: ${error instanceof Error ? error.message : 'write failed'}.` };
  }

  invalidateSpatialMapCache();
  const beforeMap = buildSpatialMap([{ path: relative, content: src }]);
  const afterMap = buildSpatialMap([{ path: relative, content: next }]);
  const diff = diffSpatialMaps(beforeMap, afterMap);
  const newCandidates = diff.newCollisions.length;

  lines.push('');
  lines.push(`applied · ${vaultNote}`);
  lines.push(truncateOutput(renderSpatialDiff(diff)));

  if (newCandidates > 0) {
    lines.push('');
    lines.push(
      `⚠ THIS EDIT CREATED ${newCandidates} NEW COLLISION CANDIDATE(S). Fix them (or re-run with a corrected intent) BEFORE reporting done — ` +
      'run agent__spatial {mode:"check"} for the full gate report.',
    );
    return { ok: false, isError: true, text: truncateOutput(lines.join('\n')) };
  }

  lines.push('');
  lines.push('No new collision candidates — verify in the running app (F4 runtime tier pending) and report done.');
  return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
}
