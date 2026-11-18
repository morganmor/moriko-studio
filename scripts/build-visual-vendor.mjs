
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LIBS = [
  { id: 'three', entry: 'three', global: 'THREE' },
  { id: 'three-addons-orbit', entry: 'three/addons/controls/OrbitControls.js', global: 'MORIKO_ORBIT_CONTROLS' },
  { id: 'pixi', entry: 'pixi.js', global: 'PIXI' },
  { id: 'matter', entry: 'matter-js', global: 'Matter' },
];

const cacheDir = path.join(os.homedir(), '.moriko-studio', 'visual-vendor');
mkdirSync(cacheDir, { recursive: true });

for (const lib of LIBS) {
  try {
    await build({
      entryPoints: [lib.entry],
      bundle: true,
      minify: true,
      format: 'iife',
      globalName: lib.global,
      outfile: path.join(cacheDir, `${lib.id}.js`),
      logLevel: 'warning',
      target: 'es2020',
    });
    console.log(`ok: ${lib.id} -> ${path.join(cacheDir, lib.id + '.js')}`);
  } catch (error) {
    console.error(`fail: ${lib.id}: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
