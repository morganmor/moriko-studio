/**
 * Install the visual-context addon into the running Moriko app data root.
 *
 * The addon root is <MORIKO_HOME>/addons, where MORIKO_HOME resolves exactly
 * like server/paths.ts: process.env.MORIKO_HOME (loaded from the repo .env via
 * dotenv) or ~/.moriko-studio. The harness itself never reads .env
 * (self-host guard) - dotenv does the loading inside this Node script.
 *
 * Idempotent: re-running overwrites the addon files in place.
 *
 * Usage: node scripts/install-visual-context-addon.mjs
 */
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
require('dotenv').config();

const home = process.env.MORIKO_HOME?.trim() || path.join(process.env.USERPROFILE || process.env.HOME, '.moriko-studio');
const addonRoot = path.join(path.resolve(home), 'addons', 'visual-context');

const srcDir = path.join(root, 'addons-src', 'visual-context');
const files = ['addon.json', 'register.ts'];

if (!existsSync(srcDir)) {
  console.error(`[install] source not found: ${srcDir}`);
  process.exit(1);
}

mkdirSync(addonRoot, { recursive: true });
for (const file of files) {
  copyFileSync(path.join(srcDir, file), path.join(addonRoot, file));
}

console.log(`[install] visual-context installed at ${addonRoot}`);
console.log('[install] hot-reload picks it up automatically; or POST /api/addons/reload to force.');
