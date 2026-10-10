import type { Request, Response, NextFunction } from 'express';

export function validate{{Name}}(req: Request, res: Response, next: NextFunction): void {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  next();
}
