/**
 * agent__glob — find files by glob pattern across the active workspace.
 *
 * A recursive file finder that returns PATHS ONLY (no directory listing,
 * no file contents). Unlike agent__list (which is folder-oriented and
 * interleaves dirs+files), this is a pure file-finder: give it a double-
 * star-slash-.test.ts pattern and get back every matching file path.
 *
 * Supports: multiple patterns (OR logic), subpath scoping, sort by "name"
 * or "modified", and a maxResults cap. Heavy dirs (node_modules, .git, …)
 * are always skipped.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import {
  str, num,
  globToRegExp, truncateOutput,
  resolveWithPermission,
} from './shared.js';
import { walkFiles } from './list.js';

export async function globTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const singlePattern = str(args, 'pattern').trim();
  const rawPatterns = Array.isArray(args.patterns)
    ? args.patterns.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const patterns = rawPatterns.length > 0 ? rawPatterns : singlePattern ? [singlePattern] : [];
  if (patterns.length === 0) {
    return { ok: false, isError: true, text: 'glob needs a "pattern" (e.g. "**/*.test.ts") or a "patterns" array.' };
  }

  const regexes = patterns.map((entry) => globToRegExp(entry));

  const subpathRaw = str(args, 'subpath').trim() || '.';
  const resolved = await resolveWithPermission('glob', subpathRaw, ctx);
  if (!statSync(resolved.absolute).isDirectory()) {
    return { ok: false, isError: true, text: `"${resolved.relative}" is not a directory.` };
  }

  const maxResults = Math.min(Math.max(num(args, 'maxResults') ?? 200, 1), 1000);
  const sortBy = str(args, 'sort').trim().toLowerCase() === 'modified' ? 'modified' : 'name';

  const { files, truncated } = walkFiles(resolved.absolute);

  const matched: Array<{ rel: string; mtime: number }> = [];
  for (const rel of files) {
    const matches = regexes.some((re) => re.test(rel));
    if (matches) {
      let mtime = 0;
      try {
        mtime = statSync(path.join(resolved.absolute, rel.split('/').join(path.sep))).mtimeMs;
      } catch {
        continue;
      }
      matched.push({ rel, mtime });
    }
  }

  if (sortBy === 'modified') {
    matched.sort((a, b) => b.mtime - a.mtime);
  } else {
    matched.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  const total = matched.length;
  const capped = matched.slice(0, maxResults);

  const rootRelative = resolved.relative === '.' ? '' : `${resolved.relative}/`;
  const lines = capped.map((entry) => `${rootRelative}${entry.rel}`);

  const header = `${total} file${total === 1 ? '' : 's'} matched${truncated ? ' (walk truncated at 2000 files — narrow your subpath for completeness)' : ''}${total > maxResults ? ` · showing first ${maxResults}` : ''}`;
  const footer = patterns.length > 1 ? `\n\nPatterns: ${patterns.map((p) => `"${p}"`).join(', ')}` : '';
  const text = truncateOutput(`${header}\n${lines.join('\n')}${footer}`);

  return { ok: true, isError: false, text };
}