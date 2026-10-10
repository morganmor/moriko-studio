/**
 * F1.2 — Shared TypeScript LanguageService factory (per closest tsconfig),
 * reused by lsp_symbols (lsp.ts), read_symbol / context_pack / diagnostics /
 * refactor (F2/F3).
 *
 * Fixes B2: script versions keyed by mtime so edits invalidate snapshots,
 * compilation settings read from the project's own tsconfig when present.
 */
import * as ts from 'typescript';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

interface ServiceEntry {
  service: ts.LanguageService;
  files: Set<string>;
}

/** LRU of at most 2 services (bounded RAM, see plan §10). */
const services: Array<{ root: string; entry: ServiceEntry }> = [];
const MAX_SERVICES = 2;

function tsconfigFor(absFile: string): { dir: string; file: string } | null {
  try {
    const found = ts.findConfigFile(path.dirname(absFile), ts.sys.fileExists, 'tsconfig.json');
    return found ? { dir: path.dirname(found), file: found } : null;
  } catch {
    return null;
  }
}

function compilationSettings(absFile: string): ts.CompilerOptions {
  const cfg = tsconfigFor(absFile);
  if (cfg) {
    try {
      const raw = ts.readConfigFile(cfg.file, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, cfg.dir);
      return { ...parsed.options, noEmit: true };
    } catch {
      // fall through to defaults
    }
  }
  return {
    allowJs: true,
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
  };
}

function collectScriptFiles(dir: string, limit = 4000): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', '.data', '.moriko', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.attachments', '.pnpm-store']);
  const walk = (d: string, depth: number): void => {
    if (depth > 12 || out.length >= limit) return;
    let entries: import('node:fs').Dirent[];
    try { entries = require('node:fs').readdirSync(d, { withFileTypes: true }) as import('node:fs').Dirent[]; } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(path.join(d, e.name), depth + 1);
      } else if (e.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
        out.push(path.join(d, e.name));
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** LanguageService scoped to the tsconfig nearest `absFile` (root = workspace). */
export function getLanguageService(absFile: string, root: string): ts.LanguageService & { __files?: Set<string> } {
  const cfg = tsconfigFor(absFile);
  const scopeDir = cfg ? cfg.dir : root;
  const existing = services.find((s) => s.root === scopeDir);
  if (existing) return existing.entry.service;

  const files = new Set(collectScriptFiles(scopeDir));
  if (!files.has(path.normalize(absFile))) files.add(path.normalize(absFile));

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files],
    getScriptVersion: (fileName: string) => {
      try {
        return String(statSync(fileName).mtimeMs);
      } catch {
        return '0';
      }
    },
    getScriptSnapshot: (fileName: string) => {
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => scopeDir,
    getCompilationSettings: () => compilationSettings(absFile),
    getDefaultLibFileName: (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName: string) => {
      try { return existsSync(fileName); } catch { return false; }
    },
    readFile: (fileName: string) => {
      try { return readFileSync(fileName, 'utf8'); } catch { return undefined; }
    },
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry()) as ts.LanguageService & { __files?: Set<string> };
  service.__files = files;

  services.unshift({ root: scopeDir, entry: { service, files } });
  while (services.length > MAX_SERVICES) services.pop();
  return service;
}

/** Drop the service cached for the scope containing absFile (cheap invalidation). */
export function invalidateFile(absFile: string, root: string): void {
  const cfg = tsconfigFor(absFile);
  const scopeDir = cfg ? cfg.dir : root;
  const idx = services.findIndex((s) => s.root === scopeDir);
  if (idx >= 0) services.splice(idx, 1);
}
