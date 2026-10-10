/** Addon HTTP routes — list, toggle, reload, commands, widgets. */

import { Router } from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listAddons, getAddon, listAddonToolDefs, listAddonCommands, listAddonWidgets, emitAddonEvent } from './registry.js';
import { loadAllAddons, reloadAddon, ADDONS_ROOT } from './loader.js';
import { createAddonApi } from './api.js';
import { getActiveWorkspace } from '../agents/workspace.js';
import { addSseClient } from './bus.js';
import type { AddonClientEntry, RenderSite } from './types.js';

export const addonRouter = () => {
  const router = Router();

  function toClientEntry(id: string): AddonClientEntry | null {
    const addon = getAddon(id);
    if (!addon) return null;
    const m = addon.manifest;
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      enabled: addon.enabled,
      loadError: addon.loadError,
      hasTools: listAddonToolDefs().some((d) => d.wireName.includes(`_${m.id}_`)),
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
      const workspacePath = (() => { try { return getActiveWorkspace()?.path ?? process.cwd(); } catch { return process.cwd(); } })();
      const outcome = await emitAddonEvent('command.run', { command: name, args }, createAddonApi('__harness__', workspacePath));
      const text = typeof outcome?.text === 'string' ? outcome.text : `/${name} executed.`;
      res.json({ ok: true, text });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Command failed.' });
    }
  });

  router.get('/widgets', (req, res) => {
    const site = req.query.site as string | undefined;
    const ws = listAddonWidgets(site as RenderSite | undefined);
    res.json({ widgets: ws.map((w) => ({ addonId: w.addonId, site: w.site, component: w.component, label: w.label })) });
  });

  /** SSE bus — realtime client push from addon bus.publish(). */
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    const unsubscribe = addSseClient((payload) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
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
    try {
      const manifestPath = path.join(ADDONS_ROOT(), addon.manifest.id, 'addon.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      manifest.enabled = next;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch {  }
    const ok = await reloadAddon(addon.manifest.id, next);
    if (!ok) return res.status(500).json({ error: 'Reload failed' });
    res.json({ ok: true, enabled: next });
  });

  router.post('/reload', async (_req, res) => {
    await loadAllAddons();
    res.json({ ok: true });
  });

  router.post('/:id/reload', async (req, res) => {
    const ok = await reloadAddon(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Addon not found' });
    res.json({ ok: true });
  });

  return router;
};
