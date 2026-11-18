import { Router } from 'express';

import { asyncRoute, HttpError } from '../http.js';
import { deleteWorkflow, listStoredWorkflows, upsertWorkflow } from '../agents/workflowStore.js';


export function workflowsRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ workflows: listStoredWorkflows() });
  });

  router.put(
    '/',
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      try {
        res.json({ workflow: upsertWorkflow(body) });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Could not save the workflow.');
      }
    }),
  );

  router.delete(
    '/:workflowId',
    (req, res) => {
      try {
        deleteWorkflow(req.params.workflowId);
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : 'Unknown workflow.');
      }
      res.status(204).end();
    },
  );

  return router;
}
