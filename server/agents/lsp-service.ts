/**
 * F1.2 — Shared TypeScript LanguageService factory (per closest tsconfig),
 * reused by lsp_symbols (lsp.ts), read_symbol / context_pack / diagnostics /
 * refactor (F2/F3).
 *
 * Fixes:
 *  - B2: script versions keyed by mtime so edits invalidate snapshots.
 *  - Solution tsconfig: a root `tsconfig.json` that only lists `references`
 *    (with `files: []` and no `compilerOptions`) parses to EMPTY options and
 *    no root files — the old code fed that to the LanguageService, so the
 *    program had no jsx/module/lib settings and no members, and every consumer
 *    failed with "Could not find source file". The closest REFERENCED project
 *    that actually contains the file is used instead (tsconfig.app.json for
 *    src/, tsconfig.node.json for server/), so diagnostics see real settings.
 *  - ESM: the directory walk uses the imported `readdirSync` (no `require()`).
 */
import * as ts from 'typescript';
import { readFileSync, existsSync, statSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

interface ServiceEntry {
  service: ts.LanguageService;
  files: Set<string>;
}

/** LRU of at most 3 services (bounded RAM, see plan §10). */
const services: Array<{ root: string; entry: ServiceEntry }> = [];
const MAX_SERVICES = 3;

interface ResolvedProject {
  /** Unique cache key: the tsconfig file path, or the workspace root when none. */
  key: string;
  /** Working directory the LanguageService host uses (current dir). */
  dir: string;
  /** Parsed compile options. */
  options: ts.CompilerOptions;
  /** Authoritative root files from the tsconfig include; null = walk fallback. */
  rootFiles: string[] | null;
}

/** Empty (undefined/null/[]/{}) — used to tell a solution config from a real one. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** True when a tsconfig is a solution file: references only, no code settings. */
function isSolutionConfig(config: Record<string, unknown>): boolean {
  return (
    Array.isArray(config.references) &&
    config.references.length > 0 &&
    isEmpty(config.compilerOptions) &&
    isEmpty(config.files) &&
    isEmpty(config.include) &&
    isEmpty(config.exclude)
  );
}

/** Sensible defaults used when no tsconfig (or no project) is found. */
function fallbackCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
  };
}

/** Resolve the project that owns `absFile`: a real tsconfig, or a safe fallback. */
function projectFor(absFile: string, root: string): ResolvedProject {
  const fallback = (): ResolvedProject => ({
    key: root,
    dir: root,
    options: fallbackCompilerOptions(),
    rootFiles: null,
  });

  let found: string | undefined;
  try {
    found = ts.findConfigFile(path.dirname(absFile), ts.sys.fileExists, 'tsconfig.json');
  } catch {
    return fallback();
  }
  if (!found) return fallback();

  try {
    const raw = ts.readConfigFile(found, ts.sys.readFile);
    const cfg = (raw.config ?? {}) as Record<string, unknown>;

    const toAbs = (baseDir: string, f: string): string =>
      path.isAbsolute(f) ? path.normalize(f) : path.resolve(baseDir, f);

    if (isSolutionConfig(cfg)) {
      const target = path.resolve(absFile);
      for (const ref of cfg.references as Array<{ path?: string }>) {
        if (typeof ref?.path !== 'string') continue;
        const refFile = path.join(path.dirname(found), ref.path);
        if (!ts.sys.fileExists(refFile)) continue;
        const refDir = path.dirname(refFile);
        const parsed = ts.parseJsonConfigFileContent(
          ts.readConfigFile(refFile, ts.sys.readFile).config ?? {}, ts.sys, refDir,
        );
        const members = parsed.fileNames.map((f) => toAbs(refDir, f));
        if (members.some((f) => f === target)) {
          return {
            key: refFile,
            dir: refDir,
            options: { ...parsed.options, noEmit: true },
            rootFiles: members,
          };
        }
      }
      return fallback();
    }

    const dir = path.dirname(found);
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(found, ts.sys.readFile).config ?? {}, ts.sys, dir,
    );
    return {
      key: found,
      dir,
      options: { ...parsed.options, noEmit: true },
      rootFiles: parsed.fileNames.map((f) => toAbs(dir, f)),
    };
  } catch {
    return fallback();
  }
}

function collectScriptFiles(dir: string, limit = 4000): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', '.data', '.moriko', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.attachments', '.pnpm-store']);
  const walk = (d: string, depth: number): void => {
    if (depth > 12 || out.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
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
  const project = projectFor(absFile, root);
  const existing = services.find((s) => s.root === project.key);
  if (existing) {
    existing.entry.files.add(path.normalize(absFile));
    return existing.entry.service;
  }

  const files = new Set(project.rootFiles ?? collectScriptFiles(project.dir));
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
    getCurrentDirectory: () => project.dir,
    getCompilationSettings: () => project.options,
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

  services.unshift({ root: project.key, entry: { service, files } });
  while (services.length > MAX_SERVICES) services.pop();
  return service;
}

/** Drop the service cached for the project containing absFile (cheap invalidation). */
export function invalidateFile(absFile: string, root: string): void {
  const project = projectFor(absFile, root);
  const idx = services.findIndex((s) => s.root === project.key);
  if (idx >= 0) services.splice(idx, 1);
}