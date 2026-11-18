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
import { listBgTasks, stopBgTaskAsUser } from './tools/bg-task.js';
import { decideGate, listPendingGates } from './operatorGates.js';
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


function sanitizeTreeRules(input: unknown): IgnoreRules {
  const raw = (input ?? {}) as { dirs?: unknown; patterns?: unknown };
  const pick = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 64)
      : [];
  return { dirs: pick(raw.dirs), patterns: pick(raw.patterns) };
}




interface BrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'drive';
  mtimeMs?: number;
  size?: number | null;
}


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


const MAX_LISTED_ENTRIES = 800;

export function agentRouter(): Router {
  const router = Router();

  
  router.get(
    '/browser/panel-url',
    asyncRoute(async (req, res) => {
      const session = String(req.query.session ?? '').trim();
      const query = session ? `?session=${encodeURIComponent(session)}` : '';
      const sid = session || undefined;
      if (browserManager.isWebAccessOn(sid) === false) {
        throw new HttpError(403, 'Web access is OFF — the built-in browser is disabled (Configuration → Tools → Web Access).');
      }
      void browserManager.ensureContext(sid).catch(() => undefined);
      res.json({ panelUrl: `/browser-view.html${query}` });
    }),
  );

  router.post(
    '/browser/web-access',
    asyncRoute(async (req, res) => {
      const body = req.body as { on?: unknown; sessionId?: unknown; session?: unknown };
      const rawSid =
        typeof body?.sessionId === 'string' && body.sessionId.trim()
          ? body.sessionId.trim()
          : typeof body?.session === 'string' && body.session.trim()
            ? body.session.trim()
            : undefined;
      await browserManager.setWebAccess(body?.on === true, rawSid);
      res.json({ ok: true, webAccess: body?.on === true, sessionId: rawSid ?? null });
    }),
  );

  router.post(
    '/browser/close',
    asyncRoute(async (req, res) => {
      const body = req.body as { sessionId?: unknown; session?: unknown } | undefined;
      const rawSid =
        typeof body?.sessionId === 'string' && body.sessionId.trim()
          ? body.sessionId.trim()
          : typeof body?.session === 'string' && body.session.trim()
            ? body.session.trim()
            : undefined;
      await browserManager.close(rawSid);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/browser/download/:sessionId/:downloadId',
    asyncRoute(async (req, res) => {
      const rawSid = String(req.params.sessionId ?? '').trim();
      const downloadId = String(req.params.downloadId ?? '').trim();
      const entry = browserManager.getDownload(downloadId, rawSid || undefined);
      if (!entry || entry.status !== 'done' || !existsSync(entry.path)) {
        throw new HttpError(404, 'Browser download not found.');
      }
      res.download(entry.path, entry.filename);
    }),
  );

  
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

  
  router.get('/visual-vendor/:lib', (req, res) => {
    const allowed = new Set(['three', 'three-addons-orbit', 'pixi', 'matter', 'moriko-gl']);
    const lib = String(req.params.lib ?? '');
    if (!allowed.has(lib)) {
      throw new HttpError(404, `Unknown vendor lib "${lib}".`);
    }
    let content: string | null = null;
    try {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const os = require('node:os') as typeof import('node:os');
      const path = require('node:path') as typeof import('node:path');
      const candidates = [
        path.join(os.homedir(), '.moriko-studio', 'visual-vendor', `${lib}.js`),
      ];
      if (lib === 'moriko-gl') {
        candidates.unshift(path.join(process.cwd(), 'server', 'agents', 'vendor', 'moriko-gl.js'));
      }
      for (const candidate of candidates) {
        try {
          content = readFileSync(candidate, 'utf8');
          break;
        } catch {  }
      }
    } catch {
      content = null;
    }
    if (content === null) {
      throw new HttpError(404, `Vendor bundle "${lib}" not built yet — run: node scripts/build-visual-vendor.mjs`);
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(content);
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

  
  router.post(
    '/native-pick',
    asyncRoute(async (_req, res) => {
      const picked = await pickNativeFolder();
      res.json({ path: picked });
    }),
  );


  
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

  
  router.get('/tree', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    const payload = workspaceId ? treePayload(workspaceId) : null;
    if (!payload) throw new HttpError(404, 'No tree for that workspace (unknown id or folder missing).');
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  
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

  
  router.delete(
    '/permissions/grants',
    (_req, res) => {
      revokeAllGrants();
      res.json({ ok: true });
    },
  );

  
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


  
  router.get('/permissions', (_req, res) => {
    res.json({ requests: listPendingPermissions() });
  });

  router.post(
    '/permissions/:id/decision',
    asyncRoute(async (req, res) => {
      const body = req.body as { approve?: unknown; remember?: unknown; reason?: unknown };
      if (typeof body?.approve !== 'boolean') {
        throw new HttpError(400, 'A boolean "approve" is required.');
      }
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 2000) : undefined;
      const applied = decidePermission(req.params.id, body.approve, body.remember === true, reason);
      if (!applied) {
        throw new HttpError(404, 'Unknown or already-decided permission request.');
      }
      res.json({ ok: true, granted: body.approve });
    }),
  );

  
  router.get('/tasks', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.trim() ? req.query.sessionId.trim() : undefined;
    res.json({ tasks: listBgTasks(sessionId) });
  });

  
  router.post('/tasks/:id/stop', (req, res) => {
    const body = req.body as { sessionId?: unknown } | undefined;
    const sessionId = typeof body?.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined;
    const result = stopBgTaskAsUser(req.params.id, sessionId);
    if (!result.ok) {
      if (result.notOwner) throw new HttpError(403, 'That process belongs to another session.');
      throw new HttpError(404, result.error ?? 'Unknown task.');
    }
    res.json({ ok: true });
  });

  
  router.get('/gates', (_req, res) => {
    res.json({ requests: listPendingGates() });
  });

  router.post(
    '/gates/:id/decision',
    asyncRoute(async (req, res) => {
      const body = req.body as { verdict?: unknown; reason?: unknown };
      if (body?.verdict !== 'accept' && body?.verdict !== 'reject') {
        throw new HttpError(400, 'A "verdict" of "accept" or "reject" is required.');
      }
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const applied = decideGate(req.params.id, body.verdict, reason);
      if (!applied) {
        throw new HttpError(404, 'Unknown or already-decided operator gate.');
      }
      res.json({ ok: true, verdict: body.verdict });
    }),
  );


  
  router.get('/ask-user', (_req, res) => {
    res.json({ requests: listPendingQuestions() });
  });

  
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

  
  function previewSessionId(req: { query: Record<string, unknown> }): string | undefined {
    const raw = req.query.sessionId;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  }

  
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
