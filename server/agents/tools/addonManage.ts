/**
 * agent__addon_manage — the plugin-manager tool (mirrors deepseek-harness's
 * `plugin_manager` tool and Claude Code's plugin commands).
 *
 * Lets the in-harness agent list, enable/disable, install (scaffold), edit,
 * read/write addon files, and remove addons under the addon root — WITHOUT
 * terminal escalation. File access inside the addon root is direct (this tool
 * is the sandbox); anything outside it is refused. Install/remove take effect
 * IMMEDIATELY (the registry is reloaded after every mutation) — no restart,
 * matching deepseek's "live profiles apply changes immediately".
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listAddons, getAddon } from '../../addons/registry.js';
import { reloadAddon, loadAllAddons, ADDONS_ROOT } from '../../addons/loader.js';
import type { HarnessToolResult } from './shared.js';

export interface AddonManageArgs {
  action: 'list' | 'read' | 'write' | 'enable' | 'disable' | 'install' | 'edit' | 'remove' | 'reload';
  id?: string;
  /** read/write: file path relative to the addon root (e.g. 'addon.json', 'client/index.tsx', 'lib/util.ts'). */
  file?: string;
  /** write: full new content of the file. */
  content?: string;
  /** install/edit: manifest fields. */
  name?: string;
  description?: string;
  version?: string;
  /** install/edit: register.ts source (the entry point with register(on, $)). */
  registerCode?: string;
  /** install/edit: widget client source (React component, .tsx). */
  clientCode?: string;
}

const ok = (text: string): HarnessToolResult => ({ ok: true, isError: false, text });
const err = (text: string): HarnessToolResult => ({ ok: false, isError: true, text });

/** Refuse anything outside the addon root (path traversal guard). */
function safeJoin(id: string, rel: string): string | null {
  const root = path.resolve(ADDONS_ROOT(), id);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function scaffoldAddon(id: string, args: AddonManageArgs): string {
  const dir = path.join(ADDONS_ROOT(), id);
  if (existsSync(dir)) return `Addon "${id}" already exists — use action "edit" or "write" to modify it.`;
  mkdirSync(path.join(dir, 'client'), { recursive: true });

  const manifest = {
    id,
    name: args.name ?? id,
    version: args.version ?? '0.1.0',
    description: args.description ?? '',
    author: 'agent',
    enabled: true,
  };
  writeFileSync(path.join(dir, 'addon.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  const register = args.registerCode
    ?? `export function register(on, $) {\n${args.clientCode ? `  $.ui.draw('thread-sidebar', { type: 'widget', component: './client/index.tsx' });\n` : ''}  $.ui.log('${id} loaded');\n}\n`;
  writeFileSync(path.join(dir, 'register.ts'), register, 'utf-8');

  if (args.clientCode) {
    writeFileSync(path.join(dir, 'client', 'index.tsx'), args.clientCode, 'utf-8');
  }
  return `Addon "${id}" installed and active.`;
}

function editAddon(id: string, args: AddonManageArgs): string {
  const dir = path.join(ADDONS_ROOT(), id);
  const manifestPath = path.join(dir, 'addon.json');
  if (!existsSync(manifestPath)) return `Addon "${id}" not found.`;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (args.name !== undefined) manifest.name = args.name;
  if (args.description !== undefined) manifest.description = args.description;
  if (args.version !== undefined) manifest.version = args.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  if (args.registerCode !== undefined) {
    writeFileSync(path.join(dir, 'register.ts'), args.registerCode, 'utf-8');
  }
  if (args.clientCode !== undefined) {
    writeFileSync(path.join(dir, 'client', 'index.tsx'), args.clientCode, 'utf-8');
  }
  return `Addon "${id}" updated.`;
}

export async function addonManageTool(args: AddonManageArgs): Promise<HarnessToolResult> {
  const action = args.action;
  try {
    switch (action) {
      case 'list': {
        const addons = listAddons();
        if (addons.length === 0) return ok('No addons installed.');
        const lines = addons.map((a) => {
          const m = a.manifest;
          return `${a.enabled ? '[x]' : '[ ]'} ${m.id} v${m.version} — ${m.name}: ${m.description}${a.loadError ? ` (load error: ${a.loadError})` : ''}`;
        });
        return ok(lines.join('\n'));
      }

      case 'read': {
        if (!args.id) return err('id is required for read.');
        const rel = args.file ?? 'addon.json';
        const full = safeJoin(args.id, rel);
        if (!full) return err('file path escapes the addon root.');
        if (!existsSync(full) || statSync(full).isDirectory()) {
          if (existsSync(full) && statSync(full).isDirectory()) {
            return ok(readdirSync(full).join('\n'));
          }
          return err(`File "${rel}" not found in "${args.id}".`);
        }
        return ok(readFileSync(full, 'utf-8'));
      }

      case 'write': {
        if (!args.id) return err('id is required for write.');
        if (typeof args.content !== 'string') return err('content is required for write.');
        const rel = args.file;
        if (!rel) return err('file is required for write (path relative to the addon root).');
        const full = safeJoin(args.id, rel);
        if (!full) return err('file path escapes the addon root.');
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, args.content, 'utf-8');
        await loadAllAddons();
        return ok(`Written ${args.id}/${rel} — addon reloaded, change is live.`);
      }

      case 'enable':
      case 'disable': {
        if (!args.id) return err('id is required for enable/disable.');
        const addon = getAddon(args.id);
        if (!addon) return err(`Addon "${args.id}" not found.`);
        const want = action === 'enable';
        if (addon.enabled === want) return ok(`Addon "${args.id}" is already ${want ? 'enabled' : 'disabled'}.`);
        try {
          const manifestPath = path.join(ADDONS_ROOT(), args.id, 'addon.json');
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          manifest.enabled = want;
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        } catch {  }
        const done = await reloadAddon(args.id, want);
        if (!done) return err(`Reload failed for "${args.id}".`);
        return ok(`Addon "${args.id}" ${want ? 'enabled' : 'disabled'}.`);
      }

      case 'install': {
        if (!args.id) return err('id is required for install.');
        const msg = scaffoldAddon(args.id, args);
        await loadAllAddons();
        return ok(msg);
      }

      case 'edit': {
        if (!args.id) return err('id is required for edit.');
        const msg = editAddon(args.id, args);
        await loadAllAddons();
        return ok(msg);
      }

      case 'remove': {
        if (!args.id) return err('id is required for remove.');
        const dir = path.join(ADDONS_ROOT(), args.id);
        if (!existsSync(dir)) return err(`Addon "${args.id}" not found.`);
        rmSync(dir, { recursive: true, force: true });
        await loadAllAddons();
        return ok(`Addon "${args.id}" removed.`);
      }

      case 'reload': {
        await loadAllAddons();
        return ok(`Reloaded ${listAddons().length} addon(s).`);
      }

      default:
        return err(`Unknown action "${action}".`);
    }
  } catch (error) {
    return err(error instanceof Error ? error.message : 'addon_manage failed');
  }
}
