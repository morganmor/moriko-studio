import { Router } from 'express';

import { asyncRoute, HttpError } from '../http.js';
import { listSkills, loadSkill, listSkillFiles } from '../skills/store.js';

/**
 * REST surface for AGENT SKILLS (open Agent Skills format, dual-scope
 * discovery: ~/.moriko-studio/skills + <workspace>/.moriko/skills + the
 * ecosystem compat roots .agents/.claude):
 *
 *   GET /api/skills?sessionId=…      — catalogue (metadata only)
 *   GET /api/skills/:name?sessionId=… — one skill + body + companion files
 */
export function skillsRouter(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const workspace = resolveWorkspace(sessionId);
    res.json({ skills: listSkills(workspace) });
  });

  router.get(
    '/:name',
    asyncRoute(async (req, res) => {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const skill = loadSkill(req.params.name, resolveWorkspace(sessionId));
      if (!skill) throw new HttpError(404, `No skill named "${req.params.name}".`);
      res.json({ skill: { ...skill, files: listSkillFiles(skill.dir) } });
    }),
  );

  return router;
}

import { getActiveWorkspace } from '../agents/workspace.js';

function resolveWorkspace(sessionId?: string): string | undefined {
  try {
    return getActiveWorkspace(sessionId)?.path;
  } catch {
    return undefined;
  }
}
