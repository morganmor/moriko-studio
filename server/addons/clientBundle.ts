

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { ADDONS_ROOT } from './loader.js';


const SHIM_IMPORTS: Record<string, string> = {
  react: '/api/addons/host-shim/react.js',
  'react/jsx-runtime': '/api/addons/host-shim/jsx-runtime.js',
  'react-dom': '/api/addons/host-shim/react-dom.js',
  'react-dom/client': '/api/addons/host-shim/react-dom-client.js',
  '@moriko/host': '/api/addons/host-shim/host.js',
};

interface CacheEntry {
  js: string;
  mtime: number;
  etag: string;
}

const cache = new Map<string, CacheEntry>();


function resolveClientFile(addonId: string, rel: string): string | null {
  const root = path.resolve(ADDONS_ROOT(), addonId);
  const full = path.resolve(root, rel);
  const inside = path.relative(root, full);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return full;
}


function transpileFile(addonId: string, absFile: string, source: string, isTsx: boolean): string {
  const rewritten = rewriteImports(stripCssImports(source), (spec) => {
    if (SHIM_IMPORTS[spec]) return SHIM_IMPORTS[spec];
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const base = spec.replace(/^\.\//, '').replace(/\.(tsx|ts)$/, '');
      const hasCodeExt = /\.(tsx|ts)$/.test(spec);
      const ext = hasCodeExt ? '' : guessExt(path.resolve(path.dirname(absFile), spec));
      return `./${base}${ext}`;
    }
    return spec;
  });

  const out = ts.transpileModule(rewritten, {
    fileName: absFile,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const output = rewriteImports(out.outputText, (spec) => SHIM_IMPORTS[spec] ?? spec);
  void addonId;
  void isTsx;
  return output;
}

function guessExt(absNoExt: string): string {
  for (const ext of ['.tsx', '.ts', '.js', '.jsx']) {
    if (existsSync(absNoExt + ext)) return ext === '.js' || ext === '.jsx' ? '.js' : '';
  }
  return '';
}


function stripCssImports(source: string): string {
  return source.replace(
    /(^|[\n;])\s*import\s+(['"])([^'"]+\.css)\2\s*;?/g,
    (_m, pre: string, quote: string, spec: string) =>
      `${pre}{const __l=document.createElement('link');__l.rel='stylesheet';` +
      `__l.href=new URL(${quote}${spec}${quote},import.meta.url).href;` +
      `if(!document.querySelector('link[href="'+__l.href+'"]'))document.head.appendChild(__l);}`,
  );
}


function rewriteImports(source: string, map: (spec: string) => string): string {
  return source.replace(
    /(\bimport\s+(?:[\s\S]*?\sfrom\s+)?|\bexport\s+(?:\*|\{[\s\S]*?\})\s*from\s+|\bimport\s*\()\s*(['"])([^'"]+)\2/g,
    (_whole, head: string, quote: string, spec: string) => {
      return `${head}${quote}${map(spec)}${quote}`;
    },
  );
}


const BUNDLE_SCHEME = 'r2';


export function serveClientModule(addonId: string, relWithQuery: string): { js: string; etag: string } | { error: string; status: number } {
  const rel = clientRelFor(relWithQuery.split('?')[0].replace(/\.js$/, ''));
  const abs = resolveClientFile(addonId, rel + guessFileExt(addonId, rel));
  if (!abs || !existsSync(abs)) {
    return { error: `Module "${rel}" not found in addon "${addonId}"`, status: 404 };
  }
  const mtime = statSync(abs).mtimeMs;
  const etag = `"${BUNDLE_SCHEME}-${Math.round(mtime)}"`;
  const key = `${addonId}/${rel}`;
  const cached = cache.get(key);
  if (cached && cached.mtime === mtime) return { js: cached.js, etag: cached.etag };

  const source = readFileSync(abs, 'utf-8');
  const isTsx = abs.endsWith('.tsx');
  const js = transpileFile(addonId, abs, source, isTsx);
  cache.set(key, { js, mtime, etag });
  return { js, etag };
}


function clientRelFor(viewKey: string): string {
  let rel = viewKey.replace(/^\.\//, '').replace(/\.tsx?$/, '');
  if (!rel.startsWith('client/') && !rel.startsWith('../')) rel = `client/${rel}`;
  return rel;
}
function guessFileExt(addonId: string, rel: string): string {
  const base = resolveClientFile(addonId, rel);
  if (base === null) return '.tsx';
  for (const ext of ['.tsx', '.ts', '.js', '.jsx']) {
    if (existsSync(base + ext)) return ext;
  }
  return '.tsx';
}


const ASSET_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};


export function serveClientAsset(addonId: string, relWithQuery: string): { data: Buffer; etag: string; mime: string } | { error: string; status: number } {
  const rel = relWithQuery.split('?')[0];
  const ext = path.extname(rel).toLowerCase();
  const mime = ASSET_TYPES[ext];
  if (!mime) return { error: `Unsupported asset type "${ext}"`, status: 404 };
  const abs = resolveClientFile(addonId, rel);
  if (!abs || !existsSync(abs)) return { error: `Asset "${rel}" not found`, status: 404 };
  const mtime = statSync(abs).mtimeMs;
  return { data: readFileSync(abs), etag: `"a${Math.round(mtime)}"`, mime };
}
