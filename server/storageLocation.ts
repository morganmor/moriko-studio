

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getEnvValue, setEnvValue } from './envFile.js';
import { morikoHome, morikoHomeDefault, morikoHomeDisplay } from './paths.js';

export interface StorageLocationView {
  
  current: string;
  
  pending: string | null;
  
  default: string;
  
  isDefault: boolean;
  
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


export function getStorageLocation(): StorageLocationView {
  return view();
}


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
