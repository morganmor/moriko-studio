import { Router } from 'express';

export function {{name}}Routes(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}
