/** Addon HTTP routes — list, toggle, reload, commands, widgets. */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { listAddons, getAddon, listAddonToolDefs, listAddonCommands, listAddonWidgets, emitAddonEvent, addonIdOfTool } from './registry.js';
import { loadAllAddons, reloadAddon, ADDONS_ROOT } from './loader.js';
import { createAddonApi } from './api.js';
import { addSseClient, publishBusEvent, replaySince } from './bus.js';
import { grantPermissions, revokePermission, getPermRecord } from './permissions.js';
import { reseedBuiltin, reseedAllBuiltins, builtinAddonIds } from './seed.js';
import { listViews, listStatusItems } from './contributions.js';
import { getAllSettings, setSetting, getSettingsSchema } from './settings.js';
import { getRpcHandler } from './rpc.js';
import { tailAddonLogs } from './logbuffer.js';
import { serveClientModule, serveClientAsset } from './clientBundle.js';
import { getActiveWorkspace } from '../agents/workspace.js';
import type { AddonClientEntry, RenderSite } from './types.js';

export const addonRouter = () => {
  const router = Router();

  function toClientEntry(id: string): AddonClientEntry | null {
    const addon = getAddon(id);
    if (!addon) return null;
    const m = addon.manifest;
    const extra = m as unknown as Record<string, unknown>;
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      enabled: addon.enabled,
      loadError: addon.loadError,
      status: addon.status ?? (addon.enabled ? 'active' : 'disabled'),
      apiVersion: addon.apiVersion ?? '1',
      shortName: typeof extra.shortName === 'string' ? extra.shortName : undefined,
      kind: typeof extra.kind === 'string' ? extra.kind : undefined,
      icon: typeof m.icon === 'string' ? m.icon : undefined,
      permissions: Array.isArray(extra.permissions) ? extra.permissions as string[] : [],
      builtin: builtinAddonIds().includes(m.id),
      permRecord: getPermRecord(id),
      hasTools: listAddonToolDefs().some((d) => addonIdOfTool(d.wireName) === m.id),
      hasWidgets: listAddonWidgets().some((w) => w.addonId === m.id),
      widgets: listAddonWidgets().filter((w) => w.addonId === m.id).map((w) => ({
        site: w.site as RenderSite,
        component: w.component,
        label: w.label,
      })),
      commands: listAddonCommands().filter((c) => c.addonId === m.id).map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
      })),
    };
  }

  router.get('/', (_req, res) => {
    const entries = listAddons()
      .map((a) => toClientEntry(a.manifest.id))
      .filter(Boolean) as AddonClientEntry[];
    res.json({ addons: entries });
  });

  /** v2 (A2): consent decisions — grant all pending permissions or revoke one.
   *  Granting re-attempts activation via reload. */
  router.post('/:id/permissions', async (req, res) => {
    const id = req.params.id;
    const addon = getAddon(id);
    if (!addon) return res.status(404).json({ error: 'Addon not found' });
    const action = req.body?.action as 'grant' | 'revoke' | undefined;
    const permission = typeof req.body?.permission === 'string' ? req.body.permission : null;
    if (action === 'grant') {
      const extra = addon.manifest as unknown as Record<string, unknown>;
      const perms = Array.isArray(extra.permissions) ? extra.permissions as string[] : [];
      grantPermissions(id, perms);
      const reloaded = await reloadAddon(id);
      return res.json({ ok: true, reloaded });
    }
    if (action === 'revoke') {
      if (!permission) return res.status(400).json({ error: 'permission is required for revoke' });
      revokePermission(id, permission);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'action must be "grant" or "revoke"' });
  });

  router.get('/commands', (_req, res) => {
    const cmds = listAddonCommands().map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      immediate: c.immediate,
    }));
    res.json({ commands: cmds });
  });

  /** Run a registered slash command: emits "command.run" through the addon
   *  hook chain — a handler that answers with { text } short-circuits it. */
  router.post('/commands/run', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const args = typeof req.body?.args === 'string' ? req.body.args : '';
    const cmd = listAddonCommands().find((c) => c.name === name);
    if (!cmd) return res.status(404).json({ error: `Unknown command: /${name}` });
    try {
      // v2: prefer the command's direct run handler; otherwise walk the
      // command.run hook chain with the OWNING addon's API (A-03).
      if (cmd.run) {
        const out = await cmd.run(args, { actor: { kind: 'user' } });
        return res.json({ ok: true, text: out.text, openView: out.openView ?? null });
      }
      const ownerApi = createAddonApi(cmd.addonId, { addonDir: getAddon(cmd.addonId)?.dir });
      const outcome = await emitAddonEvent('command.run', { command: name, args }, ownerApi);
      const text = typeof outcome?.text === 'string' ? outcome.text : `/${name} executed.`;
      res.json({ ok: true, text, openView: null });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Command failed.' });
    }
  });

  router.get('/widgets', (req, res) => {
    const site = req.query.site as string | undefined;
    const ws = listAddonWidgets(site as RenderSite | undefined);
    res.json({ widgets: ws.map((w) => ({ addonId: w.addonId, site: w.site, component: w.component, label: w.label })) });
  });

  /** v2 (A4): views + statusItems (sidebar/Hub read these once at boot, then
   *  follow SSE addon.status / addon.registry frames). */
  router.get('/views', (_req, res) => {
    res.json({ views: listViews().map((v) => ({ ...v })) });
  });

  router.get('/status', (_req, res) => {
    res.json({ status: listStatusItems() });
  });

  /** v2 (A4): settings — read all (defaults filled) or set one. */
  router.get('/:id/settings', (req, res) => {
    const addon = getAddon(req.params.id);
    if (!addon) return res.status(404).json({ error: 'Addon not found' });
    try {
      const workspacePath = getActiveWorkspace()?.path;
      res.json({ settings: getAllSettings(req.params.id, workspacePath), schema: getSettingsSchema(req.params.id) ?? null });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read settings' });
    }
  });

  router.post('/:id/settings', (req, res) => {
    const addon = getAddon(req.params.id);
    if (!addon) return res.status(404).json({ error: 'Addon not found' });
    const key = typeof req.body?.key === 'string' ? req.body.key : null;
    if (!key) return res.status(400).json({ error: 'key is required' });
    try {
      const workspacePath = getActiveWorkspace()?.path;
      setSetting(req.params.id, key, req.body.value, workspacePath);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid setting' });
    }
  });

  /** v2 (A4): addon UI RPC — actor is always the user. */
  router.post('/:id/rpc/:name', async (req, res) => {
    const handler = getRpcHandler(req.params.id, req.params.name);
    if (!handler) return res.status(404).json({ error: `Unknown RPC "${req.params.name}"` });
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const result = await handler(body, { actor: { kind: 'user' } });
      res.json({ ok: true, result: result === undefined ? null : result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'RPC failed' });
    }
  });

  /** v2 (A4): per-addon log tail for the Hub's Logs tab. */
  router.get('/:id/logs', (req, res) => {
    const addon = getAddon(req.params.id);
    if (!addon) return res.status(404).json({ error: 'Addon not found' });
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) || 200 : 200;
    res.json({ logs: tailAddonLogs(req.params.id, limit) });
  });

  /** v2 (A5): HOST SHIM — bare-import endpoints that re-export the ONE React
   *  instance + host hooks from window.__MORIKO_HOST__ (src/addons/host.ts
   *  installs it at boot). Two React instances break hooks; this guarantees
   *  addon code and the app share one. */
  const SHIM_FILES: Record<string, string> = {
    'react.js': [
      'const H = window.__MORIKO_HOST__;',
      'const re = H.modules.react;',
      'const out = {};',
      'for (const k of Object.keys(re)) out[k] = re[k];',
      'out.default = re.default ?? re;',
      'export default out.default;',
      'export const Fragment = out.Fragment, useState = out.useState, useEffect = out.useEffect,',
      '  useMemo = out.useMemo, useCallback = out.useCallback, useRef = out.useRef,',
      '  useLayoutEffect = out.useLayoutEffect, useReducer = out.useReducer, useContext = out.useContext,',
      '  useSyncExternalStore = out.useSyncExternalStore, useId = out.useId,',
      '  useImperativeHandle = out.useImperativeHandle, useDebugValue = out.useDebugValue,',
      '  useTransition = out.useTransition, useDeferredValue = out.useDeferredValue, startTransition = out.startTransition,',
      '  createContext = out.createContext, createElement = out.createElement, cloneElement = out.cloneElement,',
      '  memo = out.memo, lazy = out.lazy, Suspense = out.Suspense, Component = out.Component,',
      '  PureComponent = out.PureComponent, forwardRef = out.forwardRef, isValidElement = out.isValidElement;',
      'export const { Children, Profiler, StrictMode } = out;',
      'export const version = out.version;',
    ].join('\n'),
    'jsx-runtime.js': [
      'const H = window.__MORIKO_HOST__;',
      'const j = H.modules.jsxRuntime;',
      'export const jsx = j.jsx, jsxs = j.jsxs, Fragment = j.Fragment;',
    ].join('\n'),
    'react-dom.js': [
      'const H = window.__MORIKO_HOST__;',
      'const rd = H.modules.reactDom;',
      'const out = {};',
      'for (const k of Object.keys(rd)) out[k] = rd[k];',
      'out.default = rd.default ?? rd;',
      'export default out.default;',
      'export const createPortal = out.createPortal, flushSync = out.flushSync,',
      '  findDOMNode = out.findDOMNode, version = out.version;',
    ].join('\n'),
    'react-dom-client.js': [
      'const H = window.__MORIKO_HOST__;',
      'const rdc = H.modules.reactDomClient;',
      'const out = {};',
      'for (const k of Object.keys(rdc)) out[k] = rdc[k];',
      'out.default = rdc.default ?? rdc;',
      'export default out.default;',
      'export const createRoot = out.createRoot, hydrateRoot = out.hydrateRoot;',
    ].join('\n'),
    'host.js': [
      'const H = window.__MORIKO_HOST__;',
      'const out = {};',
      'for (const k of Object.keys(H.host)) out[k] = H.host[k];',
      'export default out;',
      'export const useAddonBus = H.host.useAddonBus, useAddonState = H.host.useAddonState,',
      '  useAddonSettings = H.host.useAddonSettings, useSession = H.host.useSession,',
      '  invoke = H.host.invoke, notify = H.host.notify, t = H.host.t,',
      '  setTheme = H.host.setTheme, setAccent = H.host.setAccent, getAppearance = H.host.getAppearance,',
      '  navigate = H.host.navigate, toggleSidebar = H.host.toggleSidebar,',
      '  getProviders = H.host.getProviders, dispatchAgent = H.host.dispatchAgent,',
      '  useCouncil = H.host.useCouncil, openConversation = H.host.openConversation,',
      '  createCouncil = H.host.createCouncil, createSubSession = H.host.createSubSession,',
      '  deleteSubSession = H.host.deleteSubSession,',
      '  Icon = H.host.Icon, Card = H.host.Card, Pill = H.host.Pill, Button = H.host.Button,',
      '  Modal = H.host.Modal, Tabs = H.host.Tabs, ProgressBar = H.host.ProgressBar;',
    ].join('\n'),
  };

  router.get('/host-shim/:file', (req, res) => {
    const file = SHIM_FILES[req.params.file];
    if (!file) return res.status(404).end();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(file);
  });

  /** v2 (A5): transpiled addon client modules + raw assets (css/font/svg). */
  router.get('/:id/client/*', (req, res) => {
    const rel = req.path.slice(req.path.indexOf('/client/') + '/client/'.length);
    const assetExt = path.extname(rel.split('?')[0]).toLowerCase();
    if (assetExt && !['.js', '.ts', '.tsx', '.jsx'].includes(assetExt)) {
      const asset = serveClientAsset(req.params.id, rel);
      if ('error' in asset) return res.status(asset.status).json({ error: asset.error });
      res.setHeader('Content-Type', asset.mime);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', asset.etag);
      if (req.headers['if-none-match'] === asset.etag) return res.status(304).end();
      return res.send(asset.data);
    }
    const result = serveClientModule(req.params.id, rel);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', result.etag);
    if (req.headers['if-none-match'] === result.etag) return res.status(304).end();
    res.send(result.js);
  });

  /** SSE bus — realtime client push from addon bus.publish().
   *  v2 (A7): `id:` lines + Last-Event-ID replay; `?topics=` filter;
   *  `?scope=others` restores the v1 self-exclusion if ever needed. */
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const topicsRaw = typeof req.query.topics === 'string' ? req.query.topics : null;
    const topics = topicsRaw ? topicsRaw.split(',').map((t) => t.trim()).filter(Boolean) : null;
    const scope = req.query.scope === 'others' ? 'others' as const : 'any' as const;

    const writeFrame = (payload: unknown) => {
      const frame = payload as import('./types.js').AddonBusPayload;
      if (res.writableEnded) return;
      res.write(`id: ${frame.id ?? 0}\n`);
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    const unsubscribe = addSseClient(writeFrame, { topics, scope });

    // Reconnect replay: the browser sends Last-Event-ID automatically.
    const lastIdRaw = req.headers['last-event-id'];
    const lastId = typeof lastIdRaw === 'string' ? Number.parseInt(lastIdRaw, 10) : NaN;
    for (const frame of replaySince(Number.isFinite(lastId) ? lastId : 0)) writeFrame(frame);

    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 20000);
    req.on('close', () => {
      clearInterval(beat);
      unsubscribe();
    });
  });

  router.post('/:id/toggle', async (req, res) => {
    const addon = getAddon(req.params.id);
    if (!addon) return res.status(404).json({ error: 'Addon not found' });
    const next = !addon.enabled;
    // A9-bis: disabling a builtin reseeds it from addons-src/ first, so the
    // user never has to delete the install by hand to get the latest shipped
    // source. The fresh manifest carries the disabled flag forward.
    const reseeded = !next && reseedBuiltin(addon.manifest.id) !== null;
    try {
      const manifestPath = path.join(ADDONS_ROOT(), addon.manifest.id, 'addon.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      manifest.enabled = next;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch {  }
    const ok = await reloadAddon(addon.manifest.id, next);
    if (!ok) return res.status(500).json({ error: 'Reload failed' });
    // LIVE TOGGLE: every browser repaints its addon sections/views instantly —
    // no refresh required (the stale UI after a disable was a real bug).
    void publishBusEvent('addons.registry', { reason: 'toggle', addonId: addon.manifest.id, enabled: next }, 'moriko-host');
    res.json({ ok: true, enabled: next, reseeded });
  });

  router.post('/reload', async (_req, res) => {
    // A9-bis: reload-all also pulls the newest builtins from addons-src/.
    reseedAllBuiltins();
    await loadAllAddons();
    void publishBusEvent('addons.registry', { reason: 'reload-all' }, 'moriko-host');
    res.json({ ok: true });
  });

  router.post('/:id/reload', async (req, res) => {
    // A9-bis: reload one addon = reseed the builtin first (if any), then load.
    const reseeded = reseedBuiltin(req.params.id) !== null;
    const ok = await reloadAddon(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Addon not found' });
    void publishBusEvent('addons.registry', { reason: 'reload', addonId: req.params.id }, 'moriko-host');
    res.json({ ok: true, reseeded });
  });

  // Addon Manager: Remove is USER-ONLY (the agent's addon_manage remove is
  // refused server-side). The Hub button deletes the runtime install AND the
  // addons-src source of a builtin — with the Hub's confirm modal up front.
  router.delete('/:id', async (req, res) => {
    const id = req.params.id;
    const srcDir = path.resolve(process.cwd(), 'addons-src', id);
    const isBuiltin = existsSync(path.join(srcDir, 'addon.json'));
    const installDir = path.join(ADDONS_ROOT(), id);
    if (!isBuiltin && !existsSync(installDir)) {
      return res.status(404).json({ error: 'Addon not found' });
    }
    try {
      if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });
      if (isBuiltin) rmSync(srcDir, { recursive: true, force: true });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Delete failed' });
    }
    await loadAllAddons(); // removal needs a resync, not a reload
    // LIVE DELETE: every browser repaints Hub/sidebar immediately — no refresh.
    void publishBusEvent('addons.registry', { reason: 'delete', addonId: id }, 'moriko-host');
    res.json({ ok: true });
  });

  return router;
};
