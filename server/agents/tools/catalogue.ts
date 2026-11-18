
import type { AgentToolDef } from './shared.js';
import { listAddonToolDefs } from '../../addons/registry.js';
import { builtinAddonIds } from '../../addons/seed.js';
import { registeredTools } from './registry.js';
import './registered.js';

export function listAgentToolDefs(): AgentToolDef[] {
  const defs: AgentToolDef[] = [
    {
      wireName: 'agent__list',
      description: 'List a workspace folder (recursive, glob, sort name|modified, sizes, git status badges); mode "touched" audits session footprint (EDITED/STALE/READ/MISSING — re-read STALE files and audit before closing a task).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory (default ".").' },
          mode: { type: 'string', enum: ['touched'], description: 'Session footprint audit instead of a listing.' },
          recursive: { type: 'boolean', description: 'Full tree (heavy dirs skipped).' },
          glob: { type: 'string', description: 'Filename glob filter.' },
          maxEntries: { type: 'number', description: 'Cap (default 200, max 1000).' },
          sort: { type: 'string', enum: ['name', 'modified'], description: '"name" (default) or "modified".' },
          sizes: { type: 'boolean', description: 'Aggregate dir sizes (recursive only).' },
          git: { type: 'boolean', description: 'Git status badges.' },
        },
      },
    },
    {
      wireName: 'agent__grep',
      description: 'Regex content search ("path:line: text"; pattern or patterns[] in one walk). context: 0-10 or wholeLines: true returns whole-line windows WITH edit read receipts (edit directly without read_file). Scope FIRST via subpath/subpaths and glob/globs (follow concentration hints in footer; anchor broad keywords with \\b); target-aware budgets — single_file: maxMatches ≤200 (default 200); multi_file: ≤100 per file (default 100, total = cap × files); single_folder: ≤20 matches + ≤10 files; multi_folder/root: ≤100 matches + ≤10 files, ≤20 per file; supports caseSensitive, sort "path"|"density" ("density" is not paginable), continueFrom "g:file:line".',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex to search for.' },
          patterns: { type: 'array', items: { type: 'string' }, description: 'Multiple patterns in one walk (overrides pattern).' },
          glob: { type: 'string', description: 'Filename glob.' },
          globs: { type: 'array', items: { type: 'string' }, description: 'Multiple globs (OR).' },
          subpath: { type: 'string', description: 'File/dir scope (alias "path").' },
          subpaths: { type: 'array', items: { type: 'string' }, description: 'Multiple scopes, merged.' },
          caseSensitive: { type: 'boolean', description: 'Default false.' },
          maxMatches: { type: 'number', description: 'Match budget, target-aware: 1 explicit file ≤200 (default 200), N explicit files ≤100 PER FILE (default 100), one sub-folder ≤20 (default 20), root/multi-folder ≤100 (default 100). Alias: max_results/maxResults.' },
          maxFiles: { type: 'number', description: 'File cap for folder/multi-folder scopes (default 10, max 10); explicit files are never capped below their count.' },
          context: { type: 'number', description: 'Context lines 0-10 (receipt mode).' },
          wholeLines: { type: 'boolean', description: 'Whole match lines (receipt mode).' },
          sort: { type: 'string', enum: ['path', 'density'], description: '"path" (default) or "density".' },
          continueFrom: { type: 'string', description: 'Pagination token g:file:line.' },
        },
      },
    },
    {
      wireName: 'agent__read_file',
      description: 'Read a file with whole lines, sha256 + read# receipt footer (opens workspace/attachment images inline for vision-capable models). Modes: "window" (default, 400 lines, max 1000; pass footer next:"r:…" verbatim as continueFrom), "outline" (line-numbered symbol map — NOT an edit receipt), "fold" (signature tree with collapsed bodies — NOT an edit receipt). Extras: ranges [[from,to],...] (max 6, 2000 lines), line: N (one full line), showWhitespace: true. Repeated reads of an unchanged file return an automatic stub unless refresh: true.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          offsetLine: { type: 'number', description: '1-based first line (default 1).' },
          maxLines: { type: 'number', description: 'Default 400, max 1000.' },
          line: { type: 'number', description: 'Read one full line by number.' },
          ranges: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Disjoint regions [[from,to],...] (max 6, 2000 lines).' },
          mode: { type: 'string', enum: ['window', 'outline', 'fold'], description: '"window" (default) / "outline" / "fold".' },
          showWhitespace: { type: 'boolean', description: 'Expose tabs/trailing spaces.' },
          lastHash: { type: 'string', description: 'Previous sha; "unchanged" short-circuit (now automatic — this is optional).' },
          refresh: { type: 'boolean', description: 'Force a full re-render, skipping the automatic unchanged stub.' },
          continueFrom: { type: 'string', description: 'Footer token next:"r:…".' },
        },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__read_all',
      description: 'Read whole file as a folded signature tree (bodies collapsed as ⋯ N lines; maxDepth default 2, max 8); structural map only — NOT an edit read receipt.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          maxDepth: { type: 'number', description: 'Nesting levels (default 2, max 8).' },
        },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__edit_file',
      description: 'DEFAULT single-region edit: replace exact unique oldString (copied from receipted read output) with newString; supports replaceAll, lineHint (disambiguate multi-match), dryRun (preview; pass pre-edit hash as expectedReadHash on apply), expectedReadHash (blocks if file changed), preserveEol (default true), verifySyntax (default true, rolls back broken .json/.js/.ts), wordLevel diff.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          oldString: { type: 'string', description: 'Exact text to replace (non-empty; creating a file is agent__write).' },
          newString: { type: 'string', description: 'Replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
          lineHint: { type: 'number', description: 'Disambiguate multi-match.' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          expectedReadHash: { type: 'string', description: 'sha256; mismatch = file changed.' },
          preserveEol: { type: 'boolean', description: 'Adapt EOLs (default true).' },
          verifySyntax: { type: 'boolean', description: 'Syntax probe + rollback (default true).' },
          wordLevel: { type: 'boolean', description: 'Word-level diff rendering (default true).' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
    {
      wireName: 'agent__write',
      description: 'Create a brand-new file (refuses if the file already exists — replace it with agent__overwrite instead); supports dryRun and verifySyntax (default true).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (must be new).' },
          content: { type: 'string', description: 'Full text to write.' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          verifySyntax: { type: 'boolean', description: 'Syntax probe + rollback (default true).' },
        },
        required: ['path', 'content'],
      },
    },
    {
      wireName: 'agent__overwrite',
      description: 'Replace the FULL content of an existing file (read-before-overwrite gate: needs a current read receipt, optional expectedReadHash; prior content vaulted; syntax probe + rollback).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Existing file path.' },
          content: { type: 'string', description: 'Full replacement text.' },
          expectedReadHash: { type: 'string', description: 'sha256 from the read_file footer (race-safe overwrite).' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          verifySyntax: { type: 'boolean', description: 'Syntax probe + rollback (default true).' },
        },
        required: ['path', 'content'],
      },
    },
    {
      wireName: 'agent__multi_edit',
      description: 'Atomic batch edit on one read file: edits[] (max 50) applied all-or-nothing with every nth edit verified against the (n-1)th result; supports dryRun, expectedReadHash, preserveEol, verifySyntax.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          edits: {
            type: 'array', maxItems: 50,
            items: {
              type: 'object',
              required: ['oldString', 'newString'],
              properties: {
                oldString: { type: 'string', description: 'Exact text (non-empty).' },
                newString: { type: 'string', description: 'Replacement.' },
                replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
              },
            },
            description: 'Atomic batch (max 50).',
          },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          expectedReadHash: { type: 'string', description: 'sha256; mismatch = file changed.' },
          preserveEol: { type: 'boolean', description: 'Adapt EOLs (default true).' },
          verifySyntax: { type: 'boolean', description: 'Syntax probe + rollback (default true).' },
        },
        required: ['path', 'edits'],
      },
    },
    {
      wireName: 'agent__edit_lines',
      description: 'Replace a receipted 1-based inclusive line range { from, to } with newString; supports dryRun, expectedReadHash, preserveEol, verifySyntax.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          from: { type: 'number', description: 'First line (inclusive).' },
          to: { type: 'number', description: 'Last line (inclusive).' },
          newString: { type: 'string', description: 'Replacement text.' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          expectedReadHash: { type: 'string', description: 'sha256; mismatch = file changed.' },
          preserveEol: { type: 'boolean', description: 'Adapt EOLs (default true).' },
          verifySyntax: { type: 'boolean', description: 'Syntax probe + rollback (default true).' },
        },
        required: ['path', 'from', 'to'],
      },
    },
    {
      wireName: 'agent__edit_between',
      description: 'Replace content between two UNIQUE anchors { start, end } (for regions in flux); includeAnchors: false (default) keeps both anchors, includeAnchors: true replaces them too.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          start: { type: 'string', description: 'Unique start anchor.' },
          end: { type: 'string', description: 'Unique end anchor (after start).' },
          newString: { type: 'string', description: 'Replacement.' },
          includeAnchors: { type: 'boolean', description: 'Replace the anchors too (default false).' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          expectedReadHash: { type: 'string', description: 'sha256; mismatch = file changed.' },
          verifySyntax: { type: 'boolean', description: 'Syntax probe + rollback (default true).' },
        },
        required: ['path', 'start', 'end'],
      },
    },
    {
      wireName: 'agent__insert_at_line',
      description: 'Insert newString BEFORE 1-based line insertAtLine or at EOF (append: true) on a read file; supports dryRun, expectedReadHash, verifySyntax.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          newString: { type: 'string', description: 'Text to insert (non-empty).' },
          insertAtLine: { type: 'number', description: 'Insert before this line.' },
          append: { type: 'boolean', description: 'Append at EOF.' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          expectedReadHash: { type: 'string', description: 'sha256; mismatch = file changed.' },
          verifySyntax: { type: 'boolean', description: 'Syntax probe + rollback (default true).' },
        },
        required: ['path', 'newString'],
      },
    },
    {
      wireName: 'agent__rename',
      description: 'Rename a file/folder within its directory (plain name, no separators).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or folder.' },
          name: { type: 'string', description: 'New base name.' },
        },
        required: ['path', 'name'],
      },
    },
    {
      wireName: 'agent__move',
      description: 'Move a file/folder to a new path (never overwrites — delete destination first if replacing).',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path.' },
          to: { type: 'string', description: 'Destination path.' },
        },
        required: ['from', 'to'],
      },
    },
    {
      wireName: 'agent__copy',
      description: 'Copy a file/folder to a new path (never overwrites — delete destination first if replacing).',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path.' },
          to: { type: 'string', description: 'Destination path.' },
        },
        required: ['from', 'to'],
      },
    },
    {
      wireName: 'agent__delete',
      description: 'Delete a file/folder (non-empty dirs need recursive: true; vaulted first; refused on addons-src/ which is user-only).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to delete.' },
          recursive: { type: 'boolean', description: 'Required for non-empty dirs.' },
        },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__goal_create',
      description: 'Create a goal with plan and todos (shown in the Goals panel).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short goal statement.' },
          plan: { type: 'string', description: 'Ordered steps.' },
          todos: { type: 'array', items: { type: 'string' }, description: 'Checklist items.' },
        },
        required: ['title', 'plan', 'todos'],
      },
    },
    {
      wireName: 'agent__goal_update',
      description: 'Update a goal: status, plan, check/uncheck todos.',
      inputSchema: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'Goal id.' },
          status: { type: 'string', enum: ['running', 'paused', 'done'], description: 'New status.' },
          plan: { type: 'string', description: 'Rewritten plan.' },
          checkTodo: { type: 'array', items: { type: 'string' }, description: 'Todo ids to complete.' },
          uncheckTodo: { type: 'array', items: { type: 'string' }, description: 'Todo ids to reopen.' },
        },
        required: ['goalId'],
      },
    },
    {
      wireName: 'agent__goal_list',
      description: 'List goals with statuses, plans and todo ids.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__todo_create',
      description: 'Create a standalone todo (not tied to a goal). Use for everyday task tracking.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The task to do.' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default medium.' },
          notes: { type: 'string', description: 'Optional longer detail.' },
        },
        required: ['text'],
      },
    },
    {
      wireName: 'agent__todo_update',
      description: 'Move a standalone todo through pending/in_progress/completed, or change text/priority/notes.',
      inputSchema: {
        type: 'object',
        properties: {
          todoId: { type: 'string', description: 'Todo id.' },
          state: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Explicit state. pending to completed is allowed (the build gate still applies); in_progress requires activeForm.' },
          activeForm: { type: 'string', description: 'REQUIRED for in_progress: present-continuous description of the work happening now.' },
          text: { type: 'string', description: 'New text.' },
          done: { type: 'boolean', description: 'Legacy shorthand: true = completed, false = pending (same invariants apply).' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'New priority.' },
          notes: { type: 'string', description: 'Notes (empty string clears).' },
        },
        required: ['todoId'],
      },
    },
    {
      wireName: 'agent__todo_list',
      description: 'List standalone todos with statuses and priorities.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__todo_delete',
      description: 'Delete a standalone todo by id.',
      inputSchema: {
        type: 'object',
        properties: { todoId: { type: 'string', description: 'Todo id.' } },
        required: ['todoId'],
      },
    },
    {
      wireName: 'agent__enter_plan_mode',
      description: 'Enter PLAN MODE: exploration only — every file write and command runner is refused until exit_plan_mode.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why this session is planning (echoed in every refusal).' },
        },
      },
    },
    {
      wireName: 'agent__exit_plan_mode',
      description: 'Leave PLAN MODE with a structured plan. The only way to lift the gate.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One paragraph: what changes and why.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Workspace paths you will touch.' },
          approach: { type: 'string', description: 'The approach chosen, and the alternative rejected.' },
          verification: { type: 'array', items: { type: 'string' }, description: 'Concrete checks that will prove it works.' },
          risks: { type: 'array', items: { type: 'string' }, description: 'Known risks (optional).' },
          dryRun: { type: 'boolean', description: 'Validate the plan without lifting the gate.' },
        },
        required: ['summary', 'files', 'approach', 'verification'],
      },
    },
    {
      wireName: 'agent__plan_status',
      description: 'Read-only: whether plan mode or an RSA/T plan lock is currently blocking mutations.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__fetch',
      description: 'Read a public http(s) page/resource as text/markdown (binary rejected; use download).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL.' },
          format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Default markdown.' },
          maxLength: { type: 'number', description: 'Char cap (default 20000, max 100000).' },
        },
        required: ['url'],
      },
    },
    {
      wireName: 'agent__download',
      description: 'Download a file from a public URL into the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Source URL.' },
          path: { type: 'string', description: 'Destination path.' },
          overwrite: { type: 'boolean', description: 'Allow replacing (default false).' },
        },
        required: ['url', 'path'],
      },
    },
    {
      wireName: 'agent__vault_list',
      description: 'List pre-edit/pre-delete vault snapshots (workspace files live in <workspace>/.moriko/vault/<session>/, others in home vault; mention vault to the user only when asked about undo).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Path substring filter.' } },
      },
    },
    {
      wireName: 'agent__vault_diff',
      description: 'Preview unified diff between a vault snapshot (snapshotId) and the current file (or "to" path) without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          snapshotId: { type: 'string', description: 'Snapshot id.' },
          to: { type: 'string', description: 'Compare against this path instead of the original.' },
        },
        required: ['snapshotId'],
      },
    },
    {
      wireName: 'agent__vault_restore',
      description: 'Restore a vault snapshot — full file (default) or surgical line splice (rangeFrom..rangeTo, 1-based inclusive); snapshots existing target first ("pre-restore"), dryRun previews.',
      inputSchema: {
        type: 'object',
        properties: {
          snapshotId: { type: 'string', description: 'Snapshot id.' },
          to: { type: 'string', description: 'Alternative destination.' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
          rangeFrom: { type: 'number', description: 'Range restore: first line (1-based).' },
          rangeTo: { type: 'number', description: 'Range restore: last line (inclusive).' },
        },
        required: ['snapshotId'],
      },
    },
    {
      wireName: 'agent__run',
      description: 'Run a blocking shell command in the workspace for quick commands (self-destruction commands blocked; use agent__task_start for dev servers/long builds and agent__task_stop to stop them).',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line.' },
          cwd: { type: 'string', description: 'Working dir (default root).' },
          timeoutSec: { type: 'number', description: 'Timeout in seconds.' },
        },
        required: ['command'],
      },
    },
    {
      wireName: 'agent__git',
      description: 'Run a git sub-command (clone/push always ask first).',
      inputSchema: {
        type: 'object',
        properties: {
          subcommand: { type: 'string', description: 'The sub-command.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments.' },
          cwd: { type: 'string', description: 'Working dir.' },
        },
        required: ['subcommand'],
      },
    },
    {
      wireName: 'agent__remind',
      description: 'Schedule a reminder for this conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'What to remind about.' },
          at: { type: 'string', description: 'ISO timestamp (or inMinutes).' },
          inMinutes: { type: 'number', description: 'Relative minutes.' },
        },
        required: ['label'],
      },
    },
    {
      wireName: 'agent__harness_reload',
      description: 'Apply harness/source changes: typecheck gate, then graceful server reload.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__vision',
      description: 'Delegate an image to the configured multimodal model (text-only models ONLY; vision-capable models must open images directly via agent__read_file). Output is secondhand — always attribute ("<model> reports…"), never claim "I see…".',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What to ask (default: full description).' },
          path: { type: 'string', description: 'Workspace image path.' },
          url: { type: 'string', description: 'Public image URL.' },
          dataUrl: { type: 'string', description: 'data: URL.' },
        },
      },
    },
    {
      wireName: 'agent__vision_status',
      description: 'Report vision provider/model configuration.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__image',
      description:
        'Generate or edit an image with the configured image model (default = the user\'s saved Image Studio model). YOU compose the final prompt; pass reference image paths for edits.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The FINAL image prompt you composed — subject, style, composition, lighting. For edits: a precise instruction describing the change.',
          },
          referencePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              '0-8 reference images to EDIT: workspace/attachment paths (see the attachment list), /api/images/local/... URLs from previous results, data: URLs or public URLs. Omit for pure text-to-image.',
          },
          model: { type: 'string', description: 'Optional model override — only when the user names a model (see agent__image_models).' },
          providerId: { type: 'string', description: 'Optional provider override for the named model.' },
          aspectRatio: { type: 'string', description: 'Optional preset like "16:9" or "1:1".' },
          width: { type: 'number', description: 'Optional pixel width (64-4096; with height).' },
          height: { type: 'number', description: 'Optional pixel height (64-4096; with width).' },
        },
        required: ['prompt'],
      },
    },
    {
      wireName: 'agent__image_models',
      description: 'List the available image-generation models (provider, modes, reference capacity) and the saved default.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__explain_error',
      description: 'Call once on a pasted stack trace to resolve, read, and annotate matching workspace frames with edit read receipts.',
      inputSchema: {
        type: 'object',
        properties: { error: { type: 'string', description: 'Full error text.' } },
        required: ['error'],
      },
    },
    {
      wireName: 'agent__search',
      description: 'Lexical camelCase-aware BM25 search by keywords/meaning (limit default 10, max 30; cached index auto-invalidated on edits). Use when exact identifier is unknown, then follow with agent__read_file.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          limit: { type: 'number', description: 'Default 10, max 30.' },
        },
        required: ['query'],
      },
    },
    {
      wireName: 'agent__batch_read',
      description:
        'Read ANY number of files in one call. Every entry MUST carry its own maxLines limit (same per-file cap as read_file) — there is no default, no clamp, no file-count cap and no output truncation. Each file returns its numbered window, sha footer and read receipt.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'Files to read — unlimited count. One maxLines per file (required).',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path.' },
                maxLines: { type: 'number', description: 'REQUIRED per-file line limit — caller-chosen, no default or cap.' },
              },
              required: ['path', 'maxLines'],
            },
          },
        },
        required: ['files'],
      },
    },
    {
      wireName: 'agent__checkpoint',
      description: 'Snapshot all session-edited files (and freeze Layout IR) into a named checkpoint.',
      inputSchema: {
        type: 'object',
        properties: { label: { type: 'string', description: 'Checkpoint name.' } },
        required: ['label'],
      },
    },
    {
      wireName: 'agent__undo',
      description: 'Atomic checkpoint restore (latest if label omitted; undo is itself undoable). Inspect reported spatial drift and reintroduced collision candidates before finishing.',
      inputSchema: {
        type: 'object',
        properties: { label: { type: 'string', description: 'Checkpoint label.' } },
      },
    },
    {
      wireName: 'agent__checkpoint_list',
      description: 'List session checkpoints (label, time, file count).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__apply_patch',
      description: 'Multi-file git-style unified diff (---/+++ headers + @@ -oldStart,oldLines +newStart,newLines @@ coordinates; bare @@ rejected), atomic (any hunk fails = nothing written), read-window enforced, vaulted before write; use for cross-file refactors.',
      inputSchema: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Git-style unified diff.' },
          wordLevel: { type: 'boolean', description: 'Word-level diff rendering (default true).' },
        },
        required: ['patch'],
      },
    },
    {
      wireName: 'agent__deps',
      description: 'Import graph for one file: direct imports, dependents, and blast radius (≤3 hops). Check before renaming, moving, or changing signatures of shared files.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File to inspect.' } },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__glob',
      description: 'Flat file-path finder by pattern or patterns[] (OR), scoped via subpath, sorted by name|modified, maxResults default 200 (max 1000; heavy dirs skipped).',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern.' },
          patterns: { type: 'array', items: { type: 'string' }, description: 'Multiple patterns (OR).' },
          subpath: { type: 'string', description: 'Scope directory.' },
          sort: { type: 'string', enum: ['name', 'modified'], description: '"name" (default) or "modified".' },
          maxResults: { type: 'number', description: 'Cap (default 200, max 1000).' },
        },
      },
    },
    {
      wireName: 'agent__typecheck',
      description: 'Run pnpm typecheck (or custom command) with parsed, grouped errors (run ONLY when explicitly requested by the user).',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Override (default "pnpm typecheck").' },
          cwd: { type: 'string', description: 'Working dir.' },
        },
      },
    },
    {
      wireName: 'agent__screenshot',
      description:
        'Standalone headless screenshot of ANY http/https page (localhost or web) — INDEPENDENT of the Web Access toggle and of the built-in browser. Returns an inline JPEG + a text report: final URL/title/viewport, FCP/TTFB/LCP, and a numbered interactive-element map (n, role, text, box, selector hint) usable for click targeting and by text-only models. Ephemeral: no profile, no cookies, writes nothing to disk.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Page to capture (http/https; localhost fine).' },
          fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
          selector: { type: 'string', description: 'Photograph ONE element instead of the viewport.' },
          full: { type: 'boolean', description: 'Widen the interactive map (40 vs 20 elements).' },
        },
      },
    },
    {
      wireName: 'agent__backend',
      description: 'SQLite & OpenAPI contract tool (inert until a DB is opened). Modes: "open" ({ name } ephemeral in-memory SQLite, or { name, filePath } file-backed), "exec"/"query" (bounded SQL, max 500 rows, bound params[]), "fork" ({ name, forkName } clones schema+data for risky migrations without touching source), "discard", "list", "seed" (deterministic rows from table spec — kinds int/pick/name/email…, seed default 42), "contract_lint" (OpenAPI unresolved $refs / missing responses via spec or specPath), "contract_check" (validate request body against schema).',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['open', 'exec', 'query', 'fork', 'discard', 'list', 'seed', 'contract_lint', 'contract_check'], description: 'Operation.' },
          name: { type: 'string', description: 'Database handle.' },
          forkName: { type: 'string', description: 'fork: new branch name.' },
          filePath: { type: 'string', description: 'open: file-backed db.' },
          sql: { type: 'string', description: 'exec/query: SQL.' },
          params: { type: 'array', items: { type: 'string' }, description: 'Bind params.' },
          spec: { type: 'object', description: 'seed/contract: table spec or parsed OpenAPI.' },
          seed: { type: 'number', description: 'seed: deterministic seed (default 42).' },
          specPath: { type: 'string', description: 'contract: path to OpenAPI JSON.' },
          schema: { type: 'string', description: 'contract_check: schema name.' },
          body: { type: 'object', description: 'contract_check: request body.' },
        },
        required: ['mode'],
      },
    },
    {
      wireName: 'agent__spatial',
      description: 'Layout IR & UI geometry analyzer (prefer flow/flex/grid over magic-number absolute px). Modes: "map" (static layout candidates; snapshot:true returns raw JSON baseline), "check" (overlap candidates), "diff" (compare before/after baselines — only target regions may move, no new collisions), "runtime" ({ url } measures real DOM boxes in headless browser: hard overlaps, viewport overflow, tiny touch targets, screenshot; saveBaseline:true before UI edits; compareStatic:true shows source-vs-render drift), "mockup" ({ path|url|dataUrl } converts a design image into an estimated target Layout IR).',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['map', 'check', 'diff', 'runtime', 'mockup'], description: 'Which tier to run.' },
          snapshot: { type: 'boolean', description: 'map: raw JSON baseline.' },
          before: { type: 'string', description: 'diff: baseline JSON.' },
          after: { type: 'string', description: 'diff: current JSON.' },
          allowPublic: { type: 'boolean', description: 'runtime: allow a public host.' },
          screenshot: { type: 'boolean', description: 'runtime: include screenshot (default on).' },
          saveBaseline: { type: 'boolean', description: 'runtime: persist measured map.' },
          compareStatic: { type: 'boolean', description: 'runtime: static-vs-rendered drift.' },
          path: { type: 'string', description: 'mockup: design image path.' },
          url: { type: 'string', description: 'runtime: dev server url; mockup: image url.' },
          dataUrl: { type: 'string', description: 'mockup: data: URL.' },
        },
      },
    },
    {
      wireName: 'agent__layout_edit',
      description: 'Preferred declarative UI layout editor: apply a relation (move-right-of | move-below | swap | resize-relative | align) between target and reference region ids; compiler computes coordinates and vaults the file before write (dryRun to preview).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'CSS/JSX file with the target region.' },
          type: { type: 'string', enum: ['move-right-of', 'move-below', 'swap', 'resize-relative', 'align'], description: 'Relation.' },
          target: { type: 'string', description: 'Target region id.' },
          reference: { type: 'string', description: 'Reference region id.' },
          scale: { type: 'number', description: 'resize-relative: factor (default 1).' },
          axis: { type: 'string', enum: ['x', 'y', 'both'], description: 'resize-relative: dimension (default both).' },
          mode: { type: 'string', enum: ['left', 'top', 'center-x', 'center-y', 'right', 'bottom'], description: 'align: edge (default left).' },
          gap: { type: 'number', description: 'Px gap (default 0).' },
          dryRun: { type: 'boolean', description: 'Preview only.' },
        },
        required: ['path', 'type', 'target'],
      },
    },
    {
      wireName: 'agent__test_run',
      description: 'Run existing project tests (auto-detects vitest/jest/pytest/cargo/go, default node --test) with parsed per-file results (run ONLY when explicitly requested by the user; never author manual self-test scripts).',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Test files (overrides pattern).' },
          pattern: { type: 'string', description: 'Discovery glob (default "**/*.test.ts").' },
          cwd: { type: 'string', description: 'Working dir.' },
          timeoutSec: { type: 'number', description: 'Per-file timeout (default 120, max 600).' },
          runner: { type: 'string', enum: ['node', 'vitest', 'jest', 'pytest', 'cargo', 'go'], description: 'Force a runner (default: auto-detect).' },
        },
      },
    },
    {
      wireName: 'agent__task_start',
      description: 'Start a non-blocking background process (dev servers, long builds), returns taskId (48 KB rolling buffer, max 10 in-memory tasks).',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line.' },
          cwd: { type: 'string', description: 'Working dir.' },
        },
        required: ['command'],
      },
    },
    {
      wireName: 'agent__task_output',
      description: 'Read a background task output buffer and status (running/exited); optional waitMs (max 30000).',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task id.' },
          waitMs: { type: 'number', description: 'Wait before reading (max 30000).' },
        },
        required: ['taskId'],
      },
    },
    {
      wireName: 'agent__task_stop',
      description: 'Kill and remove a background task by taskId.',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'Task id.' } },
        required: ['taskId'],
      },
    },
    {
      wireName: 'agent__lsp_symbols',
      description: 'TS Language Service query (definition | references | symbols | rename | hover | diagnostics | implementations | type_definition | call_hierarchy). Use before renaming or changing shared symbols to find semantic references grep misses.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to inspect.' },
          mode: { type: 'string', enum: ['definition', 'references', 'symbols', 'rename', 'hover', 'diagnostics', 'implementations', 'type_definition', 'call_hierarchy'], description: 'Mode (default "symbols").' },
          line: { type: 'number', description: '1-based line.' },
          column: { type: 'number', description: '1-based column.' },
          newName: { type: 'string', description: 'New symbol name.' },
          direction: { type: 'string', enum: ['incoming', 'outgoing'], description: 'call_hierarchy direction (default "incoming").' },
          depth: { type: 'number', description: 'call_hierarchy depth 1-3 (default 1).' },
        },
        required: ['path', 'mode'],
      },
    },
    {
      wireName: 'agent__ask_user',
      description: 'Ask the user 1..8 concrete, one-sentence questions in one card ("text" free-form or "choice" with 2-8 options and optional allowCustom) for genuine ambiguity, design decisions, or missing info instead of guessing. Pauses until answered; if skipped/timed out, proceed with a sensible default, state the assumption, offer to revisit, and never re-block on the same question.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            description: 'Questions (max 8).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id (default q1..qN).' },
                question: { type: 'string', description: 'Question text.' },
                type: { type: 'string', enum: ['text', 'choice'], description: 'Default "text".' },
                choices: { type: 'array', items: { type: 'string' }, description: 'choice: 2-8 options ("options" alias).' },
                allowCustom: { type: 'boolean', description: 'choice: allow typed answer.' },
              },
              required: ['question'],
            },
          },
          timeoutSec: { type: 'number', description: 'Default 600, max 1800.' },
        },
        required: ['questions'],
      },
    },
    {
      wireName: 'agent__tree_outline',
      description: 'ASCII outline of the in-memory realtime project-structure index (depth 1-8 default 3, filter, maxEntries); use FIRST to orient.',
      inputSchema: {
        type: 'object',
        properties: {
          depth: { type: 'number', description: '1-8 (default 3).' },
          filter: { type: 'string', description: 'Case-insensitive substring.' },
          maxEntries: { type: 'number', description: '10-1000 (default 300).' },
        },
      },
    },
    {
      wireName: 'agent__tree_refresh',
      description: 'Force rebuild of the realtime structure index (e.g. after mass generation or git checkout).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__render_visual',
      description:
        'Render an inline live visual from a COMPLETE standalone HTML document (source ≤256 KB, height 120-2000 default 360; sandboxed: no network, no host access, no CDNs — inline all data/assets, or inject local vendor libs ["three","three-addons-orbit","pixi","matter","moriko-gl"]; payload never re-enters context). ' +
        'EDIT IN PLACE: pass the returned visual "id" on subsequent calls to replace that live card in place (only omit "id" for a genuinely new artifact). ' +
        'FRONTEND PREVIEW: pass "variants": [{ source, title?, height? }, ...] (1..3 complete candidates in one card); user selection arrives as a steer ("User picked <id>…"), then refine only that chosen "id" in place.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Complete HTML document (≤256 KB). Required unless "variants" is used.' },
          id: {
            type: 'string',
            description:
              'Existing visual id to update IN PLACE (edit-in-place) — the old card re-binds to this payload instead of spawning a new card.',
          },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', description: 'Complete HTML document (≤256 KB).' },
                title: { type: 'string', description: 'Candidate caption.' },
                height: { type: 'number', description: '120-2000 (default 360).' },
              },
            },
            description:
              'FRONTEND PREVIEW: 1..3 candidate documents [{ source, title?, height? }] shown side by side in one card; the user picks one and the pick is announced back to you.',
            maxItems: 3,
          },
          title: { type: 'string', description: 'Card caption.' },
          height: { type: 'number', description: '120-2000 (default 360).' },
          libs: { type: 'array', items: { type: 'string', enum: ['three', 'three-addons-orbit', 'pixi', 'matter', 'moriko-gl'] }, description: 'Vendor libraries injected client-side (window.THREE / PIXI / Matter / MORIKO_GL).' },
        },
      },
    },
    {
      wireName: 'agent__browser_open',
      description: 'Navigate the active tab (http(s) only; persistent profile, live panel + harness cursor; Google search via https://www.google.com/search?q=<encoded>). Always follow with agent__browser_wait before reading.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL.' },
          newTab: { type: 'boolean', description: 'Open in a new tab.' },
        },
        required: ['url'],
      },
    },
    {
      wireName: 'agent__browser_read',
      description: 'Read page (or element) innerText; truncated at 48k chars.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Read just this element.' },
          frame: { type: 'string', description: 'iframe selector.' },
          maskSensitive: { type: 'boolean', description: 'Mask passwords/cards (default true).' },
        },
      },
    },
    {
      wireName: 'agent__browser_screenshot',
      description: 'PNG screenshot (vision gate; needs a vision-capable model — prefer agent__browser_snapshot for page inspection).',
      inputSchema: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
          selector: { type: 'string', description: 'Clip to this element.' },
          frame: { type: 'string', description: 'Capture inside this iframe.' },
        },
      },
    },
    {
      wireName: 'agent__browser_snapshot',
      description:
        'ONE-call page observer (replaces chromedev screenshot): navigate (url?), capture, and return page context + inline JPEG. Text-first: URL/title/viewport/scroll, FCP/TTFB/LCP, console errors + warnings, failed 4xx/5xx requests, and a numbered interactive-element map (n, role, text, box, selector hint) for precise click targeting. Works for text-only models (metadata without the image).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Navigate first (http/https). Optional — defaults to the active tab.' },
          selector: { type: 'string', description: 'Photograph ONE element instead of the viewport.' },
          fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
          full: { type: 'boolean', description: 'Widen the interactive map (40 vs 20 elements).' },
        },
      },
    },
    {
      wireName: 'agent__browser_wait',
      description: 'Wait for selector state / load state / url / text / function before acting.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector.' },
          state: { type: 'string', description: 'visible | hidden | attached | detached.' },
          loadState: { type: 'string', description: 'commit | domcontentloaded | load | networkidle.' },
          url: { type: 'string', description: 'Glob or /regex/.' },
          text: { type: 'string', description: 'Body text to appear.' },
          function: { type: 'string', description: 'JS returning truthy.' },
          frame: { type: 'string', description: 'iframe selector.' },
          timeoutMs: { type: 'number', description: 'Default 15000, max 60000.' },
        },
      },
    },
    {
      wireName: 'agent__browser_eval',
      description: 'Evaluate JS in the page context (not Node); getBoundingClientRect for coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JS expression/function.' },
          frame: { type: 'string', description: 'iframe selector.' },
        },
        required: ['script'],
      },
    },
    {
      wireName: 'agent__browser_url',
      description: 'Current tab URL + title.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_click',
      description: 'Click at coordinates or selector; blocked during takeover.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Viewport px.' },
          y: { type: 'number', description: 'Viewport px.' },
          selector: { type: 'string', description: 'CSS selector (scrolls into view).' },
          frame: { type: 'string', description: 'iframe selector.' },
          button: { type: 'string', description: 'left (default) | right.' },
          clickCount: { type: 'number', description: 'Clicks to send (default 1).' },
        },
      },
    },
    {
      wireName: 'agent__browser_type',
      description: 'Type text; with a selector fill() replaces content. Blocked during takeover.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text.' },
          selector: { type: 'string', description: 'Field selector.' },
          pressEnter: { type: 'boolean', description: 'Enter after typing.' },
          delayMs: { type: 'number', description: 'Per keystroke 0-250 (default 0).' },
        },
        required: ['text'],
      },
    },
    {
      wireName: 'agent__browser_cursor_move',
      description: 'Move the harness cursor (shows intent, triggers hover); blocked during takeover.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Viewport px.' },
          y: { type: 'number', description: 'Viewport px.' },
          steps: { type: 'number', description: 'Interpolation steps for the ring travel.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      wireName: 'agent__browser_scroll',
      description: 'Mouse-wheel scroll (up/down/left/right); blocked during takeover.',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: 'up | down (default) | left | right.' },
          amount: { type: 'number', description: 'Px (50-5000, default 900).' },
          selector: { type: 'string', description: 'Hover first for inner containers.' },
        },
      },
    },
    {
      wireName: 'agent__browser_handover',
      description: 'Give the user takeover mode (logins, captchas, 2FA, payment).',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'Note shown on the panel.' } },
      },
    },
    {
      wireName: 'agent__browser_release',
      description: 'End takeover; input tools work again.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_tabs',
      description: 'List tabs (id, URL, title, active).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_switch_tab',
      description: 'Make another tab active.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string', description: 'Tab id.' } },
        required: ['tabId'],
      },
    },
    {
      wireName: 'agent__browser_close_tab',
      description: 'Close a tab (default: the active one).',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string', description: 'Tab id.' } },
      },
    },
    {
      wireName: 'agent__browser_clear_data',
      description: 'Clear persistent-profile data (cookies/storage/cache); irreversible.',
      inputSchema: {
        type: 'object',
        properties: {
          cookies: { type: 'boolean', description: 'Default true.' },
          storage: { type: 'boolean', description: 'Default true.' },
          cache: { type: 'boolean', description: 'Default true.' },
        },
      },
    },
    {
      wireName: 'agent__browser_drag',
      description: 'Interpolated drag (from → to); blocked during takeover.',
      inputSchema: {
        type: 'object',
        properties: {
          fromX: { type: 'number', description: 'Start X.' },
          fromY: { type: 'number', description: 'Start Y.' },
          toX: { type: 'number', description: 'End X.' },
          toY: { type: 'number', description: 'End Y.' },
          steps: { type: 'number', description: 'Interpolation (default 24, max 200).' },
          button: { type: 'string', description: 'left (default) | right | middle.' },
          delayMs: { type: 'number', description: 'Per step (default 8).' },
        },
        required: ['fromX', 'fromY', 'toX', 'toY'],
      },
    },
    {
      wireName: 'agent__browser_mouse_down',
      description: 'Press-and-hold at (x,y) — start of a multi-segment stroke.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X px.' },
          y: { type: 'number', description: 'Y px.' },
          button: { type: 'string', description: 'left (default) | right | middle.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      wireName: 'agent__browser_mouse_up',
      description: 'Release the held button — ends a stroke.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Optional final X.' },
          y: { type: 'number', description: 'Optional final Y.' },
          button: { type: 'string', description: 'Must match the held button.' },
        },
      },
    },
    {
      wireName: 'agent__browser_hover',
      description: 'Hover a selector/point (dropdowns, tooltips).',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector.' },
          x: { type: 'number', description: 'Alternative to selector.' },
          y: { type: 'number', description: 'Y px.' },
        },
      },
    },
    {
      wireName: 'agent__browser_press',
      description: 'Press a key or chord (Escape, Control+a…); blocked during takeover.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key or chord.' },
          holdMs: { type: 'number', description: 'Hold duration (default 0 = tap).' },
        },
        required: ['key'],
      },
    },
    {
      wireName: 'agent__browser_back',
      description: 'History back.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_forward',
      description: 'History forward.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_reload',
      description: 'Reload the active page.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_inspect',
      description: 'What element sits at (x,y); read-only, verifies a click target.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X px.' },
          y: { type: 'number', description: 'Y px.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      wireName: 'agent__browser_semantic',
      description: 'Structured snapshot of interactive elements + headings with rects.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Scope sub-tree (default body).' },
          maxDepth: { type: 'number', description: 'DOM depth (default 8).' },
          maxElements: { type: 'number', description: 'Default 200.' },
        },
      },
    },
    {
      wireName: 'agent__browser_form',
      description: 'Form comprehension: fields, labels, options; passwords masked.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'Specific form (default all).' } },
      },
    },
    {
      wireName: 'agent__browser_read_article',
      description: 'Readability extraction as clean markdown.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'Force a container.' } },
      },
    },
    {
      wireName: 'agent__browser_watch',
      description: 'Snapshot an element pre-action; pair with browser_watch_result.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'Selector to monitor.' } },
        required: ['selector'],
      },
    },
    {
      wireName: 'agent__browser_watch_result',
      description: 'Diff the watched element after acting (no screenshot).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_metadata',
      description: 'Meta tags, OpenGraph, JSON-LD, canonical, favicon.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_save_page',
      description: 'Save the page main content into the workspace as markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace .md path.' },
          selector: { type: 'string', description: 'Force a container.' },
        },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__browser_save_images',
      description: 'Download the page images into a workspace dir.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Workspace dir.' },
          minWidth: { type: 'number', description: 'Skip narrower (default 100).' },
          limit: { type: 'number', description: 'Default 30, max 100.' },
        },
        required: ['dir'],
      },
    },
    {
      wireName: 'agent__browser_upload',
      description: 'Upload a workspace file into a page file input.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'File input selector.' },
          path: { type: 'string', description: 'Workspace file path.' },
        },
        required: ['selector', 'path'],
      },
    },
    {
      wireName: 'agent__browser_download',
      description: 'Click a trigger and capture the download into the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Download trigger.' },
          x: { type: 'number', description: 'Alternative to selector.' },
          y: { type: 'number', description: 'Y px.' },
          dir: { type: 'string', description: 'Destination dir.' },
        },
      },
    },
    {
      wireName: 'agent__browser_table',
      description: 'Extract a <table> as JSON/CSV/TSV.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Table selector.' },
          format: { type: 'string', description: 'json (default) | csv | tsv.' },
        },
      },
    },
    {
      wireName: 'agent__browser_pdf',
      description: 'Print the page to a workspace PDF.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace .pdf path.' },
          format: { type: 'string', description: 'A4 (default) | Letter | Legal | A3 | A5.' },
        },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__browser_crawl',
      description: 'Paginated collection: extract items, click next, save the dataset.',
      inputSchema: {
        type: 'object',
        properties: {
          itemSelector: { type: 'string', description: 'Item selector.' },
          nextSelector: { type: 'string', description: 'Next-page selector.' },
          extract: { type: 'string', description: '(el) => ({...}) per item.' },
          maxPages: { type: 'number', description: 'Default 10, max 50.' },
          path: { type: 'string', description: 'Dataset JSON path.' },
        },
        required: ['itemSelector', 'nextSelector', 'extract'],
      },
    },
    {
      wireName: 'agent__browser_block_requests',
      description: 'Abort requests matching URL globs (faster, private pages).',
      inputSchema: {
        type: 'object',
        properties: {
          patterns: { type: 'array', items: { type: 'string' }, description: 'URL globs.' },
        },
        required: ['patterns'],
      },
    },
    {
      wireName: 'agent__browser_unblock_requests',
      description: 'Clear all request blocks.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_audit_log',
      description: 'Session browser action trail (last 500).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_request_approval',
      description: 'Ask user approval BEFORE a destructive browser action (delete, payment, settings); timeout/abort = denied — never retry past a denial.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Human description.' },
        },
        required: ['action'],
      },
    },
    {
      wireName: 'agent__browser_plan',
      description: 'Submit an ordered step list for user approval before sensitive flows.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, description: 'Ordered steps (max 20).' },
        },
        required: ['steps'],
      },
    },
    {
      wireName: 'agent__browser_debug',
      description: 'Diagnostics since the last action (console, page errors, HTTP, top element).',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Optional click point.' },
          y: { type: 'number', description: 'Optional click point.' },
        },
      },
    },
    {
      wireName: 'agent__browser_install_script',
      description: 'Install a persistent userscript (name + glob + JS).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name.' },
          matches: { type: 'string', description: 'URL glob.' },
          script: { type: 'string', description: 'JS source (≤20k chars).' },
        },
        required: ['name', 'matches', 'script'],
      },
    },
    {
      wireName: 'agent__browser_list_scripts',
      description: 'List installed userscripts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_remove_script',
      description: 'Remove a userscript from the registry.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Script name.' } },
        required: ['name'],
      },
    },
    {
      wireName: 'agent__browser_baseline',
      description: 'Save the page as a PNG baseline for visual regression.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace .png path.' } },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__browser_visual_diff',
      description: 'Pixel-compare the page against a saved baseline (inline diff image).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Baseline .png.' } },
        required: ['path'],
      },
    },
    {
      wireName: 'agent__browser_merge_tabs',
      description: 'Run one extractor across open tabs, merge results.',
      inputSchema: {
        type: 'object',
        properties: {
          extract: { type: 'string', description: 'JS per tab.' },
          tabIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to tabs.' },
          path: { type: 'string', description: 'Save merged JSON.' },
        },
        required: ['extract'],
      },
    },
    {
      wireName: 'agent__browser_fan_out',
      description: 'Open 1-10 URLs in parallel ephemeral tabs, extract, collect.',
      inputSchema: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'URLs (1-10).' },
          extract: { type: 'string', description: 'JS per page.' },
          path: { type: 'string', description: 'Save results JSON.' },
        },
        required: ['urls', 'extract'],
      },
    },
    {
      wireName: 'agent__browser_mark',
      description: 'Attach a note to an element (persistent per URL).',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Element.' },
          note: { type: 'string', description: 'Note (≤300 chars).' },
          persistent: { type: 'boolean', description: 'Store in localStorage.' },
        },
        required: ['selector', 'note'],
      },
    },
    {
      wireName: 'agent__browser_marks',
      description: 'Read the current page marks.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__browser_record',
      description: 'Record user takeover actions into a replayable macro.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Macro name.' },
          record: { type: 'boolean', description: 'true = start, false = stop + save.' },
        },
        required: ['name', 'record'],
      },
    },
    {
      wireName: 'agent__browser_replay',
      description: 'Re-execute a recorded macro.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Macro name.' },
          speed: { type: 'number', description: 'Multiplier 0.1-10 (default 1).' },
        },
        required: ['name'],
      },
    },
    {
      wireName: 'agent__browser_touch_tap',
      description: 'Tap with the touchscreen (touch-only handlers).',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X px.' },
          y: { type: 'number', description: 'Y px.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      wireName: 'agent__browser_dialog',
      description: 'Set the alert/confirm/prompt policy BEFORE the triggering action.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'accept | dismiss | default.' },
          text: { type: 'string', description: 'prompt() text when accepting.' },
        },
      },
    },
    {
      wireName: 'agent__browser_annotations',
      description: 'Read (and clear) the user panel annotations + hint-cursor position.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      wireName: 'agent__addon_manage',
      description:
        `Manage Moriko addons — the Addon Manager. Builtin addons live in addons-src/<id>/ (always agent-accessible; full file tools also work on addons-src/... paths; builtin ids: ${builtinAddonIds().join(', ')}). ` +
        'Actions: list | read { id, file? } | write { id, file, content } | enable/disable { id } | install { id, name?, description?, version?, registerCode?, clientCode? } | edit { id, ...same fields } | remove { id } (USER-ONLY — always refused; user removes via Addon Hub) | reload. ' +
        'For builtin ids, read/write/install/edit operate on addons-src/<id>/ and go live when the user clicks Disable/Reload in the Addon Hub (tell the user when done); third-party addons live under ~/.moriko-studio/addons/<id>/ and hot-reload immediately (fix loadError by reading/rewriting register.ts). ' +
        'Authoring pattern (register.ts): export register(on, $); register hooks via on(event, matcher?, async ($, e, next) => ...) on events "tool.call" {tool,args}, "tool.result" {tool,result}, "turn.start"/"turn.end", "session.open", "command.run" {command,args}, "ui.render" {site} — return next(e) to observe, next({ ...e, ... }) to rewrite, or { deny: "reason" } without next to block (.catch(fn) fails closed per hook). ' +
        '$ API: $.tool.register({ name, description, inputSchema, execute }) / $.tool.call(wireName, args), $.ui.draw(site, { type: "widget", component: "./client/index.tsx" }) (sites: thread-sidebar, composer-band, right-dock, floating) + $.ui.log/toast, $.command.register({ name, description }), $.store (get/set/delete), $.http.fetch, $.fs (addon-root scoped), $.workspace (ACTIVE workspace jailed read/write/list/exists), $.bus.publish/subscribe (cross-session pub/sub + SSE /api/addons/events), $.context.provide(title, lines)/revoke(title) (live system-prompt block across sessions), $.clock.every/after/sleep. ' +
        'Widget (client/index.tsx): self-contained default-export React component (import only react; subscribe via EventSource("/api/addons/events") for realtime updates).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | read | write | enable | disable | install | edit | remove | reload' },
          id: { type: 'string', description: 'Addon id (directory name) — required for all actions except list/reload.' },
          file: { type: 'string', description: 'read/write: file path relative to the addon root (e.g. addon.json, client/index.tsx, lib/util.ts).' },
          content: { type: 'string', description: 'write: full new file content.' },
          name: { type: 'string', description: 'install/edit: display name.' },
          description: { type: 'string', description: 'install/edit: description.' },
          version: { type: 'string', description: 'install/edit: semver.' },
          registerCode: { type: 'string', description: 'install/edit: full register.ts source (exports register(on, $)).' },
          clientCode: { type: 'string', description: 'install/edit: React widget component source, written to client/index.tsx.' },
        },
        required: ['action'],
      },
    },
    {
      wireName: 'agent__exec',
      description:
        'Tool-call orchestrator: run ONE JS program (top-level await supported) composing multiple tools in a Node vm sandbox with zero model round-trips; nested calls still pass all harness gates (schema, read/spatial gates, workspace jail, approvals, audit). ' +
        'Use for 3+ parallel reads/searches (Promise.allSettled), conditional chains, or paging/retry loops; skip for 1-2 sequential calls, and yield to the model before visual judgment steps. ' +
        'Sandbox globals ONLY: tools.<shortName>(args) (e.g. tools.read_file, tools.grep — each returns { ok, isError, text }), text(out) (ONLY text() output re-enters model context — filter aggressively), store(k,v)/load(k) (persist across exec calls in session), notify(msg), exit(), setTimeout/clearTimeout, JS intrinsics (no Node, require, process, fs, or network). ' +
        'Limits: timeout 30s default (max 120s via timeoutMs), max 200 nested calls, 48k chars output.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JS source; top-level await supported.' },
          timeoutMs: { type: 'number', description: 'Default 30000, max 120000.' },
        },
        required: ['code'],
      },
    },
  ];
  const addonDefs = listAddonToolDefs();
  if (addonDefs.length > 0) defs.push(...addonDefs);
  defs.push(...registeredTools().map((tool) => tool.def));
  return defs;
}
