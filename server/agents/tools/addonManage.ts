

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listAddons, getAddon } from '../../addons/registry.js';
import { reloadAddon, loadAllAddons, ADDONS_ROOT } from '../../addons/loader.js';
import { invalidateSearchIndex } from '../search.js';
import { publishBusEvent } from '../../addons/bus.js';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { addonsSrcRoot } from '../workspace.js';
import { requestApproval } from '../permissions.js';


function invalidateAddonSourceIndex(dir: string): void {
  const srcRoot = addonsSrcRoot();
  if (!srcRoot || !dir.startsWith(srcRoot)) return;
  invalidateSearchIndex(srcRoot);
}


const publishRegistry = (payload: Record<string, unknown>): void => {
  void publishBusEvent('addons.registry', payload, 'moriko-host');
};


const reloadOne = async (id: string): Promise<void> => {
  const ok = await reloadAddon(id);
  if (!ok) await loadAllAddons();
};


function addonsSrcDir(id: string): string | null {
  try {
    const dir = path.resolve(process.cwd(), 'addons-src', id);
    return existsSync(path.join(dir, 'addon.json')) ? dir : null;
  } catch {
    return null;
  }
}

export interface AddonManageArgs {
  action: 'list' | 'read' | 'write' | 'enable' | 'disable' | 'install' | 'edit' | 'remove' | 'reload';
  id?: string;
  
  file?: string;
  
  content?: string;
  
  name?: string;
  description?: string;
  version?: string;
  
  registerCode?: string;
  
  clientCode?: string;
}

const ok = (text: string): HarnessToolResult => ({ ok: true, isError: false, text });
const err = (text: string): HarnessToolResult => ({ ok: false, isError: true, text });


function dirFor(id: string): string {
  return addonsSrcDir(id) ?? path.resolve(ADDONS_ROOT(), id);
}

function scaffoldAddon(id: string, args: AddonManageArgs): string {
  const dir = addonsSrcDir(id) ?? path.resolve(process.cwd(), 'addons-src', id);
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
  invalidateAddonSourceIndex(dir);
  return `Addon "${id}" installed and active.`;
}

function editAddon(id: string, args: AddonManageArgs): string {
  const dir = dirFor(id);
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
  invalidateAddonSourceIndex(dir);
  return `Addon "${id}" updated.`;
}

export async function addonManageTool(
  args: AddonManageArgs,
  ctx: AgentToolContext = {},
): Promise<HarnessToolResult> {
  const action = args.action;
  try {
    const MUTATING_ACTIONS = new Set(['write', 'enable', 'disable', 'install', 'edit', 'reload']);
    if (MUTATING_ACTIONS.has(action)) {
      const targetDir = args.id ? dirFor(args.id) : ADDONS_ROOT();
      const targetPaths = args.file && args.id ? [path.resolve(targetDir, args.file)] : [targetDir];
      const decision = await requestApproval(
        {
          tool: 'addon_manage',
          paths: targetPaths,
          root: ADDONS_ROOT(),
          intent: action === 'reload' ? 'exec' : 'write',
          command: `addon_manage ${action}${args.id ? ` "${args.id}"` : ''}${args.file ? ` (${args.file})` : ''}`,
        },
        ctx,
      );
      if (!decision.granted) {
        return err(`User did not approve addon_manage ${action}.${decision.reason ? ` Reason: "${decision.reason}".` : ''}`);
      }
    }
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
        const root = dirFor(args.id);
        const full = path.resolve(root, rel);
        if (full !== root && !full.startsWith(root + path.sep)) return err('file path escapes the addon folder.');
        if (!existsSync(full) || statSync(full).isDirectory()) {
          if (existsSync(full) && statSync(full).isDirectory()) {
            return ok(readdirSync(full).join('\n'));
          }
          return err(`File "${rel}" not found in "${args.id}"${addonsSrcDir(args.id) ? ' (addons-src source)' : ''}.`);
        }
        return ok(readFileSync(full, 'utf-8'));
      }

      case 'write': {
        if (!args.id) return err('id is required for write.');
        if (typeof args.content !== 'string') return err('content is required for write.');
        const rel = args.file;
        if (!rel) return err('file is required for write (path relative to the addon root).');
        const root = dirFor(args.id);
        const full = path.resolve(root, rel);
        if (full !== root && !full.startsWith(root + path.sep)) return err('file path escapes the addon folder.');
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, args.content, 'utf-8');
        await reloadOne(args.id);
        publishRegistry({ reason: 'reload', addonId: args.id });
        if (addonsSrcDir(args.id)) invalidateAddonSourceIndex(full);
        const where = addonsSrcDir(args.id) ? 'addons-src source (runtime copies on the Hub\'s Disable/Reload reseed)' : 'addon root';
        return ok(`Written ${args.id}/${rel} — ${where}; addon reloaded.`);
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
        publishRegistry({ reason: 'toggle', addonId: args.id, enabled: want });
        return ok(`Addon "${args.id}" ${want ? 'enabled' : 'disabled'}.`);
      }

      case 'install': {
        if (!args.id) return err('id is required for install.');
        const msg = scaffoldAddon(args.id, args);
        await reloadOne(args.id);
        publishRegistry({ reason: 'install', addonId: args.id });
        return ok(msg);
      }

      case 'edit': {
        if (!args.id) return err('id is required for edit.');
        const msg = editAddon(args.id, args);
        await reloadOne(args.id);
        publishRegistry({ reason: 'reload', addonId: args.id });
        return ok(msg);
      }

      case 'remove': {
        return err(
          'Removing addons is user-only — the agent cannot delete addons. ' +
          'Ask the user to remove it via the Addon Hub (Remove button, confirm modal).',
        );
      }

      case 'reload': {
        await loadAllAddons();
        publishRegistry({ reason: 'reload-all' });
        return ok(`Reloaded ${listAddons().length} addon(s).`);
      }

      default:
        return err(`Unknown action "${action}".`);
    }
  } catch (error) {
    return err(error instanceof Error ? error.message : 'addon_manage failed');
  }
}
