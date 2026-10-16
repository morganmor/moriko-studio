/**
 * routes.ts — `/api/watch` (Mobile Watching): cloudflared install, quick
 * tunnel lifecycle, port detection, QR SVG for the tunnel URL.
 */
import { Router } from 'express';
import QRCode from 'qrcode';
import { listListeningPorts } from './ports.js';
import {
  PLATFORM_TARGETS,
  ensureInstalled,
  installState,
  recoverTunnel,
  startTunnel,
  stopTunnel,
  watchStatus,
} from './cloudflared.js';

recoverTunnel();

export function watchRouter(): Router {
  const router = Router();

  router.get('/status', async (_req, res) => {
    res.json({ ...(await watchStatus()), ports: await listListeningPorts() });
  });

  router.get('/ports', async (_req, res) => {
    res.json({ ports: await listListeningPorts() });
  });

  router.post('/install', async (req, res) => {
    const target = typeof req.body?.target === 'string' ? req.body.target : undefined;
    if (target && !PLATFORM_TARGETS.some((t) => t.id === target)) {
      res.status(400).json({ error: `Unknown platform target "${target}".` });
      return;
    }
    const result = await ensureInstalled(target).catch((error: unknown) => {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!result) return;
    if (result.skipped) {
      res.json({ skipped: true, path: result.path });
      return;
    }
    res.json({ skipped: false, path: result.path });
  });

  router.post('/start', async (req, res) => {
    const port = Number(req.body?.port);
    const target = typeof req.body?.target === 'string' ? req.body.target : undefined;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'A valid "port" is required.' });
      return;
    }
    try {
      const { url } = await startTunnel(port, target);
      res.json({ url, port });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/stop', async (_req, res) => {
    await stopTunnel();
    res.json({ stopped: true });
  });

  router.get('/qr', async (req, res) => {
    const text = typeof req.query.text === 'string' ? req.query.text : '';
    if (!/^https?:\/\/\S+$/.test(text)) {
      res.status(400).json({ error: 'text must be an http(s) URL.' });
      return;
    }
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 320 });
    res.type('image/svg+xml').send(svg);
  });

  router.get('/install-progress', (_req, res) => {
    res.json({ ...installState });
  });

  return router;
}
