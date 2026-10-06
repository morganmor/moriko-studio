import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { Router } from 'express';

import { asyncRoute, HttpError } from '../http.js';
import { readAudit } from './audit.js';
import {
  decidePermission,
  listPendingPermissions,
  revokeAllGrants,
} from './permissions.js';
import { answerQuestions, extendQuestionTimeout, listPendingQuestions } from './tools/ask.js';
import {
  addAllowedDir,
  addWorkspace,
  getActiveWorkspace,
  isInsideRoot,
  listAllowedDirs,
  listWorkspaces,
  removeAllowedDir,
  removeWorkspace,
  setActiveWorkspace,
} from './workspace.js';
import { callAgentTool, listAgentToolDefs } from './tools/index.js';
import { publishBusEvent } from '../addons/bus.js';
import { resolveVisualPick, VISUAL_BUS_TOPICS } from './tools/visual.js';
import { browserManager } from './browser/manager.js';
import { harnessReloadNow } from './reload.js';
import { jobStore, type JobRecord, type RunSummary } from './journal.js';
import { pickNativeFolder } from './nativePick.js';
import { listSnapshots, purgeSnapshot, restoreSnapshot, snapshotFile } from './vault.js';
import { buildUnifiedDiff, diffStatFromOps } from './diff.js';
import {
  dropTree,
  getRules,
  getTree,
  refreshTree,
  setRules,
  subscribeTree,
} from './treeIndex.js';
import type { IgnoreRules } from './treeIndex.js';

/** Validates a PUT /tree/:id/rules body into clean IgnoreRules. */
function sanitizeTreeRules(input: unknown): IgnoreRules {
  const raw = (input ?? {}) as { dirs?: unknown; patterns?: unknown };
  const pick = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 64)
      : [];
  return { dirs: pick(raw.dirs), patterns: pick(raw.patterns) };
}

/**
 * REST surface for the built-in agent harness:
 *
 *   GET    /api/agent/workspaces          — registry + activeId
 *   POST   /api/agent/workspaces          — register a directory { path, label? }
 *   DELETE /api/agent/workspaces/:id      — remove from the registry (disk untouched)
 *   PUT    /api/agent/workspaces/active   — set the active one { id }
 *   GET    /api/agent/browse?path=…       — read-only directory listing for the picker
 *   POST   /api/agent/call                — debug/inspection helper: run one harness tool
 *   GET    /api/agent/permissions         — pending outside-workspace permission requests
 *   POST   /api/agent/permissions/:id/decision — user decision { approve, remember? }
 *   GET    /api/agent/vault?session=…     — file snapshots (the undo system)
 *   POST   /api/agent/vault/restore       — restore a snapshot { session, snapshotId, to? }
 *   POST   /api/agent/vault/remove-created — delete an agent-created file { session, path }
 *   DELETE /api/agent/vault/:id?session=… — permanently purge one snapshot
 *   POST   /api/agent/harness-reload      — typecheck gate + graceful server reload
 *
 * The browse route exists for the Explorer-style folder picker: it is
 * strictly read-only and never mutates anything.
 */

/** One row of the picker's listing (Explorer-style table). */
interface BrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'drive';
  mtimeMs?: number;
  size?: number | null;
}

/** Drive roots on Windows, "/" elsewhere — the picker's starting level. */
function listRoots(): BrowseEntry[] {
  if (process.platform === 'win32') {
    const roots: BrowseEntry[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        if (existsSync(drive)) {
          roots.push({ name: drive, path: drive, kind: 'drive', size: null });
        }
      } catch {
      }
    }
    return roots;
  }
  return [{ name: '/', path: '/', kind: 'drive', size: null }];
}

/** Combined dirs+files cap per listing (the client paginates visually anyway). */
const MAX_LISTED_ENTRIES = 800;

export function agentRouter(): Router {
  const router = Router();

  /**
   * BROWSER PANEL — the URL the SPA opens in a new tab/window when the agent
   * drives the built-in browser. The panel itself connects over WebSocket
   * (see browser/ws.ts) and never needs this route again after launch.
   *
   *   GET /api/agent/browser/panel-url?session=…
   */
  router.get(
    '/browser/panel-url',
    asyncRoute(async (req, res) => {
      const session = String(req.query.session ?? '').trim();
      const query = session ? `?session=${encodeURIComponent(session)}` : '';
      if (browserManager.isWebAccessOn() === false) {
        throw new HttpError(403, 'Web access is OFF — the built-in browser is disabled (Configuration → Tools → Web Access).');
      }
      void browserManager.ensureContext().catch(() => undefined);
      res.json({ panelUrl: `/browser-view.html${query}` });
    }),
  );

  /**
   * WEB ACCESS KILL-SWITCH — the SPA calls this whenever the Web Access
   *   toggle changes value. `on: true` merely arms the gate; `on: false`
   *   broadcasts shutdown to every open panel (they close their own
   *   windows) and tears down the shared Edge context so nothing keeps
   *   running in the background.
   *
   *   POST /api/agent/browser/web-access  { on: boolean }
   */
  router.post(
    '/browser/web-access',
    asyncRoute(async (req, res) => {
      const body = req.body as { on?: unknown };
      await browserManager.setWebAccess(body?.on === true);
      res.json({ ok: true, webAccess: body?.on === true });
    }),
  );

  /**
   * Immediate teardown + panel shutdown — used on harness exit and by
   * scripts. Same effect as Web Access off, without flipping the gate.
   *
   *   POST /api/agent/browser/close
   */
  router.post(
    '/browser/close',
    asyncRoute(async (_req, res) => {
      await browserManager.close();
      res.json({ ok: true });
    }),
  );

  /**
   * DURABLE RUNS — the job journal's read surface (see docs/ARCHITECTURE.md).
   *   GET /api/agent/runs?sessionId=…  — a session's runs, newest first
   *   GET /api/agent/runs/:id           — one run's full record incl. call log
   *
   * No writes: status transitions happen only in the chat route and the boot
   * sweep, never here.
   */
  router.get(
    '/runs',
    asyncRoute(async (req, res) => {
      const raw = String(req.query.sessionId ?? '').trim();
      const sessionId = raw || undefined;
      const runs: RunSummary[] = jobStore.listBySession(sessionId);
      res.json({ runs });
    }),
  );

  router.get(
    '/runs/:id',
    asyncRoute(async (req, res) => {
      const run: JobRecord | null = jobStore.getRun(req.params.id);
      if (!run) throw new HttpError(404, `Unknown run "${req.params.id}".`);
      res.json({ run });
    }),
  );

  router.get('/workspaces', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const store = listWorkspaces();
    const activeId = getActiveWorkspace(sessionId || undefined)?.id ?? null;
    res.json({ workspaces: store, activeId });
  });

  /**
   * VISUAL v2 PICK — the user chose one frontend-preview candidate. Broadcasts
   * the decision to every other browser (their card re-binds the chosen frame)
   * and returns the tool_result-shaped sentence the client turns into a steer
   * so the RUNNING model learns the pick between tool rounds.
   *
   *   POST /api/agent/visual/pick  { visualId, variantId, variantIndex?, title? }
   */
  router.post('/visual/pick', (req, res) => {
    const body = (req.body ?? {}) as {
      visualId?: unknown;
      variantId?: unknown;
      variantIndex?: unknown;
      title?: unknown;
    };
    const resolved = resolveVisualPick(body);
    if (!resolved) {
      throw new HttpError(400, 'visual pick needs "visualId" and "variantId" (strings).');
    }
    void publishBusEvent(VISUAL_BUS_TOPICS.pick, {
      visualId: body.visualId,
      variantId: body.variantId,
      variantIndex: typeof body.variantIndex === 'number' ? body.variantIndex : undefined,
    }, 'visual-pick');
    res.json({ ok: true, steerText: resolved.steerText });
  });

  router.post(
    '/workspaces',
    asyncRoute(async (req, res) => {
      const body = req.body as { path?: unknown; label?: unknown };
      if (typeof body?.path !== 'string' || !body.path.trim()) {
        throw new HttpError(400, 'A directory "path" is required.');
      }
      try {
        const workspace = addWorkspace(body.path, typeof body.label === 'string' ? body.label : undefined);
        res.status(201).json({ workspace });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid workspace path.');
      }
    }),
  );

  router.delete(
    '/workspaces/:id',
    asyncRoute(async (req, res) => {
      if (!removeWorkspace(req.params.id)) {
        throw new HttpError(404, `Unknown workspace "${req.params.id}".`);
      }
      dropTree(req.params.id);
      res.json({ ok: true });
    }),
  );

  router.put(
    '/workspaces/active',
    asyncRoute(async (req, res) => {
      const body = req.body as { id?: unknown; sessionId?: unknown };
      if (typeof body?.id !== 'string' || !body.id) {
        throw new HttpError(400, 'A workspace "id" is required.');
      }
      // selection is global (legacy behavior, kept for scripts/debugging).
      const sessionId =
        typeof body?.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined;
      try {
        const workspace = setActiveWorkspace(body.id, sessionId);
        res.json({ ok: true, activeId: workspace.id, workspace });
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : 'Unknown workspace.');
      }
    }),
  );

  /**
   * NATIVE device folder picker (Windows FolderBrowserDialog via the local
   * proxy's PowerShell). Resolves { path: string | null } — null when the
   * user cancels or no native dialog is available.
   */
  router.post(
    '/native-pick',
    asyncRoute(async (_req, res) => {
      const picked = await pickNativeFolder();
      res.json({ path: picked });
    }),
  );


  /** Per-workspace tree payload shape (routes + SSE agree on this). */
  const treePayload = (workspaceId: string) => {
    const view = getTree(workspaceId);
    if (!view) return null;
    return {
      workspaceId,
      version: view.version,
      builtAt: view.builtAt,
      stats: view.stats,
      refreshing: view.refreshing,
      root: view.root,
    };
  };

  /** GET /api/agent/tree?workspaceId=… — the full tree (from MEMORY). */
  router.get('/tree', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    const payload = workspaceId ? treePayload(workspaceId) : null;
    if (!payload) throw new HttpError(404, 'No tree for that workspace (unknown id or folder missing).');
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  /** POST /api/agent/tree/:id/refresh — force one rebuild walk. */
  router.post(
    '/tree/:workspaceId/refresh',
    asyncRoute(async (req, res) => {
      await refreshTree(req.params.workspaceId);
      const payload = treePayload(req.params.workspaceId);
      if (!payload) throw new HttpError(404, 'No tree for that workspace.');
      res.json(payload);
    }),
  );

  router.get('/tree/:workspaceId/rules', (req, res) => {
    res.json({ rules: getRules(req.params.workspaceId) });
  });

  router.put(
    '/tree/:workspaceId/rules',
    asyncRoute(async (req, res) => {
      const body = req.body as { rules?: unknown };
      if (!getTree(req.params.workspaceId)) {
        throw new HttpError(404, 'No tree for that workspace (unknown id or folder missing).');
      }
      const applied = setRules(req.params.workspaceId, sanitizeTreeRules(body?.rules));
      res.json({ rules: applied });
    }),
  );
  /**
   * GET /api/agent/tree/events?workspaceId=… — the realtime channel.
   *
   * An SSE stream of { type:'tree_hello', version } followed by
   * { type:'tree_delta', … } frames (the same shapes the in-stream
   * `tree_update` event carries, minus
   * the sessionId). The channel is IDLE-path only: while a chat stream runs,
   * tree deltas ride it as `tree_update` events; this endpoint covers the
   * panel when no chat is generating. Heartbeat every 20s; auto-closes when
   * the workspace is removed.
   */
  router.get('/tree/events', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId || !getTree(workspaceId)) {
      throw new HttpError(404, 'No tree for that workspace (unknown id or folder missing).');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const write = (payload: unknown): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const current = getTree(workspaceId);
    write({ type: 'tree_hello', workspaceId, version: current?.version ?? 0 });

    const unsubscribe = subscribeTree(workspaceId, (event) => {
      write({ type: 'tree_delta', ...event });
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /**
   * GRACEFUL HARNESS RELOAD — the manual/HTTP twin of agent__harness_reload.
   * Runs the typecheck apply-gate, then schedules an exit(75) the supervisor
   * restarts from; the exit waits until no chat stream is active. 409 with
   * the compiler output when the gate refuses.
   */
  router.post(
    '/harness-reload',
    asyncRoute(async (_req, res) => {
      const outcome = await harnessReloadNow();
      res.status(outcome.ok ? 200 : 409).json(outcome);
    }),
  );

  router.get(
    '/browse',
    asyncRoute(async (req, res) => {
      const raw = String(req.query.path ?? '').trim();

      if (!raw) {
        res.json({ path: null, parent: null, entries: listRoots() });
        return;
      }

      const resolved = path.resolve(raw);
      let stats;
      try {
        stats = statSync(resolved);
      } catch {
        throw new HttpError(400, `"${resolved}" does not exist.`);
      }
      if (!stats.isDirectory()) throw new HttpError(400, `"${resolved}" is not a directory.`);

      let entries: BrowseEntry[] = [];
      try {
        const dirents = readdirSync(resolved, { withFileTypes: true });
        for (const entry of dirents) {
          if (entries.length >= MAX_LISTED_ENTRIES) break;
          const full = path.join(resolved, entry.name);
          if (entry.isDirectory()) {
            entries.push({ name: entry.name, path: full, kind: 'dir', size: null });
          } else if (entry.isFile()) {
            entries.push({ name: entry.name, path: full, kind: 'file', size: null });
          }
        }
        for (const entry of entries) {
          try {
            const entryStats = statSync(entry.path);
            entry.mtimeMs = entryStats.mtimeMs;
            if (entry.kind === 'file') entry.size = entryStats.size;
          } catch {
          }
        }
      } catch (error) {
        throw new HttpError(
          400,
          `Cannot read "${resolved}": ${error instanceof Error ? error.message : 'permission denied'}`,
        );
      }

      const parent = path.dirname(resolved);
      res.json({
        path: resolved,
        parent: parent === resolved ? null : parent,
        entries,
      });
    }),
  );

  /**
   * Forget every "Allow for this session" grant (paths + commands). The
   * grants file is what survives harness reloads; this clears it.
   */
  router.delete(
    '/permissions/grants',
    (_req, res) => {
      revokeAllGrants();
      res.json({ ok: true });
    },
  );

  /**
   * Debug/inspection helper (mirrors the MCP `/call` route): run one harness
   * tool against the ACTIVE workspace without going through a model round —
   * this is what `scripts/test-agent-e2e.mjs` drives. Outside-workspace
   * targets pause here too; decide them via the permission endpoints.
   */
  router.post(
    '/call',
    asyncRoute(async (req, res) => {
      const body = req.body as { tool?: unknown; args?: unknown; sessionId?: unknown };
      if (typeof body?.tool !== 'string' || !body.tool.trim()) {
        throw new HttpError(400, 'A "tool" name is required.');
      }
      const callSessionId =
        typeof body?.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined;
      // No-workspace agent mode: the debug call route no longer hard-requires
      // a workspace — workspace-attached tools answer with their own readable
      // error when no root exists (same contract as the live loop).
      const wireName = body.tool.startsWith('agent__') ? body.tool : `agent__${body.tool}`;
      if (!listAgentToolDefs().some((def) => def.wireName === wireName)) {
        throw new HttpError(400, `Unknown agent tool "${wireName}".`);
      }
      const args =
        body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? (body.args as Record<string, unknown>)
          : {};
      res.json(
        await callAgentTool(wireName, args, callSessionId ? { sessionId: callSessionId } : {}),
      );
    }),
  );


  /** Undecided requests (for UI reconnects; the live stream is the primary path). */
  router.get('/permissions', (_req, res) => {
    res.json({ requests: listPendingPermissions() });
  });

  router.post(
    '/permissions/:id/decision',
    asyncRoute(async (req, res) => {
      const body = req.body as { approve?: unknown; remember?: unknown };
      if (typeof body?.approve !== 'boolean') {
        throw new HttpError(400, 'A boolean "approve" is required.');
      }
      const applied = decidePermission(req.params.id, body.approve, body.remember === true);
      if (!applied) {
        throw new HttpError(404, 'Unknown or already-decided permission request.');
      }
      res.json({ ok: true, granted: body.approve });
    }),
  );


  /** Undecided question batches (for polling / reconnects). */
  router.get('/ask-user', (_req, res) => {
    res.json({ requests: listPendingQuestions() });
  });

  /**
   * Tab-hidden keepalive (C3): push the auto-skip deadline forward while the
   * user cannot see the card. Client heartbeats here; a settled batch just
   * answers ok:false (harmless).
   */
  router.post('/ask-user/:id/extend', (req, res) => {
    const body = req.body as { ms?: unknown };
    const ms =
      typeof body?.ms === 'number' && Number.isFinite(body.ms)
        ? body.ms
        : 10 * 60 * 1000;
    res.json({ ok: extendQuestionTimeout(req.params.id, ms) });
  });

  router.post(
    '/ask-user/:id/answer',
    asyncRoute(async (req, res) => {
      const body = req.body as { answers?: unknown };
      if (!Array.isArray(body?.answers)) {
        throw new HttpError(400, 'An "answers" array is required (one entry per question, with { id, answer } or { id, skipped: true }).');
      }
      const applied = answerQuestions(req.params.id, body.answers);
      if (!applied) {
        throw new HttpError(404, 'Unknown or already-answered question batch.');
      }
      res.json({ ok: true });
    }),
  );


  router.get('/vault', (req, res) => {
    const session = typeof req.query.session === 'string' ? req.query.session : undefined;
    if (!session) throw new HttpError(400, 'A "session" query parameter is required.');
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json({ snapshots: listSnapshots(session, query) });
  });

  router.post(
    '/vault/restore',
    asyncRoute(async (req, res) => {
      const body = req.body as { session?: unknown; snapshotId?: unknown; to?: unknown };
      if (typeof body?.session !== 'string' || typeof body?.snapshotId !== 'string') {
        throw new HttpError(400, '"session" and "snapshotId" are required.');
      }
      try {
        res.json({ ok: true, result: restoreSnapshot(body.session, body.snapshotId, typeof body.to === 'string' ? body.to : undefined) });
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : 'restore failed.');
      }
    }),
  );

  router.delete('/vault/:snapshotId', (req, res) => {
    const session = typeof req.query.session === 'string' ? req.query.session : undefined;
    if (!session) throw new HttpError(400, 'A "session" query parameter is required.');
    const purged = purgeSnapshot(session, req.params.snapshotId);
    if (!purged) throw new HttpError(404, 'Unknown snapshot for this session.');
    res.json({ ok: true });
  });

  /**
   * Diff Panel: delete a file the AGENT CREATED (no pre-agent state exists to
   * restore to). A pre-delete snapshot is taken first, so even this removal
   * is undoable through the restore marker. Workspace-jailed.
   */
  router.post('/vault/remove-created', (req, res) => {
    const body = req.body as { session?: unknown; path?: unknown };
    if (typeof body?.session !== 'string' || typeof body?.path !== 'string') {
      throw new HttpError(400, '"session" and "path" are required.');
    }
    const workspace = getActiveWorkspace(body.session);
    if (!workspace) throw new HttpError(400, 'No active workspace for this session.');
    const absolute = path.resolve(workspace.path, body.path);
    if (!isInsideRoot(absolute, workspace.path)) {
      throw new HttpError(400, 'Path is outside the workspace root.');
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new HttpError(404, 'No such file.');
    }
    const before = readFileSync(absolute, 'utf8');
    const snap = snapshotFile(body.session, absolute, 'remove-created');
    try {
      rmSync(absolute);
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? error.message : 'delete failed.');
    }
    const rel = path.relative(workspace.path, absolute);
    res.json({
      ok: true,
      snapshotId: snap.entry?.id,
      diff: buildUnifiedDiff(before, '', rel),
      diffstat: diffStatFromOps(before, ''),
    });
  });


  router.get('/allowlist', (_req, res) => {
    res.json({ dirs: listAllowedDirs() });
  });

  router.post(
    '/allowlist',
    asyncRoute(async (req, res) => {
      const body = req.body as { path?: unknown };
      if (typeof body?.path !== 'string' || !body.path.trim()) {
        throw new HttpError(400, 'A "path" is required.');
      }
      try {
        res.json({ dirs: addAllowedDir(body.path) });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Could not add the folder.');
      }
    }),
  );

  router.delete('/allowlist', (req, res) => {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target) throw new HttpError(400, 'A "path" query parameter is required.');
    res.json({ dirs: removeAllowedDir(target) });
  });


  router.get('/audit', (req, res) => {
    const session = typeof req.query.session === 'string' ? req.query.session : '';
    if (!session) throw new HttpError(400, 'A "session" query parameter is required.');
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json({ entries: readAudit(session, limit) });
  });

  // Live preview support (read-only): raw serves a workspace file with its
  // mime type; preview serves an HTML file with a <base> injected so its

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
  };

  /** ?sessionId=<chatId> — scopes raw/preview to that session's workspace. */
  function previewSessionId(req: { query: Record<string, unknown> }): string | undefined {
    const raw = req.query.sessionId;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  }

  /** Resolves a raw/preview request path INSIDE the active workspace only. */
  function resolvePreviewPath(relative: string, sessionId?: string): string {
    const workspace = getActiveWorkspace(sessionId);
    if (!workspace) throw new HttpError(400, 'No active agent workspace.');
    const absolute = path.resolve(workspace.path, relative.trim().replace(/^\/+/, ''));
    if (!isInsideRoot(absolute, workspace.path)) throw new HttpError(403, 'Path escapes the workspace.');
    return absolute;
  }

  router.get(/\/raw\/(.*)/, (req, res) => {
    const relative = String(req.params[0] ?? '');
    const absolute = resolvePreviewPath(relative, previewSessionId(req));
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      throw new HttpError(404, 'No such file.');
    }
    if (!stats.isFile()) throw new HttpError(400, 'Not a file.');
    const mime = MIME[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(readFileSync(absolute));
  });

  router.get('/preview', (req, res) => {
    const relative = typeof req.query.path === 'string' ? req.query.path : '';
    const absolute = resolvePreviewPath(relative, previewSessionId(req));
    let html: string;
    try {
      html = readFileSync(absolute, 'utf8');
    } catch {
      throw new HttpError(404, 'No such file.');
    }
    const dirRelative = path.relative(
      getActiveWorkspace(previewSessionId(req))!.path,
      path.dirname(absolute),
    ).split(path.sep).join('/');
    const baseHref = `/api/agent/raw/${dirRelative ? `${encodeURIComponent(dirRelative).replace(/%2F/gi, '/')}/` : ''}`;
    const injected = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (match) => `${match}\n<base href="${baseHref}">`)
      : `<base href="${baseHref}">\n${html}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(injected);
  });

  return router;
}
