import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteJson } from './atomicWrite.js';
import { findBuiltIn } from './providers.js';

/**
 * ON-DISK LAYOUT — the single source of truth for where every persisted file
 * lives. Every store module imports its paths from here instead of hand-
 * rolling `path.join(process.cwd(), '.data', …)`, so the layout can never
 * drift between modules.
 *
 * ONE root: `~/.moriko-studio` (override with `MORIKO_HOME`). Everything the app
 * persists — provider definitions, the API-key vault, MCP servers, vision
 * settings, agent/settings/preferences, reminders, the agent harness's
 * session state (audit, jobs, read-state, vault) AND the project runtime
 * data (conversation archive, Image Studio sessions, gallery) — lives under
 * that one folder, so a fresh checkout of the repo starts clean and nothing
 * is ever buried inside the source tree.
 *
 * `DATA_DIR` is LEGACY: it only names where the pre-restructure stores were
 * (the project's old `.data/`), as the SOURCE for the boot migration.
 *
 * MIGRATION: `migrateLegacyLayout()` runs once at boot, BEFORE any store
 * touches disk. It moves the old files into this layout and renames the
 * originals to `<name>.migrated` (never deletes), so a pre-restructure
 * install keeps every byte and the pass is a no-op afterwards.
 */


const HOME_ROOT = path.resolve(
  process.env.MORIKO_HOME?.trim() || path.join(os.homedir(), '.moriko-studio'),
);

/** The resolved app data root (absolute) — EVERYTHING lives under this. */
export const morikoHome = HOME_ROOT;

/** The app data root as displayed to the user (forward slashes). */
export function morikoHomeDisplay(): string {
  return HOME_ROOT.replace(/\\/g, '/');
}

/** The DEFAULT app data root — `~/.moriko-studio` — as an absolute path. */
export function morikoHomeDefault(): string {
  return path.join(os.homedir(), '.moriko-studio');
}


/** Custom provider DEFINITIONS (no secrets). */
export const providersFile = path.join(HOME_ROOT, 'providers.json');
/** API-key vault: EVERY provider key (custom + built-in) with its endpoint. */
export const apiKeysFile = path.join(HOME_ROOT, 'api-keys.json');
/** Which provider + model answers agent__vision. */
export const visionFile = path.join(HOME_ROOT, 'vision.json');
/** User-registered MCP tool servers. */
export const mcpFile = path.join(HOME_ROOT, 'mcp.json');
/** Agent harness settings + allowed-directory allowlist. */
export const agentsFile = path.join(HOME_ROOT, 'agents.json');
/** Server-wide user settings (image retention window…). */
export const settingsFile = path.join(HOME_ROOT, 'settings.json');
/** Scheduled agent reminders. */
export const remindersFile = path.join(HOME_ROOT, 'reminders.json');
/** User-authored / user-customized agent workflows. */
export const workflowsFile = path.join(HOME_ROOT, 'workflows.json');
/**
 * CLIENT/UI STATE — the small per-device preferences that used to live in the
 * browser's localStorage: theme, zoom, font, sidebar, saved prompts, the last
 * provider/model, the active conversation and Image Studio session, and the
 * client's run journal. The browser stores NOTHING now; it hydrates this at
 * boot and patches it back on every change (see /api/ui-state).
 */
export const uiStateFile = path.join(HOME_ROOT, 'ui-state.json');


/** Per-session tool-call audit trails (JSONL). */
export const auditDir = path.join(HOME_ROOT, 'audit');
/** Per-run agent job journals. */
export const jobsDir = path.join(HOME_ROOT, 'jobs');
/**
 * Per-run SSE frame journals (`<streamId>.jsonl`) — the replay buffer that
 * survives a PROXY CRASH (see streamRegistry). A run whose in-memory buffer
 * died with the process replays from here on the next boot.
 */
export const runsDir = path.join(HOME_ROOT, 'runs');
/** Per-session read-before-edit tracking. */
export const readStateDir = path.join(HOME_ROOT, 'read-state');
/** Pre-destructive file snapshots (vault). */
export const vaultDir = path.join(HOME_ROOT, 'vault');
/** Realtime project-structure snapshots (tree index per workspace). */
export const treeIndexDir = path.join(HOME_ROOT, 'tree-index');


export const conversationDir = path.join(HOME_ROOT, 'conversation');
/** Compact per-chat summaries (the list view). */
export const conversationIndexFile = path.join(conversationDir, 'index.json');
/** Structural truth: folder mapping, chat order, next sequence number. */
export const conversationManifestFile = path.join(conversationDir, 'manifest.json');
/** Goals of sessions with no chat folder (synthetic/test session ids). */
export const detachedGoalsDir = path.join(conversationDir, 'detached');
/** Standalone todos of sessions with no chat folder (synthetic/test session ids). */
export const detachedTodosDir = path.join(conversationDir, 'detached');

/**
 * P2 EXTERNALIZATION — the byte store for everything a conversation record
 * used to carry inline as base64/HTML: attachment images, rendered visuals,
 * inline tool images. One shared directory keyed by the payload's content
 * hash, so the same image referenced by three chats occupies one file.
 */
export const attachmentsStoreDir = path.join(HOME_ROOT, 'attachments');

export const imageSessionDir = path.join(HOME_ROOT, 'image-session');
/** Image Studio sessions (named, ordered generation history). */
export const imageSessionsFile = path.join(imageSessionDir, 'data.json');
/** Generated image files + per-image sidecar JSON. */
export const imagesDir = path.join(imageSessionDir, 'images');
/** In-flight provider task records (survive restarts). */
export const imageTaskStateFile = path.join(imageSessionDir, 'task-state.json');
/** Append-only image-task lifecycle journal. */
export const imageTaskJournalFile = path.join(imageSessionDir, 'tasks.jsonl');

export const galleryDir = path.join(HOME_ROOT, 'gallery');
/** User-curated permanent image collection. */
export const galleryFile = path.join(galleryDir, 'data.json');

/** Kept as a string for legacy imports that still reference it. */
export const appDataDir = HOME_ROOT;


/** Where the pre-restructure stores lived: the project's old `.data/`. */

/** Where the pre-restructure stores lived: the project's old `.data/`. */
const LEGACY_DIR = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || './.data');

/** Moves one legacy path into its new home; never deletes (renames to .migrated on copy). */
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

/**
 * Normalizes the provider + key stores into the final shape:
 *
 *   providers.json  — definitions ONLY (no apiKey on records, no builtInKeys)
 *   api-keys.json   — { version, keys: { [id]: { apiKey, baseUrl? } } }
 *
 * Accepts every historical shape on either side: providers.json with
 * `builtInKeys` and/or apiKey-carrying records, and api-keys.json as a raw
 * id→string map, a `{ version, keys }` wrapper with raw strings, or the
 * current objects. Runs wherever the files are (legacy `.data` or already
 * under `~/.moriko`).
 */
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

/** Boot-time layout migration. Synchronous; run before any store touches disk. */
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
