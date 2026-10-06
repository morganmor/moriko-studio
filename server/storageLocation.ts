/**
 * STORAGE LOCATION — the API layer for "where Moriko keeps its data".
 *
 * MORIKO_HOME is resolved once at boot (paths.ts), so the user's pick from
 * Settings cannot switch the running process live. The whole contract:
 *
 *   1. validate the folder,
 *   2. persist the choice in .env (MORIKO_HOME),
 *   3. the user presses "Reload harness" and the fresh boot reads the new
 *      home — which starts EMPTY. Data in the previous location is never
 *      touched: no copy, no move, no delete.
 */

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getEnvValue, setEnvValue } from './envFile.js';
import { morikoHome, morikoHomeDefault, morikoHomeDisplay } from './paths.js';

export interface StorageLocationView {
  /** The home the RUNNING process was booted with. */
  current: string;
  /** What .env selects — differs from `current` until the next reload. */
  pending: string | null;
  /** The built-in default (~/.moriko-studio). */
  default: string;
  /** True when the running home is the default. */
  isDefault: boolean;
  /** Set after PUT — the change goes live on the next harness reload. */
  needsReload?: boolean;
}

function view(): StorageLocationView {
  const def = morikoHomeDefault();
  const envValue = getEnvValue('MORIKO_HOME')?.trim() || null;
  const pending = envValue && path.resolve(envValue) !== path.resolve(morikoHome)
    ? envValue.replace(/\\/g, '/')
    : null;
  return {
    current: morikoHomeDisplay(),
    pending,
    default: def.replace(/\\/g, '/'),
    isDefault: path.resolve(morikoHome) === path.resolve(def),
  };
}

/**
 * Validate a user-supplied location before anything is written. Absolute, not
 * the source tree, not an existing FILE, and writable (probe by creating the
 * directory — the same mkdir the boot would run).
 */
export function validateLocation(raw: string): { ok: true; resolved: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'Enter an absolute folder path.' };

  const resolved = path.resolve(value.replace(/^~(?=\/|\\|$)/, os.homedir()));
  if (!path.isAbsolute(resolved)) {
    return { ok: false, error: 'The location must be an absolute path.' };
  }

  const cwd = path.resolve(process.cwd());
  if (resolved === cwd || cwd.startsWith(resolved + path.sep)) {
    return { ok: false, error: 'The location must be outside the Moriko source tree.' };
  }

  if (existsSync(resolved)) {
    try {
      if (!statSync(resolved).isDirectory()) {
        return { ok: false, error: 'That path is a file, not a folder.' };
      }
      // Writability probe: create + remove a throwaway file.
      const probe = path.join(resolved, '.moriko-write-probe');
      mkdirSync(resolved, { recursive: true });
      writeFileSync(probe, '');
      unlinkSync(probe);
    } catch {
      return { ok: false, error: 'Moriko cannot write to that folder (permissions?).' };
    }
  } else {
    try {
      mkdirSync(resolved, { recursive: true });
    } catch {
      return { ok: false, error: 'That folder cannot be created (check the path / permissions).' };
    }
  }

  return { ok: true, resolved };
}

/** Current location + what .env selects (never mutates anything). */
export function getStorageLocation(): StorageLocationView {
  return view();
}

/** Persist a new location: validate + write .env. Nothing is copied or moved. */
export function setStorageLocation(raw: string): StorageLocationView & { needsReload: boolean } {
  const checked = validateLocation(raw);
  if (!checked.ok) {
    const error = new Error(checked.error) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  setEnvValue('MORIKO_HOME', checked.resolved);
  return { ...view(), needsReload: true };
}
