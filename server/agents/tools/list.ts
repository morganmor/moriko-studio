/**
 * agent__list — list files and directories of a folder in the active workspace.
 *
 * Non-recursive by default; set recursive for a full tree (heavy folders like
 * node_modules are skipped). Supports: sizes (aggregate bytes per dir),
 * sort: "modified" (most recently changed first), git badges, maxEntries cap,
 * glob filter, and mode: "touched" (session footprint — everything this
 * conversation has read or edited, with live staleness).
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import {
  str, num, bool,
  globToRegExp, truncateOutput, formatSize, requireWorkspace,
  resolveWithPermission,
  SKIP_DIRS, MAX_LIST_ENTRIES, MAX_READ_BYTES,
} from './shared.js';
import { listSessionEntries } from '../read-policy.js';
import { sha256 } from '../edit-diagnostics.js';
import { gitStatusMap, gitDirBadge, gitFileBadge } from '../gitbadges.js';

export async function listTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  // read or edited, with live staleness — the end-of-task self-review
  if (str(args, 'mode').trim().toLowerCase() === 'touched') {
    if (!ctx.sessionId) {
      return { ok: false, isError: true, text: 'list mode "touched" needs an active conversation session.' };
    }
    const { root } = requireWorkspace(ctx);
    const entries = listSessionEntries(ctx.sessionId);
    if (entries.length === 0) {
      return { ok: true, isError: false, text: 'Session footprint is empty — nothing has been read or edited yet.' };
    }
    const rank = { STALE: 0, EDITED: 1, READ: 2, MISSING: 3 } as const;
    type Status = keyof typeof rank;
    const rows: Array<{ status: Status; rel: string; detail: string }> = [];
    for (const { absolute, entry } of entries.slice(0, 300)) {
      const rel = path.relative(root, absolute);
      const relPath = (rel.startsWith('..') ? absolute : rel || '.').replace(/\\/g, '/');
      let status: Status;
      let detail: string;
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        stats = undefined;
      }
      if (!stats) {
        status = 'MISSING';
        detail = `read#${entry.rev} — file is gone (deleted externally?)`;
      } else if (Math.abs(stats.mtimeMs - entry.mtime) > 0.5) {
        status = 'STALE';
        detail = `read#${entry.rev} — CHANGED since your last ${entry.lastOp}`;
      } else if (stats.size <= MAX_READ_BYTES) {
        try {
          const same = sha256(readFileSync(absolute, 'utf8')) === entry.hash;
          if (same) {
            status = entry.lastOp === 'write' ? 'EDITED' : 'READ';
            detail = `read#${entry.rev} · current`;
          } else {
            status = 'STALE';
            detail = `read#${entry.rev} — content differs from your last ${entry.lastOp}`;
          }
        } catch {
          status = 'STALE';
          detail = `read#${entry.rev} — unreadable now`;
        }
      } else {
        status = entry.lastOp === 'write' ? 'EDITED' : 'READ';
        detail = `read#${entry.rev} · current (mtime; too large to hash)`;
      }
      rows.push({ status, rel: relPath, detail });
    }
    rows.sort((a, b) => rank[a.status] - rank[b.status] || a.rel.localeCompare(b.rel));
    const lines = rows.map((row) => `${row.status.padEnd(8)}${row.rel}  (${row.detail})`);
    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts)
      .map(([key, value]) => `${key} ${value}`)
      .join(' · ');
    return {
      ok: true,
      isError: false,
      text: truncateOutput(
        `# session footprint — ${rows.length} path(s)\n${lines.join('\n')}\n` +
          `[${summary}]` +
          (counts.STALE
            ? '\nSTALE files changed outside your knowledge — re-read before editing.'
            : '') +
          '\nEnd-of-task: verify each EDITED diff, then report the footprint to the user.',
      ),
    };
  }
  const rawPath = str(args, 'path').trim() || '.';
  const { absolute, relative } = await resolveWithPermission('list', rawPath, ctx);

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return { ok: false, isError: true, text: `No such directory: ${relative}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, isError: true, text: `"${relative}" is a file, not a directory — use read_file on it.` };
  }

  const recursive = bool(args, 'recursive');
  const glob = str(args, 'glob').trim();
  const globRe = glob ? globToRegExp(glob) : null;
  const maxEntries = Math.min(Math.max(num(args, 'maxEntries') ?? 200, 1), MAX_LIST_ENTRIES);
  const sortBy = str(args, 'sort').trim().toLowerCase() === 'modified' ? 'modified' : 'name' as 'name' | 'modified';
  const showSizes = bool(args, 'sizes');
  const wantGit = bool(args, 'git');
  const skippedDirs: string[] = [];

  const dirs: Array<{ name: string; mtime: number; totalBytes?: number; fileCount?: number }> = [];
  const files: Array<{ path: string; size: number; mtime: number }> = [];
  let truncated = false;

  /** Walk a directory subtree to compute aggregate bytes + file count.
   *  Used when sizes=true — aggregate directory sizes. */
  function subtreeStats(dir: string): { totalBytes: number; fileCount: number } {
    let totalBytes = 0;
    let fileCount = 0;
    const walk = (d: string): void => {
      let ents;
      try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) { skippedDirs.push(ent.name); continue; }
          walk(path.join(d, ent.name));
        } else if (ent.isFile()) {
          try { totalBytes += statSync(path.join(d, ent.name)).size; fileCount += 1; } catch {  }
        }
      }
    };
    walk(dir);
    return { totalBytes, fileCount };
  }

  const visit = (dir: string, depth: number): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dirs.length + files.length >= maxEntries) {
        truncated = true;
        return;
      }
      const rel = path
        .relative(absolute, path.join(dir, entry.name))
        .split(path.sep)
        .join('/');
      if (entry.isDirectory()) {
        let dirMtime = 0;
        try { dirMtime = statSync(path.join(dir, entry.name)).mtimeMs; } catch {  }
        let dirStats: { totalBytes: number; fileCount: number } | undefined;
        if (showSizes && recursive) { dirStats = subtreeStats(path.join(dir, entry.name)); }
        dirs.push({ name: `${rel}/`, mtime: dirMtime, ...dirStats });
        if (recursive && !SKIP_DIRS.has(entry.name)) {
          visit(path.join(dir, entry.name), depth + 1);
        } else if (recursive && SKIP_DIRS.has(entry.name)) {
          skippedDirs.push(entry.name);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (globRe && !globRe.test(rel) && !globRe.test(entry.name)) continue;
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(path.join(dir, entry.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
      }
      files.push({ path: rel, size, mtime });
    }
  };

  if (recursive) {
    visit(absolute, 0);
  } else {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      return {
        ok: false,
        isError: true,
        text: `Cannot read "${relative}": ${error instanceof Error ? error.message : 'permission denied'}`,
      };
    }
    for (const entry of entries) {
      if (dirs.length + files.length >= maxEntries) {
        truncated = true;
        break;
      }
      if (entry.isDirectory()) {
        let dirMtime = 0;
        try { dirMtime = statSync(path.join(absolute, entry.name)).mtimeMs; } catch {  }
        let dirStats: { totalBytes: number; fileCount: number } | undefined;
        if (showSizes && recursive) { dirStats = subtreeStats(path.join(absolute, entry.name)); }
        dirs.push({ name: `${entry.name}/`, mtime: dirMtime, ...dirStats });
        continue;
      }
      if (!entry.isFile()) continue;
      if (globRe && !globRe.test(entry.name)) continue;
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(path.join(absolute, entry.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
      }
      files.push({ path: entry.name, size, mtime });
    }
  }

  if (sortBy === 'modified') {
    dirs.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  } else {
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  }

  const gitOutcome = wantGit ? await gitStatusMap(requireWorkspace(ctx).root) : null;
  const gitMap = gitOutcome?.map ?? null;

  const dirLines = dirs.map((dir) => {
    let badge = '';
    if (gitMap) {
      const relDir = dir.name === './' ? '' : dir.name.replace(/\/$/, '');
      badge = gitDirBadge(gitMap, relDir ? `${relDir}/` : '');
    }
    return `DIR   ${dir.name}${dir.totalBytes !== undefined ? `  (${formatSize(dir.totalBytes)}, ${dir.fileCount} file(s))` : ''}${badge}`;
  });
  const lines = [
    ...dirLines,
    ...files.map((file) => `FILE  ${file.path}  (${formatSize(file.size)})${gitMap ? gitFileBadge(gitMap, file.path) : ''}`),
  ];
  if (lines.length === 0) {
    return { ok: true, isError: false, text: `"${relative}" is empty (or nothing matched the glob).` };
  }

  const notes: string[] = [];
  if (truncated) notes.push(`stopped at ${maxEntries} entries`);
  const skipNote = skippedDirs.length > 0 ? `skipped: ${[...new Set(skippedDirs)].join(', ')}` : '';
  if (skipNote) notes.push(skipNote);
  if (wantGit && gitOutcome && !gitMap) notes.push(`git: unavailable (${gitOutcome.reason ?? 'unknown'})`);
  return {
    ok: true,
    isError: false,
    text: truncateOutput(
      `# ${relative}${recursive ? ' (recursive)' : ''}\n${lines.join('\n')}` +
      `\n\n[${dirs.length} director(ies), ${files.length} file(s)${notes.length ? `; ${notes.join(', ')}` : ''}]`,
    ),
  };
}

/** Collects candidate files under `root`, applying the caps and skip list. */
export function walkFiles(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  const visit = (dir: string, depth: number): void => {
    if (truncated || depth > 12 || files.length >= 2000) {
      truncated = truncated || files.length >= 2000;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= 2000) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };

  visit(root, 0);
  return { files, truncated };
}
