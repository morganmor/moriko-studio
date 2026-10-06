/**
 * agent__search — semantic (BM25) search across the active workspace.
 *
 * Unlike grep (exact regex), this finds files by MEANING: describe what you
 * are looking for in natural language and get ranked file:line pointers.
 * The index covers text-like files (code, markdown, config); binaries and
 * generated dirs are excluded. First call builds the index (a few seconds),
 * then it is cached; every edit_file / vault_restore
 * invalidates it so the next query reflects your changes. Follow each result
 * with read_file for the full context.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput } from './shared.js';
import { searchWorkspace } from '../search.js';

export function searchTool(args: Record<string, unknown>, ctx: AgentToolContext): HarnessToolResult {
  const query = str(args, 'query').trim();
  if (!query) return { ok: false, isError: true, text: 'search needs a "query" (natural-language search text).' };
  const limit = Math.min(Math.max(num(args, 'limit') ?? 10, 1), 30);
  const result = searchWorkspace(query, limit, ctx.sessionId);
  if (!result) {
    return { ok: false, isError: true, text: 'No active workspace — set one in the workspace picker first.' };
  }
  if (result.results.length === 0) {
    return {
      ok: true,
      isError: false,
      text: `No documents matched "${query}" (index: ${result.totalDocs} docs in ${result.root}). Try different keywords — BM25 matches on tokens, not meaning.`,
    };
  }
  const lines = result.results.map((r, i) =>
    `${i + 1}. ${r.file}:${r.line}  (score ${r.score})\n   ${r.snippet || '(binary or unreadable)'}`,
  );
  return {
    ok: true,
    isError: false,
    text: truncateOutput(
      `# semantic search — "${query}"\n${lines.join('\n')}\n\n[${result.results.length} result(s) from ${result.totalDocs} indexed docs — follow with read_file for full context]`,
    ),
  };
}
