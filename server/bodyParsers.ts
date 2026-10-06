/**
 * Global body-parser wiring, isolated from server/index.ts (which LISTENS at
 * import time) so tests can pin the middleware contract directly.
 *
 * THE BUG THIS MODULE EXISTS FOR: a browser sets a file's Content-Type from
 * its extension, so a `.json` attachment uploads as `application/json`. The
 * app-wide express.json() runs EARLIER in the chain than the route-level
 * express.raw() of /api/attachments/upload — body-parser marks the request
 * "already parsed", the route's raw parser skips, and the handler receives a
 * parsed OBJECT instead of the Buffer it requires. The upload fails with a
 * 400, the client keeps no `path` for the attachment, and the wire builder
 * (src/lib/compaction.ts wireUserContent) falls back to inlining the ENTIRE
 * file into the prompt. That is why .json attachments landed in context
 * while .txt/.md (text/plain, text/markdown — never claimed by the JSON
 * parser) rode the normal preview+path route.
 *
 * Both raw-body routes parse their own bodies and are skipped here.
 */
import express, { type NextFunction, type Request, type Response } from 'express';

/** Routes that parse their own raw bodies and must bypass the JSON parser. */
export const RAW_BODY_PATHS = new Set<string>([
  '/api/attachments/upload',
  '/api/attachments/store',
]);

const JSON_BODY_LIMIT = '30mb';

/**
 * The app's global JSON parser, skipping the raw-body routes above. Mounted
 * once in server/index.ts; every other route keeps the exact express.json()
 * behavior (same limit, same error handling).
 */
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
