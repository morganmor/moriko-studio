/**
 * agent__skills — the on-demand skill loader (progressive disclosure level 2)
 * AND the sanctioned reader for the whole SKILLS STORAGE.
 *
 *   action "list" : the available-skills catalogue (name, description, scope)
 *   action "load" : full SKILL.md body + recursive companion file list
 *   action "file" : { name, path }  → file inside that skill's folder
 *                   { path }        → ANY file inside the skills storage
 *                                     (workspace .moriko/.agents/.claude
 *                                     skills + harness-home ~/.moriko-studio/
 *                                     ~/.agents/ ~/.claude/ skills) — this is
 *                                     how skills OUTSIDE the active workspace
 *                                     are read without tripping the file-tool
 *                                     workspace jail; the jail is replaced by
 *                                     a strict union-of-skill-roots jail.
 *   action "tree" : { name } → recursive file tree of one skill
 *                   { }       → tree of EVERY skills root (labeled by scope)
 *
 * All reads are text, capped (64 KB/file), path-jailed to the skill roots,
 * and skip dotfolders/node_modules. Nothing outside the skill roots is
 * reachable through this tool — the normal workspace tools stay untouched.
 */
import { defineTool } from './registry.js';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str } from './shared.js';
import { getActiveWorkspace } from '../workspace.js';
import {
  listSkills,
  loadSkill,
  listSkillFiles,
  readSkillCompanion,
  readSkillsStorageFile,
  walkSkillTree,
  skillRoots,
  type SkillTreeNode,
} from '../../skills/store.js';

/** Renders a recursive tree as an indented ASCII listing. */
function renderTree(nodes: SkillTreeNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const depth = node.rel.split('/').length - 1;
    const indent = '  '.repeat(depth);
    const name = node.rel.split('/').pop() ?? node.rel;
    lines.push(
      node.type === 'dir'
        ? `${indent}${name}/`
        : `${indent}${name}${node.size !== undefined ? `  (${node.size} B)` : ''}`,
    );
  }
  return lines.join('\n');
}

async function skillsTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const action = str(args, 'action').trim().toLowerCase() || 'load';
  const workspaceRoot = getActiveWorkspace(ctx.sessionId)?.path;
  const name = str(args, 'name').trim();
  const relPath = str(args, 'path').trim();

  if (action === 'list') {
    const skills = listSkills(workspaceRoot);
    if (skills.length === 0) return { ok: true, isError: false, text: 'No skills discovered.' };
    return {
      ok: true,
      isError: false,
      text: skills.map((skill) => `- ${skill.name} (${skill.scope}): ${skill.description}`).join('\n'),
    };
  }

  if (action === 'tree') {
    if (name) {
      const skill = loadSkill(name, workspaceRoot);
      if (!skill) return { ok: false, isError: true, errorCode: 'not_found', text: `No skill named "${name}". Run action "list" for the catalogue.` };
      const nodes = walkSkillTree(skill.dir);
      const header = `# Skill tree: ${skill.name} (${skill.scope}) — ${skill.dir}`;
      return { ok: true, isError: false, text: nodes.length ? `${header}\n\n${renderTree(nodes)}` : `${header}\n(empty)` };
    }
    const sections: string[] = [];
    for (const { root, scope } of skillRoots(workspaceRoot)) {
      const nodes = walkSkillTree(root);
      if (nodes.length === 0) continue;
      sections.push(`## ${scope}: ${root}\n${renderTree(nodes)}`);
    }
    return {
      ok: true,
      isError: false,
      text: sections.length
        ? sections.join('\n\n')
        : 'No skills storage found — create a skill folder (e.g. ~/.moriko-studio/skills/<name>/SKILL.md or <workspace>/.moriko/skills/<name>/SKILL.md).',
    };
  }

  if (action === 'file') {
    if (!relPath) return { ok: false, isError: true, errorCode: 'schema_error', text: 'action "file" needs a "path" (skill-relative, or relative to any skills root when "name" is omitted).' };
    if (name) {
      const skill = loadSkill(name, workspaceRoot);
      if (!skill) return { ok: false, isError: true, errorCode: 'not_found', text: `No skill named "${name}". Run action "list" for the catalogue.` };
      const content = readSkillCompanion(skill.dir, relPath);
      if (content === null) {
        const files = listSkillFiles(skill.dir);
        return { ok: false, isError: true, errorCode: 'not_found', text: `No file "${relPath}" in skill ${skill.name}. Files:\n${files.map((f) => `- ${f}`).join('\n') || '(none)'}` };
      }
      return { ok: true, isError: false, text: `# ${skill.name}/${relPath}\n\n${content}` };
    }
    // Storage-wide read: path is jailed to the union of all skill roots.
    const result = readSkillsStorageFile(relPath, workspaceRoot);
    if (!result.ok) return { ok: false, isError: true, errorCode: 'not_found', text: result.error };
    return { ok: true, isError: false, text: `# ${result.abs}\n\n${result.text}` };
  }

  if (action === 'load') {
    if (!name) return { ok: false, isError: true, errorCode: 'schema_error', text: 'action "load" needs a "name" (the skill name).' };
    const skill = loadSkill(name, workspaceRoot);
    if (!skill) {
      const known = listSkills(workspaceRoot).map((entry) => entry.name).join(', ') || '(none)';
      return { ok: false, isError: true, errorCode: 'not_found', text: `No skill named "${name}". Discovered skills: ${known}.` };
    }
    const files = listSkillFiles(skill.dir);
    return {
      ok: true,
      isError: false,
      text: [
        `# Skill: ${skill.name} (${skill.scope})`,
        `Folder: ${skill.dir}`,
        files.length ? `Companion files (read via action "file" when referenced):\n${files.map((f) => `- ${f}`).join('\n')}` : '',
        '',
        skill.body,
      ].filter(Boolean).join('\n'),
    };
  }

  return { ok: false, isError: true, errorCode: 'schema_error', text: `Unknown action "${action}". Use list | load | file | tree.` };
}

export const skillsSpec = defineTool({
  def: {
    wireName: 'agent__skills',
    description:
      "Agent skills (open Agent Skills format): load a discovered skill's full instructions on demand AND read the whole skills storage (workspace + harness home) even outside the active workspace. Actions: load { name } — SKILL.md body + companion file list; file { name, path } — one companion file of that skill; file { path } — ANY file inside the skills roots (jailed union read); tree { name? } — recursive file tree of one skill or all skills roots; list — the catalogue. Load a skill when the user's request matches its description (see the AVAILABLE SKILLS injection) or asks for it by name.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['load', 'file', 'tree', 'list'], description: 'Default "load".' },
        name: { type: 'string', description: 'Skill name (frontmatter name). Optional for file/tree actions.' },
        path: { type: 'string', description: 'action "file": file path — relative to the skill folder (with name) or to any skills root (without name).' },
      },
    },
  },
  handler: skillsTool,
  readOnly: true,
  category: 'orchestration',
});
