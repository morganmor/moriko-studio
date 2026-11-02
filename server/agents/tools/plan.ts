/**
 * agent__enter_plan_mode / agent__exit_plan_mode — the physical half of the
 * plan-mode gate (6A).
 *
 * `enter` is cheap and reversible: it flips the session posture so every
 * mutation tool is refused before its handler runs. `exit` is the deliberate
 * second decision — it demands a STRUCTURED plan (files, approach,
 * verification) because an exit with nothing behind it teaches the model that
 * the gate is a formality.
 *
 * Both tools stay callable while plan mode is active. A gate with no key is a
 * trap, not a discipline.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool } from './shared.js';
import { enterPlanMode, exitPlanMode, planModeState, rsatLock } from '../plan-mode.js';

/** One-line-per-file rendering shared by the confirmation and the injection. */
export function renderPlanFiles(files: string[]): string {
  return files.map((file) => '  - ' + file).join('\n');
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry.trim());
  }
  return out;
}

export async function enterPlanModeTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const reason = str(args, 'reason').trim();
  const state = enterPlanMode(ctx.sessionId, reason);

  const lines = [
    'PLAN MODE ACTIVE for this session.',
    reason ? 'Reason: ' + reason : 'No reason recorded.',
    '',
    'From now until you exit, these are REFUSED before they execute: every file write ' +
      '(edit_file, multi_edit, edit_lines, edit_between, insert_at_line, write, apply_patch, ' +
      'layout_edit, rename, move, copy, delete, vault_restore, undo) and every command runner ' +
      '(run, exec, git except read-only subcommands, task_*, harness_reload).',
    '',
    'Use the time to READ: read_file, batch_read, grep, glob, read_symbol, context_pack, ' +
      'deps, interlinked, arch_map, lsp_symbols, tree_outline, and ask_user for anything genuinely unknown.',
    '',
    'Leave with agent__exit_plan_mode once you can state: the files you will touch, the ' +
      'approach you chose and why, and how the result will be verified.',
  ];
  if (state.reason.length === 0) lines.push('', 'Tip: pass a short reason so the plan has a stated purpose.');
  return { ok: true, isError: false, text: lines.join('\n') };
}

export async function exitPlanModeTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const summary = str(args, 'summary').trim();
  const approach = str(args, 'approach').trim();
  const files = readStringList(args.files);
  const verification = readStringList(args.verification);
  const risks = readStringList(args.risks);
  const dryRun = bool(args, 'dryRun');

  const missing: string[] = [];
  if (!summary) missing.push('summary (one paragraph: what changes and why)');
  if (files.length === 0) missing.push('files (the workspace paths you will touch)');
  if (!approach) missing.push('approach (the architecture/technique you chose, and the alternative you rejected)');
  if (verification.length === 0) missing.push('verification (the concrete checks that will prove it works)');

  if (missing.length > 0) {
    return {
      ok: false,
      isError: true,
      errorCode: 'plan_incomplete',
      text: [
        'exit_plan_mode REJECTED — the plan is not structured enough to act on. Still missing:',
        ...missing.map((entry) => '  - ' + entry),
        '',
        'Plan mode stays active, so no file may be written yet. A plan that cannot name its ' +
          'files and its verification steps is not a plan; it is an intention.',
      ].join('\n'),
    };
  }

  // RSAT may still hold the workspace even after the plan flag lifts — say so
  // now rather than letting the next edit fail with a surprise.
  const lock = rsatLock(ctx.sessionId);

  if (dryRun) {
    return {
      ok: true,
      isError: false,
      text: 'Plan accepted (dry run — mode NOT lifted).\n\n' + renderPlan(summary, files, approach, verification, risks),
    };
  }

  exitPlanMode(ctx.sessionId);

  const lines = [
    'PLAN RECORDED — plan mode lifted. Mutation and command tools are available again.',
    '',
    renderPlan(summary, files, approach, verification, risks),
    '',
    'Work the plan: keep a todo in_progress for the step you are actually doing, and complete ' +
      'each one only after its verification passes.',
  ];
  if (lock) {
    lines.push(
      '',
      'CAUTION: the workspace is still under an RSA/T plan lock (PRD status ' + lock.status + '). ' +
        'Edits and commands will keep being refused until the USER presses Start on the RSA/T board.',
    );
  }
  return { ok: true, isError: false, text: lines.join('\n') };
}

function renderPlan(
  summary: string,
  files: string[],
  approach: string,
  verification: string[],
  risks: string[],
): string {
  const lines = [
    '## Plan',
    summary,
    '',
    '## Files',
    renderPlanFiles(files),
    '',
    '## Approach',
    approach,
    '',
    '## Verification',
    ...verification.map((step) => '  - ' + step),
  ];
  if (risks.length > 0) lines.push('', '## Risks', ...risks.map((risk) => '  - ' + risk));
  return lines.join('\n');
}

/** Read-only status: useful before deciding whether to enter or exit. */
export async function planStatusTool(
  _args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const state = planModeState(ctx.sessionId);
  const lock = rsatLock(ctx.sessionId);
  const lines: string[] = [];
  lines.push(state && state.active ? 'Plan mode: ACTIVE' : 'Plan mode: inactive');
  if (state && state.active) {
    lines.push('  entered: ' + new Date(state.enteredAt).toISOString());
    lines.push('  reason: ' + (state.reason || '(none given)'));
  }
  lines.push(
    lock
      ? 'RSA/T lock: ACTIVE (PRD status ' + lock.status + ', ' + lock.achievements + ' achievement(s))'
      : 'RSA/T lock: inactive',
  );
  if (lock) {
    lines.push('  Mutations stay blocked until the USER presses Start on the RSA/T board.');
  }
  return { ok: true, isError: false, text: lines.join('\n') };
}
