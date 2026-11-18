import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteJson } from './atomicWrite.js';
import { findBuiltIn } from './providers.js';




const HOME_ROOT = path.resolve(
  process.env.MORIKO_HOME?.trim() || path.join(os.homedir(), '.moriko-studio'),
);


export const morikoHome = HOME_ROOT;


export function morikoHomeDisplay(): string {
  return HOME_ROOT.replace(/\\/g, '/');
}


export function morikoHomeDefault(): string {
  return path.join(os.homedir(), '.moriko-studio');
}



export const providersFile = path.join(HOME_ROOT, 'providers.json');

export const apiKeysFile = path.join(HOME_ROOT, 'api-keys.json');

export const visionFile = path.join(HOME_ROOT, 'vision.json');

export const mcpFile = path.join(HOME_ROOT, 'mcp.json');

export const figmaAuthFile = path.join(HOME_ROOT, 'figma-auth.json');

export const agentsFile = path.join(HOME_ROOT, 'agents.json');

export const settingsFile = path.join(HOME_ROOT, 'settings.json');

export const remindersFile = path.join(HOME_ROOT, 'reminders.json');

export const workflowsFile = path.join(HOME_ROOT, 'workflows.json');

export const skillsDir = path.join(HOME_ROOT, 'skills');

export const uiStateFile = path.join(HOME_ROOT, 'ui-state.json');



export const auditDir = path.join(HOME_ROOT, 'audit');

export const jobsDir = path.join(HOME_ROOT, 'jobs');

export const runsDir = path.join(HOME_ROOT, 'runs');

export const readStateDir = path.join(HOME_ROOT, 'read-state');

export const vaultDir = path.join(HOME_ROOT, 'vault');

export const treeIndexDir = path.join(HOME_ROOT, 'tree-index');


export const conversationDir = path.join(HOME_ROOT, 'conversation');

export const conversationIndexFile = path.join(conversationDir, 'index.json');

export const conversationManifestFile = path.join(conversationDir, 'manifest.json');

export const detachedGoalsDir = path.join(conversationDir, 'detached');

export const detachedTodosDir = path.join(conversationDir, 'detached');


export const attachmentsStoreDir = path.join(HOME_ROOT, 'attachments');

export const imageSessionDir = path.join(HOME_ROOT, 'image-session');

export const imageSessionsFile = path.join(imageSessionDir, 'data.json');

export const imagesDir = path.join(imageSessionDir, 'images');

export const imageTaskStateFile = path.join(imageSessionDir, 'task-state.json');

export const imageTaskJournalFile = path.join(imageSessionDir, 'tasks.jsonl');

export const galleryDir = path.join(HOME_ROOT, 'gallery');

export const galleryFile = path.join(galleryDir, 'data.json');


export const appDataDir = HOME_ROOT;





const LEGACY_DIR = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || './.data');


function migrateOne(from: string, to: string, label: string, report: string[]): void {
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    report.push(`${label}: legacy ${path.basename(from)} kept in place (target already exists)`);
    return;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    renameSync(from, to);
    report.push(`${label}: moved ${path.basename(from)}`);
  } catch {
    try {
      cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      renameSync(from, `${from}.migrated`);
      report.push(`${label}: copied ${path.basename(from)} (original parked as .migrated)`);
    } catch (error) {
      report.push(`${label}: MIGRATION FAILED for ${path.basename(from)}: ${String(error)}`);
    }
  }
}


function normalizeProviderStores(root: string, report: string[]): void {
  const providersPath = path.join(root, 'providers.json');
  const keysPath = path.join(root, 'api-keys.json');

  let definitions: {
    version: 1;
    providers: Array<Record<string, unknown>>;
    builtInModels?: Record<string, unknown>;
    builtInLiveModels?: Record<string, unknown>;
    builtInKeys?: Record<string, string>;
  } | null = null;
  try {
    if (existsSync(providersPath)) {
      definitions = JSON.parse(readFileSync(providersPath, 'utf8'));
    }
  } catch {
    report.push('providers: definitions file unreadable — left untouched');
  }

  const keys: Record<string, { apiKey: string; baseUrl?: string }> = {};
  let keysFileExisted = false;
  let keysWereLegacy = false;
  try {
    if (existsSync(keysPath)) {
      keysFileExisted = true;
      const parsed = JSON.parse(readFileSync(keysPath, 'utf8')) as unknown;
      const raw =
        parsed && typeof parsed === 'object' && 'keys' in (parsed as Record<string, unknown>)
          ? (parsed as { keys: unknown }).keys
          : parsed;
      if (raw && typeof raw === 'object') {
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === 'string' && value) {
            keys[id] = { apiKey: value };
            keysWereLegacy = true;
          } else if (value && typeof value === 'object') {
            const entry = value as { apiKey?: unknown; baseUrl?: unknown };
            if (typeof entry.apiKey === 'string' && entry.apiKey) {
              keys[id] = {
                apiKey: entry.apiKey,
                ...(typeof entry.baseUrl === 'string' && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
              };
            }
          }
        }
      }
    }
  } catch {
    report.push('api-keys: existing vault unreadable — kept as-is');
  }

  let changed = keysWereLegacy;

  if (definitions) {
    for (const record of definitions.providers) {
      const apiKey = record.apiKey;
      if (typeof apiKey === 'string' && apiKey) {
        keys[String(record.id ?? '')] = {
          apiKey,
          ...(typeof record.baseUrl === 'string' && record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        };
        delete record.apiKey;
        changed = true;
      }
    }
    const legacyBuiltInKeys = definitions.builtInKeys;
    if (legacyBuiltInKeys && typeof legacyBuiltInKeys === 'object') {
      for (const [id, apiKey] of Object.entries(legacyBuiltInKeys)) {
        if (!apiKey) continue;
        keys[id] = { apiKey, ...(findBuiltIn(id) ? { baseUrl: findBuiltIn(id)!.baseUrl } : {}) };
      }
      delete definitions.builtInKeys;
      changed = true;
    }
  }

  if (!changed) return;

  if (definitions) {
    mkdirSync(root, { recursive: true });
    atomicWriteJson(providersPath, {
      version: 1,
      providers: definitions.providers,
      builtInModels: definitions.builtInModels ?? {},
      builtInLiveModels: definitions.builtInLiveModels ?? {},
    });
  }
  if (keysFileExisted || Object.keys(keys).length > 0) {
    mkdirSync(root, { recursive: true });
    atomicWriteJson(keysPath, { version: 1, keys });
  }
  report.push(
    `providers: normalized (definitions${definitions ? '' : ' missing'} + ${Object.keys(keys).length} key(s) in api-keys.json)`,
  );
}


export function migrateLegacyLayout(): void {
  const report: string[] = [];

  // NOTE: the storage-location flow is copy-free by design — a custom

  if (existsSync(LEGACY_DIR)) {
    for (const [from, to] of [
      [path.join(LEGACY_DIR, 'providers.json'), providersFile],
      [path.join(LEGACY_DIR, 'api-keys.json'), apiKeysFile],
      [path.join(LEGACY_DIR, 'mcp.json'), mcpFile],
      [path.join(LEGACY_DIR, 'vision.json'), visionFile],
      [path.join(LEGACY_DIR, 'reminders.json'), remindersFile],
      [path.join(LEGACY_DIR, 'settings.json'), settingsFile],
      [path.join(LEGACY_DIR, 'agents.json'), agentsFile],
      [path.join(LEGACY_DIR, 'audit'), auditDir],
      [path.join(LEGACY_DIR, 'jobs'), jobsDir],
      [path.join(LEGACY_DIR, 'read-state'), readStateDir],
      [path.join(LEGACY_DIR, 'vault'), vaultDir],
      [path.join(LEGACY_DIR, 'conversation'), conversationDir],
      [path.join(LEGACY_DIR, 'image-session'), imageSessionDir],
      [path.join(LEGACY_DIR, 'gallery'), galleryDir],
      [path.join(LEGACY_DIR, 'image-sessions.json'), imageSessionsFile],
      [path.join(LEGACY_DIR, 'images'), imagesDir],
      [path.join(LEGACY_DIR, 'image-tasks-state.json'), imageTaskStateFile],
      [path.join(LEGACY_DIR, 'image-tasks.jsonl'), imageTaskJournalFile],
      [path.join(LEGACY_DIR, 'gallery.json'), galleryFile],
      [path.join(LEGACY_DIR, 'conversations.json'), path.join(HOME_ROOT, 'conversations.json')],
      [path.join(LEGACY_DIR, 'goals.json'), path.join(HOME_ROOT, 'goals.json')],
    ] as Array<[string, string]>) {
      migrateOne(from, to, 'data', report);
    }

    try {
      for (const entry of readdirSync(LEGACY_DIR)) {
        if (entry.endsWith('.tmp')) rmSync(path.join(LEGACY_DIR, entry), { force: true });
      }
    } catch {
    }
  }

  normalizeProviderStores(HOME_ROOT, report);

  if (report.length > 0) {
    console.log(`[layout] migrated legacy stores →\n  ${report.join('\n  ')}`);
  }
}
