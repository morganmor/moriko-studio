/**
 * F4.4 — agent__scaffold: instantiate project templates from
 * server/agents/templates/<id>/*.tpl ({{name}}, {{Name}}, {{name_kebab}}),
 * refusing to overwrite, all writes vaulted. Template list via { "list": true }.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, bool, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { snapshotFile } from '../vault.js';
import { defineTool } from './registry.js';

function templatesRoot(): string {
  // templates live next to this compiled file: server/agents/templates
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl
    .replace(/\{\{name_kebab\}\}/g, vars.name_kebab ?? '')
    .replace(/\{\{Name\}\}/g, vars.Name ?? '')
    .replace(/\{\{name\}\}/g, vars.name ?? '');
}

/** Render a template's file list: dir => [templateFile, targetPath(out)]. */
function renderTemplate(id: string, dest: string, vars: Record<string, string>): Array<{ tplFile: string; target: string; content: string }> {
  const root = path.join(templatesRoot(), id);
  const out: Array<{ tplFile: string; target: string; content: string }> = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const relEntry = rel ? `${rel}/${entry}` : entry;
      if (statSync(abs).isDirectory()) {
        walk(abs, relEntry);
      } else {
        const target = fill(relEntry, vars).replace(/\.tpl$/, '');
        out.push({ tplFile: abs, target: path.join(dest, target), content: fill(readFileSync(abs, 'utf8'), vars) });
      }
    }
  };
  walk(root, '');
  return out;
}

async function scaffoldTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);

  if (bool(args, 'list')) {
    const tr = templatesRoot();
    if (!existsSync(tr)) return { ok: true, isError: false, text: 'No templates directory.' };
    const ids = readdirSync(tr).filter((f) => statSync(path.join(tr, f)).isDirectory());
    if (ids.length === 0) return { ok: true, isError: false, text: 'No templates installed.' };
    const lines: string[] = ['templates:'];
    for (const id of ids) {
      const files = renderTemplate(id, '', { name: 'x', Name: 'X', name_kebab: 'x' });
      lines.push(`  ${id} — ${files.length} file(s): ${files.map((f) => f.target.split(path.sep).pop()).join(', ')}`);
    }
    lines.push('');
    lines.push('vars: name (camel), Name (Pascal), name_kebab. Use { "template": id, "dest": path, "vars": { "name": "Gallery" }, "dryRun": true }.');
    return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
  }

  const template = str(args, 'template').trim();
  const destRaw = str(args, 'dest').trim();
  if (!template || !destRaw) {
    return { ok: false, isError: true, text: 'scaffold needs "template" and "dest" (or "list": true).' };
  }
  const dryRun = args.dryRun === undefined ? true : bool(args, 'dryRun');
  const resolved = await resolveWithPermission('scaffold', destRaw, ctx, 'write');

  const nameRaw = str(args, 'name').trim() || path.basename(destRaw);
  const vars = {
    name: nameRaw,
    Name: nameRaw.charAt(0).toUpperCase() + nameRaw.slice(1),
    name_kebab: nameRaw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
  };

  const tr = path.join(templatesRoot(), template);
  if (!existsSync(tr)) {
    return { ok: false, isError: true, text: `Unknown template "${template}". Call scaffold { "list": true } for the available set.` };
  }

  const files = renderTemplate(template, resolved.absolute, vars);
  const conflicts = files.filter((f) => existsSync(f.target));
  if (conflicts.length > 0) {
    return {
      ok: false,
      isError: true,
      text: `Refusing to overwrite: ${conflicts.map((f) => path.relative(root, f.target).replace(/\\/g, '/')).join(', ')}.`,
    };
  }

  if (dryRun) {
    const lines: string[] = [`scaffold "${template}" → ${destRaw} (dry run — pass dryRun:false to write):`];
    for (const f of files) {
      lines.push(`  + ${path.relative(root, f.target).replace(/\\/g, '/')}  (${f.content.split('\n').length} lines)`);
    }
    return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
  }

  const written: string[] = [];
  for (const f of files) {
    mkdirSync(path.dirname(f.target), { recursive: true });
    writeFileSync(f.target, f.content);
    written.push(path.relative(root, f.target).replace(/\\/g, '/'));
    try { snapshotFile(ctx.sessionId, f.target, 'scaffold'); } catch { /* new file: nothing to vault */ }
  }
  return {
    ok: true,
    isError: false,
    text: truncateOutput(`Scaffolded ${written.length} file(s) into ${destRaw}:\n${written.map((w) => `  + ${w}`).join('\n')}\nNext: review the files, then agent__typecheck.`),
  };
}

export const scaffoldSpec = defineTool({
  def: {
    wireName: 'agent__scaffold',
    description: 'Instantiate a project template (react-feature / express-route / addon / three-vite / canvas2d-game / phaser-game); dryRun default.',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template id.' },
        dest: { type: 'string', description: 'Destination directory.' },
        name: { type: 'string', description: 'Feature name (default: dest basename).' },
        dryRun: { type: 'boolean', description: 'Preview only (default true).' },
        list: { type: 'boolean', description: 'List templates instead.' },
      },
    },
  },
  handler: scaffoldTool,
  readOnly: false,
  terminal: false,
  category: 'arch',
});
