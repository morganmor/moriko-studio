import { Router } from 'express';

import { asyncRoute, HttpError } from '../http.js';
import { createTodo, deleteTodo, listTodos, sweepTodos, updateTodo } from './store.js';


export function todosRouter(): Router {
  const router = Router();

  function requireSession(value: unknown): string {
    const session = typeof value === 'string' ? value.trim() : '';
    if (!session) throw new HttpError(400, 'A "session" (conversation id) is required.');
    return session;
  }

  router.get('/', (req, res) => {
    const session = requireSession(req.query.session);
    res.json({ todos: listTodos(session) });
  });

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const body = req.body as { session?: unknown; text?: unknown; priority?: unknown; notes?: unknown };
      const session = requireSession(body?.session);
      try {
        res.status(201).json({ todo: createTodo(session, body) });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Could not create the todo.');
      }
    }),
  );

  router.patch(
    '/:todoId',
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const session = requireSession(body?.session);
      try {
        res.json({ todo: updateTodo(session, req.params.todoId, body) });
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : 'Unknown todo.');
      }
    }),
  );

  router.delete(
    '/:todoId',
    (req, res) => {
      const session = requireSession(req.query.session);
      if (!deleteTodo(session, req.params.todoId)) {
        throw new HttpError(404, 'Unknown todo.');
      }
      res.status(204).end();
    },
  );

  // End-of-turn sweep: stamps every completed todo (all-done turns only) with
  // sweptAt — the panel hides them, todos.json keeps the data.
  router.post(
    '/sweep',
    (req, res) => {
      const session = requireSession(req.body?.session);
      const result = sweepTodos(session);
      res.json(result);
    },
  );

  return router;
}
