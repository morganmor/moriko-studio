
import { readFileSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { SKIP_DIRS, requireWorkspace, resolveManyWithPermission } from './shared.js';
import { defineTool } from './registry.js';
import { fuzzyHint } from '../fuzzy.js';


const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);


const INTERLINKED_SKIP_DIRS = new Set<string>([...SKIP_DIRS, '.chuze']);


const NODE_BUILTINS = new Set<string>(builtinModules);


const EXT_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx', '.ts', '.js'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};


const RESOLVE_SUFFIXES = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.mts', '/index.cts',
  '/index.js', '/index.jsx', '/index.mjs', '/index.cjs',
];

const TSCONFIG_NAME = /^tsconfig(\..+)?\.json$/i;


const TS_NO_INPUTS_CODE = 18003;

type ModuleKind = 'local' | 'external' | 'unresolved';

interface ModuleRef {
  
  key: string;
  kind: ModuleKind;
  
  label: string;
}

interface IndexedFile {
  absolute: string;
  
  id: string;
  
  relative: string;
  modules: Map<string, ModuleRef>;
}

interface AliasRule {
  
  prefix: string;
  
  suffix: string;
  wildcard: boolean;
  
  targets: string[];
}

interface AliasConfig {
  dir: string;
  rules: AliasRule[];
}

interface WorkspaceIndex {
  root: string;
  rootReal: string;
  files: IndexedFile[];
  byId: Map<string, IndexedFile>;
  aliasConfigs: AliasConfig[];
  notes: string[];
}

interface TargetMatch {
  file: IndexedFile;
  shared: number;
}

type TargetOutcome =
  | { raw: string; ok: true; matches: TargetMatch[]; moduleCount: number }
  | { raw: string; ok: false; error: string };


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}


function statOrNull(absolute: string): Stats | null {
  try {
    return statSync(absolute);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function isFile(absolute: string): boolean {
  const stats = statOrNull(absolute);
  return stats !== null && stats.isFile();
}

function fileId(absolute: string): string {
  const resolved = path.resolve(absolute);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}


function displayPath(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return toPosix(absolute);
  return toPosix(rel);
}

function isAncestorDir(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}


function walkWorkspace(root: string, notes: string[]): { sources: string[]; tsconfigs: string[] } {
  const sources: string[] = [];
  const tsconfigs: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      notes.push(`Directory "${displayPath(root, dir)}" could not be read: ${errorMessage(error)}`);
      continue;
    }
    entries.sort((a, b) => compareText(a.name, b.name));
    const childDirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!INTERLINKED_SKIP_DIRS.has(entry.name)) childDirs.push(full);
      } else if (entry.isFile()) {
        if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) sources.push(full);
        else if (TSCONFIG_NAME.test(entry.name)) tsconfigs.push(full);
      }
    }
    for (let i = childDirs.length - 1; i >= 0; i -= 1) stack.push(childDirs[i]);
  }
  sources.sort((a, b) => compareText(a, b));
  return { sources, tsconfigs };
}


function loadAliasConfig(root: string, configPath: string, notes: string[]): AliasConfig | null {
  const label = displayPath(root, configPath);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    notes.push(`tsconfig "${label}" could not be parsed: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`);
    return null;
  }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  const configDir = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(read.config, host, configDir, undefined, configPath);
  for (const diagnostic of parsed.errors) {
    if (diagnostic.code === TS_NO_INPUTS_CODE) continue;
    notes.push(`tsconfig "${label}": ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  const paths = parsed.options.paths;
  if (!paths) return null;
  const base = parsed.options.baseUrl ? path.resolve(configDir, parsed.options.baseUrl) : configDir;
  const rules: AliasRule[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    rules.push({
      prefix: star === -1 ? pattern : pattern.slice(0, star),
      suffix: star === -1 ? '' : pattern.slice(star + 1),
      wildcard: star !== -1,
      targets: targets.map((target) => path.resolve(base, target)),
    });
  }
  return rules.length > 0 ? { dir: configDir, rules } : null;
}



function resolveCandidate(base: string): string | null {
  const ext = path.extname(base).toLowerCase();
  const swaps = EXT_SWAPS[ext];
  if (swaps) {
    const stem = base.slice(0, base.length - ext.length);
    for (const swap of swaps) {
      if (isFile(`${stem}${swap}`)) return `${stem}${swap}`;
    }
  }
  if (isFile(base)) return base;
  for (const suffix of RESOLVE_SUFFIXES) {
    if (isFile(`${base}${suffix}`)) return `${base}${suffix}`;
  }
  return null;
}

function resolveAlias(spec: string, fromFile: string, index: WorkspaceIndex): string | null {
  const configs = index.aliasConfigs
    .filter((config) => isAncestorDir(config.dir, fromFile))
    .sort((a, b) => b.dir.length - a.dir.length);
  for (const config of configs) {
    for (const rule of config.rules) {
      let rest: string;
      if (rule.wildcard) {
        if (!spec.startsWith(rule.prefix) || !spec.endsWith(rule.suffix)) continue;
        if (spec.length < rule.prefix.length + rule.suffix.length) continue;
        rest = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
      } else {
        if (spec !== rule.prefix) continue;
        rest = '';
      }
      for (const target of rule.targets) {
        const found = resolveCandidate(target.replace('*', rest));
        if (found) return found;
      }
    }
  }
  return null;
}

function localRef(found: string, index: WorkspaceIndex): ModuleRef {
  const real = realpathSync.native(found);
  const label = displayPath(index.rootReal, real);
  return { key: `local:${label}`, kind: 'local', label };
}

function unresolvedRef(base: string, index: WorkspaceIndex): ModuleRef {
  const label = displayPath(index.root, path.resolve(base));
  return { key: `unresolved:${label}`, kind: 'unresolved', label: `${label} (unresolved)` };
}

function externalRef(spec: string): ModuleRef {
  return { key: `pkg:${spec}`, kind: 'external', label: spec };
}

function resolveModule(rawSpec: string, fromFile: string, index: WorkspaceIndex): ModuleRef {
  const spec = rawSpec.trim();
  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const found = resolveCandidate(base);
    return found ? localRef(found, index) : unresolvedRef(base, index);
  }
  if (spec.startsWith('node:')) return externalRef(spec);
  if (NODE_BUILTINS.has(spec)) return externalRef(`node:${spec}`);
  if (path.isAbsolute(spec)) {
    const found = resolveCandidate(spec);
    if (found) return localRef(found, index);
  }
  const aliased = resolveAlias(spec, fromFile, index);
  if (aliased) return localRef(aliased, index);
  return externalRef(spec);
}


function scriptKindFor(absolute: string): ts.ScriptKind {
  switch (path.extname(absolute).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}


function extractSpecifiers(source: string, absolute: string): string[] {
  const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, false, scriptKindFor(absolute));
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
        out.push(node.moduleReference.expression.text);
      }
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) out.push(first.text);
        else if (ts.isIdentifier(callee) && callee.text === 'require') out.push(first.text);
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) out.push(argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out.filter((spec) => spec.trim().length > 0);
}

function indexFile(absolute: string, index: WorkspaceIndex): IndexedFile {
  const source = readFileSync(absolute, 'utf8');
  const modules = new Map<string, ModuleRef>();
  for (const spec of extractSpecifiers(source, absolute)) {
    const ref = resolveModule(spec, absolute, index);
    if (!modules.has(ref.key)) modules.set(ref.key, ref);
  }
  return { absolute, id: fileId(absolute), relative: displayPath(index.root, absolute), modules };
}


function buildIndex(root: string): WorkspaceIndex {
  const notes: string[] = [];
  const rootReal = realpathSync.native(root);
  const { sources, tsconfigs } = walkWorkspace(root, notes);
  const aliasConfigs: AliasConfig[] = [];
  for (const configPath of tsconfigs) {
    const config = loadAliasConfig(root, configPath, notes);
    if (config) aliasConfigs.push(config);
  }
  const index: WorkspaceIndex = { root, rootReal, files: [], byId: new Map(), aliasConfigs, notes };
  for (const absolute of sources) {
    try {
      const file = indexFile(absolute, index);
      index.files.push(file);
      index.byId.set(file.id, file);
    } catch (error) {
      notes.push(`"${displayPath(root, absolute)}" could not be analysed: ${errorMessage(error)}`);
    }
  }
  return index;
}



function collectTargets(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  const single = args.target;
  if (single !== undefined && single !== null) {
    if (typeof single !== 'string') {
      throw new Error(`interlinked: "target" must be a string file subpath (got ${typeof single}).`);
    }
    add(single);
  }
  const many = args.targets;
  if (many !== undefined && many !== null) {
    if (!Array.isArray(many)) {
      throw new Error(`interlinked: "targets" must be an array of string file subpaths (got ${typeof many}).`);
    }
    many.forEach((entry: unknown, position: number) => {
      if (typeof entry !== 'string') {
        throw new Error(`interlinked: "targets[${position}]" must be a string file subpath (got ${typeof entry}).`);
      }
      add(entry);
    });
  }
  return out;
}


function evaluateTarget(raw: string, absolute: string, index: WorkspaceIndex): TargetOutcome {
  const stats = statOrNull(absolute);
  if (!stats) {
    return { raw, ok: false, error: `Target not found: "${raw}" — no file exists at ${absolute}.${fuzzyHint(absolute)}` };
  }
  if (!stats.isFile()) {
    return { raw, ok: false, error: `Target "${raw}" is not a file (${absolute} is a directory or special entry).` };
  }
  if (!SOURCE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    return {
      raw,
      ok: false,
      error: `Target "${raw}" is not a JS/TS source file — supported extensions: ${[...SOURCE_EXTENSIONS].join(', ')}.`,
    };
  }
  let target = index.byId.get(fileId(absolute));
  if (!target) {
    try {
      target = indexFile(absolute, index);
    } catch (error) {
      return { raw, ok: false, error: `Target "${raw}" could not be analysed: ${errorMessage(error)}` };
    }
  }
  const matches: TargetMatch[] = [];
  for (const file of index.files) {
    if (file.id === target.id) continue;
    let shared = 0;
    for (const key of target.modules.keys()) {
      if (file.modules.has(key)) shared += 1;
    }
    if (shared > 0) matches.push({ file, shared });
  }
  matches.sort((a, b) => b.shared - a.shared || compareText(a.file.relative, b.file.relative));
  return { raw, ok: true, matches, moduleCount: target.modules.size };
}


function renderTargetBlock(outcome: TargetOutcome): string {
  if (!outcome.ok) return `Error: ${outcome.error}`;
  const lines = [
    'This list of file have similliar import/module :',
    '',
    '| File Name | Location |',
    '| :--- | :--- |',
  ];
  for (const match of outcome.matches) {
    lines.push(`| ${escapeCell(path.basename(match.file.absolute))} | ${escapeCell(path.dirname(match.file.absolute))} |`);
  }
  if (outcome.matches.length === 0) {
    lines.push(
      '',
      outcome.moduleCount === 0
        ? '_The target declares no import/module, so no other file can share one._'
        : '_No other file in the workspace shares an import/module with this target._',
    );
  }
  return lines.join('\n');
}

function renderNotes(notes: string[]): string {
  if (notes.length === 0) return '';
  return `\n\n### Scan notes\n${notes.map((note) => `- ${note}`).join('\n')}`;
}

function renderWorkspaceMap(index: WorkspaceIndex): string {
  const files = [...index.files].sort((a, b) => compareText(a.relative, b.relative));
  const lines = [
    `Workspace import/module map — ${files.length} source file(s) scanned under ${index.root}.`,
    '',
    '### Files and their imports / modules',
    '',
    '| File Name | Location | Imports / Modules |',
    '| :--- | :--- | :--- |',
  ];
  for (const file of files) {
    const labels = [...file.modules.values()].map((ref) => ref.label).sort(compareText);
    const cell = labels.length > 0 ? labels.map((label) => `\`${label}\``).join(', ') : '(none)';
    lines.push(`| ${escapeCell(path.basename(file.absolute))} | ${escapeCell(path.dirname(file.absolute))} | ${escapeCell(cell)} |`);
  }

  const groups = new Map<string, { ref: ModuleRef; files: string[] }>();
  for (const file of files) {
    for (const ref of file.modules.values()) {
      const group = groups.get(ref.key);
      if (group) group.files.push(file.relative);
      else groups.set(ref.key, { ref, files: [file.relative] });
    }
  }
  const shared = [...groups.values()]
    .filter((group) => group.files.length >= 2)
    .sort((a, b) => b.files.length - a.files.length || compareText(a.ref.label, b.ref.label));

  lines.push('', '### Groups of files sharing the same import/module', '');
  if (shared.length === 0) {
    lines.push('_No import/module is shared by two or more files._');
  } else {
    lines.push('| Imports / Modules | Shared By | Files |', '| :--- | :--- | :--- |');
    for (const group of shared) {
      lines.push(
        `| ${escapeCell(`\`${group.ref.label}\``)} | ${group.files.length} | ${escapeCell(group.files.join(', '))} |`,
      );
    }
  }
  return lines.join('\n');
}


async function interlinkedTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const rawTargets = collectTargets(args);
  const { root } = requireWorkspace(ctx);

  if (rawTargets.length === 0) {
    const index = buildIndex(root);
    return { ok: true, isError: false, text: `${renderWorkspaceMap(index)}${renderNotes(index.notes)}` };
  }

  const resolved = await resolveManyWithPermission(
    'interlinked',
    rawTargets.map((value, position) => ({ key: String(position), value })),
    ctx,
    'read',
  );
  const targets: Array<{ raw: string; absolute: string }> = [];
  const seenIds = new Set<string>();
  rawTargets.forEach((raw, position) => {
    const entry = resolved[String(position)];
    if (!entry) throw new Error(`interlinked: target "${raw}" was not resolved by the permission gate.`);
    const id = fileId(entry.absolute);
    if (seenIds.has(id)) return;
    seenIds.add(id);
    targets.push({ raw, absolute: entry.absolute });
  });

  const index = buildIndex(root);
  const outcomes = targets.map((target) => evaluateTarget(target.raw, target.absolute, index));
  const allFailed = outcomes.every((outcome) => !outcome.ok);

  const body =
    outcomes.length === 1
      ? renderTargetBlock(outcomes[0])
      : outcomes.map((outcome) => `### Target: ${outcome.raw}\n${renderTargetBlock(outcome)}`).join('\n\n');
  const text = `${body}${renderNotes(index.notes)}`;

  if (allFailed) return { ok: false, isError: true, errorCode: 'target_not_found', text };
  return { ok: true, isError: false, text };
}

export const interlinkedSpec = defineTool({
  def: {
    wireName: 'agent__interlinked',
    description:
      'Cross-file module/import relationship mapper for architecture tasks and large codebases: with target/targets[], returns per-target tables of workspace files sharing ≥1 identical canonical module/import (most shared first); without target, returns the whole-workspace import map + shared-module groups. MANDATORY on architecture and large-codebase tasks — never skip out of overconfidence/arrogance, stubbornness, or shortcuts, and never become lazy with agent__grep or other precision tools just because interlinked exists.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'One target file subpath (workspace-relative or absolute).',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more target file subpaths analysed in one call (merged with "target", duplicates dropped).',
        },
      },
    },
  },
  handler: interlinkedTool,
  readOnly: true,
  category: 'nav',
});
