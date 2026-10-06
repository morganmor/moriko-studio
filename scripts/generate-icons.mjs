/**
 * ICON GATEWAY GENERATOR — P4 spike "deep-import per-ikon".
 *
 * Problem: every component imported icons from the `lucide-react` BARREL. In
 * dev, Vite's dep pre-bundler materializes the whole barrel — all ~1,700 icon
 * modules (measured ~934 KB in the audit's waterfall) — into one dependency
 * chunk the browser parses on every boot, even though this app uses 102 icons.
 * In prod, Rollup's tree-shaking mostly saved us; the DEV bottleneck is what
 * this kills.
 *
 * This script:
 *   1. scans src/** for the named imports from 'lucide-react' (the exact set
 *      of icons the app uses);
 *   2. maps each exported name to its real per-icon file via the barrel's own
 *      `export { default as X } from './icons/...'` lines (aliases included —
 *      CheckCircle2 → circle-check.js, Loader2 → loader-circle.js);
 *   3. (re)generates src/components/icons.ts — one typed re-export per icon,
 *      deep-imported, so bundlers only ever touch ~102 tiny modules;
 *   4. rewrites every `from 'lucide-react'` in src/ to `from './icons'`
 *      (named imports stay byte-identical — icons.ts exports the same names).
 *
 * Type safety: lucide ships no per-icon declarations (no exports map in this
 * version), so src/types/lucide-deep.d.ts declares the wildcard module shape.
 *
 * Run: node scripts/generate-icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const BARREL = path.join(ROOT, 'node_modules/lucide-react/dist/esm/lucide-react.js');
const OUT_FILE = path.join(SRC, 'components/icons.ts');

if (!fs.existsSync(BARREL)) {
  console.error('lucide-react is not installed (barrel missing). Run pnpm install first.');
  process.exit(1);
}


/** Recursively collects every .ts/.tsx file under src/ (node_modules-free). */
function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const used = new Map();
const IMPORT_SPECS = [
  /import\s*\{([^}]+)\}\s*from\s*'lucide-react'/g,
  /import\s*\{([^}]+)\}\s*from\s*'((?:\.\.?\/)+components\/icons|\.\/icons)'/g,
];
for (const file of collectFiles(SRC)) {
  if (file === OUT_FILE) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const re of IMPORT_SPECS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name && !used.has(name)) used.set(name, path.relative(ROOT, file));
      }
    }
  }
}
if (used.size === 0) {
  if (fs.existsSync(OUT_FILE)) {
    const current = fs.readFileSync(OUT_FILE, 'utf8');
    for (const match of current.matchAll(/^const (\w+) = \w+__raw as unknown as LucideIcon;$/gm)) {
      used.set(match[1], '(existing gateway)');
    }
  }
}
if (used.size === 0) {
  console.log('No lucide-react imports found — nothing to generate.');
  process.exit(0);
}

const barrelSource = fs.readFileSync(BARREL, 'utf8');
const aliases = new Map();
for (const match of barrelSource.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/(icons\/[^']+)'/g)) {
  for (const raw of match[1].split(',')) {
    const name = /^default\s+as\s+(\w+)$/.exec(raw.trim())?.[1];
    if (name && !aliases.has(name)) aliases.set(name, match[2]);
  }
}

const missing = [...used.keys()].filter((name) => !aliases.has(name));
if (missing.length > 0) {
  console.error(`These icons are used but NOT exported by the installed lucide barrel:\n  ${missing.join(', ')}`);
  process.exit(1);
}


const rows = [...used.keys()].sort().map((name) => {
  const iconFile = aliases.get(name).replace(/^\.\//, '');
  const varName = `${name}__raw`;
  return [
    `import ${varName} from 'lucide-react/dist/esm/${iconFile}';`,
    `/** ${name} — used in ${used.get(name)} */`,
    `const ${name} = ${varName} as unknown as LucideIcon;`,
    `export { ${name} };`,
    '',
  ].join('\n');
});

const header = `/**
 * ICON GATEWAY — GENERATED FILE (scripts/generate-icons.mjs). DO NOT EDIT.
 *
 * P4: every icon here is DEEP-IMPORTED from lucide's per-icon module instead
 * of riding the barrel, so the dev pre-bundle ships ~102 small modules instead
 * of all ~1,700 (the audit measured a ~934 KB barrel chunk on the boot
 * waterfall). Add an icon by importing it in a component as before, then run:
 *
 *   node scripts/generate-icons.mjs
 *
 * The wildcard typing lives in src/types/lucide-deep.d.ts (lucide ships no
 * per-icon declarations in this version).
 */
import type { LucideIcon } from 'lucide-react';

`;

fs.writeFileSync(OUT_FILE, header + rows.join('\n'), 'utf8');


let rewritten = 0;
for (const file of collectFiles(SRC)) {
  if (file === OUT_FILE) continue;
  if (file.endsWith('.d.ts')) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(`from 'lucide-react'`)) continue;
  const next = source.replace(
    /(import\s*\{[^}]*\}\s*from\s*)'lucide-react'/g,
    "$1'./icons'",
  );
  if (next !== source) {
    fs.writeFileSync(file, next, 'utf8');
    rewritten += 1;
  }
}

console.log(`icons.ts generated: ${used.size} icons, ${rewritten} file(s) rewritten.`);
