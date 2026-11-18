
import express, { type NextFunction, type Request, type Response } from 'express';


export const RAW_BODY_PATHS = new Set<string>([
  '/api/attachments/upload',
  '/api/attachments/store',
]);


const JSON_BODY_LIMIT = '200mb';


export function guardedJsonParser() {
  const parser = express.json({ limit: JSON_BODY_LIMIT });
  return function jsonParserGuard(req: Request, res: Response, next: NextFunction): void {
    if (RAW_BODY_PATHS.has(req.path)) {
      next();
      return;
    }
    parser(req, res, next);
  };
}
