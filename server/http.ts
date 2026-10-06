import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Shared HTTP plumbing for the /api routes.
 *
 * Extracted from `index.ts` so feature modules (e.g. `server/agents/`) can
 * raise the same typed errors and wrap async handlers without importing the
 * app entry (which would be circular).
 */

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Wraps an async route handler so rejections reach the error middleware. */
export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
