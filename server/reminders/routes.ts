import { Router } from 'express';

import { asyncRoute, HttpError } from '../http.js';
import { createReminder, deleteReminder, listReminders } from './store.js';

/**
 * REST surface for scheduled reminders (the user-facing side; the agent uses
 * the `agent__remind` harness tool):
 *
 *   GET    /api/reminders?session=…        — list (pending + delivered)
 *   POST   /api/reminders                  — create { session, label, at | inMinutes }
 *   DELETE /api/reminders/:id?session=…    — cancel one
 */
export function remindersRouter(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const session = typeof req.query.session === 'string' ? req.query.session : '';
    if (!session) throw new HttpError(400, 'A "session" query parameter is required.');
    res.json({ reminders: listReminders(session) });
  });

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const body = req.body as { session?: unknown; label?: unknown; at?: unknown; inMinutes?: unknown };
      if (typeof body?.session !== 'string' || typeof body?.label !== 'string') {
        throw new HttpError(400, '"session" and "label" are required.');
      }
      try {
        const reminder = createReminder(body.session, {
          label: body.label,
          fireAt: typeof body.at === 'string' ? body.at : typeof body.at === 'number' ? body.at : undefined,
          inMinutes: typeof body.inMinutes === 'number' ? body.inMinutes : undefined,
        });
        res.json({ ok: true, reminder });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Could not create the reminder.');
      }
    }),
  );

  router.delete('/:id', (req, res) => {
    const session = typeof req.query.session === 'string' ? req.query.session : '';
    if (!session) throw new HttpError(400, 'A "session" query parameter is required.');
    const removed = deleteReminder(session, req.params.id);
    if (!removed) throw new HttpError(404, 'Unknown reminder for this session.');
    res.json({ ok: true });
  });

  return router;
}
