import { Router } from 'express';

import { asyncRoute } from '../http.js';
import { enterPlanMode, exitPlanMode, planModePosture } from '../agents/plan-mode.js';


export function planModeRouter(): Router {
  const router = Router();

  const snapshot = (sessionId: string | undefined) => {
    const posture = planModePosture(sessionId);
    return {
      active: posture.plan?.active === true,
      reason: posture.plan?.reason ?? '',
      enteredAt: posture.plan?.enteredAt ?? 0,
      rsatLock: posture.lock,
    };
  };

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      res.json(snapshot(sessionId));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const body = req.body as { sessionId?: unknown; active?: unknown; reason?: unknown };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required.' });
        return;
      }
      if (body.active === true) {
        const reason = typeof body.reason === 'string' ? body.reason : 'Plan mode turned on from the composer.';
        enterPlanMode(sessionId, reason);
      } else if (body.active === false) {
        exitPlanMode(sessionId);
      } else {
        res.status(400).json({ error: 'active must be true or false.' });
        return;
      }
      res.json(snapshot(sessionId));
    }),
  );

  return router;
}
