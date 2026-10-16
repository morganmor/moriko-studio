/**
 * uiExport — saves the single-file UI HTML snapshot (built client-side by
 * src/lib/exportUi.ts) into ui-exports/ in the workspace, so other agents can
 * open and redesign it directly. Keeps a timestamped copy plus latest.html
 * (stable path for agents) and prunes old timestamped copies.
 */
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

const EXPORT_DIR = 'ui-exports';
const KEEP = 20;

export function uiExportRouter(): Router {
  const router = Router();

  router.post(
    '/export',
    express.text({ type: ['text/html', 'text/plain'], limit: '30mb' }),
    (req, res) => {
      const body = typeof req.body === 'string' ? req.body : '';
      if (!/^\s*<!doctype html>/i.test(body)) {
        res.status(400).json({ error: 'Expected a full HTML document.' });
        return;
      }

      const dir = path.resolve(process.cwd(), EXPORT_DIR);
      fs.mkdirSync(dir, { recursive: true });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pill = req.query.kind === 'pill';
      const name = pill ? `pill-panel-${stamp}.html` : `moriko-ui-${stamp}.html`;
      const latest = pill ? 'pill-panel-latest.html' : 'latest.html';
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
      fs.writeFileSync(path.join(dir, latest), body, 'utf8');

      const keep = pill ? /^pill-panel-\d{4}-/ : /^moriko-ui-/;
      const files = fs
        .readdirSync(dir)
        .filter((file) => keep.test(file))
        .sort();
      while (files.length > KEEP) {
        const old = files.shift();
        if (old) fs.rmSync(path.join(dir, old), { force: true });
      }

      res.json({
        file: `${EXPORT_DIR}/${name}`,
        latest: `${EXPORT_DIR}/${latest}`,
        bytes: Buffer.byteLength(body),
      });
    },
  );

  return router;
}
