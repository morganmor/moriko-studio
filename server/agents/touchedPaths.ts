/**
 * touchedPaths (Addon v2, A3) — the OFFICIAL path extractor for tool calls.
 *
 * The guard (RSA/T R3) and the fs ledger need to know which files a call
 * touches, WITHOUT guessing: shell commands return {unknown: true} and the
 * UI states honestly that they are not path-checked.
 */

export interface TouchedPath {
  path?: string;
  from?: string;
  to?: string;
  /** True when the tool's effects cannot be determined (run/git/exec). */
  unknown: boolean;
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Parse the file paths out of a unified diff header (*** / +++ lines). */
function pathsFromPatch(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    const m = /^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+?)(?:\t|$)/.exec(line);
    if (m && m[1] !== '/dev/null') out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Args whose paths are "obvious" per tool: which files will be touched? */
export function touchedPaths(tool: string, args: Record<string, unknown>): TouchedPath[] {
  const name = tool.replace(/^agent__/, '');

  const single = (key = 'path'): TouchedPath[] => {
    const p = strArg(args, key);
    return p ? [{ path: p, unknown: false }] : [];
  };
  const pair = (): TouchedPath[] => {
    const from = strArg(args, 'from') ?? strArg(args, 'path');
    const to = strArg(args, 'to') ?? strArg(args, 'name');
    if (from && to) return [{ from, to, unknown: false }];
    if (from) return [{ path: from, unknown: false }];
    if (to) return [{ path: to, unknown: false }];
    return [];
  };

  switch (name) {
    case 'edit_file':
    case 'multi_edit':
    case 'edit_lines':
    case 'edit_between':
    case 'insert_at_line':
    case 'write':
    case 'read_file':
    case 'delete':
    case 'read_all':
    case 'list':
    case 'read_symbol':
    case 'context_pack':
    case 'vault_restore':
      return single();
    case 'rename':
    case 'move':
    case 'copy':
      return pair();
    case 'apply_patch': {
      const patch = strArg(args, 'patch');
      return patch ? pathsFromPatch(patch).map((p) => ({ path: p, unknown: false })) : [];
    }
    case 'run':
    case 'git':
    case 'exec':
    case 'task_start':
    case 'task_stop':
    case 'task_output':
      return [{ unknown: true }];
    default:
      return [];
  }
}

/** Convenience: does this call touch ANY known path? */
export function touchesFiles(tool: string, args: Record<string, unknown>): boolean {
  const touched = touchedPaths(tool, args);
  return touched.some((t) => !t.unknown);
}
