import { Router } from 'express';

import { asyncRoute, HttpError } from '../http.js';
import { createGoal, deleteGoal, listGoals, updateGoal } from './store.js';

/**
 * REST surface for the Goals panel (the USER side of goals — the AGENT side
 * rides the `goal_*` harness tools). Goals are keyed by the conversation
 * session id the client supplies.
 *
 *   GET    /api/goals?session=…        — goals of one session
 *   POST   /api/goals                  — create { session, title, plan?, todos? }
 *   PATCH  /api/goals/:goalId          — update { session, title?, plan?, status?, todos? }
 *   DELETE /api/goals/:goalId?session=… — remove
 */
export function goalsRouter(): Router {
  const router = Router();

  function requireSession(value: unknown): string {
    const session = typeof value === 'string' ? value.trim() : '';
    if (!session) throw new HttpError(400, 'A "session" (conversation id) is required.');
    return session;
  }

  router.get('/', (req, res) => {
    const session = requireSession(req.query.session);
    res.json({ goals: listGoals(session) });
  });

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const body = req.body as { session?: unknown; title?: unknown; plan?: unknown; todos?: unknown };
      const session = requireSession(body?.session);
      try {
        res.status(201).json({ goal: createGoal(session, body) });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Could not create the goal.');
      }
    }),
  );

  router.patch(
    '/:goalId',
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const session = requireSession(body?.session);
      try {
        res.json({ goal: updateGoal(session, req.params.goalId, body) });
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : 'Unknown goal.');
      }
    }),
  );

  router.delete(
    '/:goalId',
    (req, res) => {
      const session = requireSession(req.query.session);
      if (!deleteGoal(session, req.params.goalId)) {
        throw new HttpError(404, 'Unknown goal.');
      }
      res.status(204).end();
    },
  );

  return router;
}
