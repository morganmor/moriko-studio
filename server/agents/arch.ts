/**
 * F4.1/F4.2 — architecture analysis on top of the deps graph:
 * module-level aggregation (fan-in/out, instability), Tarjan SCC cycle
 * detection, and layer-rule checking against .moriko/architecture.json.
 */
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { queryDeps, invalidateDepsGraph } from './deps.js';
import { walkFiles } from './tools/list.js';

export interface ModuleNode {
  id: string;
  fanIn: number;
  fanOut: number;
  instability: number;
}

export interface ModuleEdge {
  from: string;
  to: string;
  weight: number;
}

export interface ArchReport {
  modules: ModuleNode[];
  edges: ModuleEdge[];
  /** Shortest cycle per SCC (file level). */
  cycles: string[][];
  filesScanned: number;
}

/** Module id = the folder `depth` levels deep containing the file. */
function moduleOf(relFile: string, depth: number, focus?: string): string {
  const parts = relFile.split('/');
  if (focus) {
    const focusParts = focus.split('/');
    const rel = relFile.startsWith(`${focus}/`) ? relFile.slice(focus.length + 1) : relFile;
    const relParts = rel.split('/');
    void parts; void focusParts;
    return relParts.slice(0, depth).join('/');
  }
  return parts.slice(0, depth).join('/');
}

/** Build the module-level graph from the file-level deps graph. */
export function buildArchMap(root: string, subpath: string, depth: number, focus?: string): ArchReport {
  invalidateDepsGraph(root);
  const files = walkFiles(subpath).files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)).slice(0, 2000);

  const edgeWeights = new Map<string, number>();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const fileImports = new Map<string, Set<string>>();
  const fileImportedBy = new Map<string, Set<string>>();

  for (const file of files) {
    const abs = path.join(root, file);
    const report = queryDeps(root, abs);
    if (!report) continue;
    fileImports.set(file, new Set(report.imports));
    fileImportedBy.set(file, new Set(report.importedBy));
    const fromMod = moduleOf(file, depth, focus);
    for (const imp of report.imports) {
      const toMod = moduleOf(imp, depth, focus);
      if (toMod === fromMod) continue;
      const key = `${fromMod}\u0000${toMod}`;
      edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
      fanOut.set(fromMod, (fanOut.get(fromMod) ?? 0) + 1);
      fanIn.set(toMod, (fanIn.get(toMod) ?? 0) + 1);
    }
  }

  const moduleIds = new Set<string>([...fanIn.keys(), ...fanOut.keys()]);
  const modules: ModuleNode[] = [...moduleIds].sort().map((id) => {
    const inN = fanIn.get(id) ?? 0;
    const outN = fanOut.get(id) ?? 0;
    return { id, fanIn: inN, fanOut: outN, instability: inN + outN === 0 ? 0 : outN / (inN + outN) };
  });
  const edges: ModuleEdge[] = [...edgeWeights.entries()]
    .map(([k, weight]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, weight };
    })
    .sort((a, b) => b.weight - a.weight);

  const cycles = tarjanCycles(files, fileImports);

  return { modules, edges, cycles, filesScanned: files.length };
}

/** Tarjan SCC; returns the shortest cycle found per SCC with >1 node. */
function tarjanCycles(files: string[], imports: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of imports.get(v) ?? []) {
      if (!files.includes(w)) continue;
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  };

  for (const f of files) {
    if (!index.has(f)) strongConnect(f);
  }

  const cycles: string[][] = [];
  for (const scc of sccs.slice(0, 20)) {
    const memberSet = new Set(scc);
    const start = scc[0];
    const queue: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];
    const visited = new Set<string>();
    let found: string[] | null = null;
    while (queue.length > 0 && !found) {
      const { node, path: p } = queue.shift()!;
      for (const next of imports.get(node) ?? []) {
        if (!memberSet.has(next)) continue;
        if (next === start) {
          if (p.length > 1) { found = [...p, start]; break; }
          continue;
        }
        const key = next;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ node: next, path: [...p, next] });
      }
    }
    cycles.push(found ?? scc);
  }
  return cycles;
}

export function renderMermaid(report: ArchReport, focus?: string): string {
  const prefix = focus ? `${focus}/` : '';
  const safe = (id: string): string => id.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines: string[] = ['graph LR'];
  for (const m of report.modules) {
    lines.push(`  ${safe(m.id)}["${prefix}${m.id}"]`);
  }
  for (const e of report.edges.slice(0, 120)) {
    lines.push(`  ${safe(e.from)} -->|${e.weight}| ${safe(e.to)}`);
  }
  return ['```mermaid', ...lines, '```'].join('\n');
}

export function renderText(report: ArchReport): string {
  const lines: string[] = [];
  lines.push(`modules (${report.modules.length}):`);
  for (const m of report.modules) {
    lines.push(`  ${m.id}  fan-in ${m.fanIn} · fan-out ${m.fanOut} · instability I=${m.instability.toFixed(2)}`);
  }
  lines.push('');
  lines.push(`edges (${report.edges.length}, top by weight):`);
  for (const e of report.edges.slice(0, 30)) {
    lines.push(`  ${e.from} → ${e.to}  (${e.weight} import(s))`);
  }
  lines.push('');
  lines.push(`cycles (${report.cycles.length}):`);
  if (report.cycles.length === 0) {
    lines.push('  (none — acyclic)');
  } else {
    for (const c of report.cycles.slice(0, 10)) {
      lines.push(`  ${c.join(' → ')}`);
    }
  }
  return lines.join('\n');
}


export interface ArchitectureRules {
  layers: Array<{ name: string; paths: string[] }>;
  allow?: Record<string, string[]>;
  forbid?: Array<{ from: string; to: string; reason?: string }>;
  maxFileLines?: number;
  noCycles?: boolean;
}

export function loadArchitectureRules(root: string): ArchitectureRules | null {
  const p = path.join(root, '.moriko', 'architecture.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ArchitectureRules;
  } catch {
    return null;
  }
}

export interface RuleViolation {
  kind: 'layer-edge' | 'forbid' | 'cycle' | 'file-size';
  detail: string;
}

/** Check the file-level deps graph against the layer rules. */
export function checkRules(root: string, rules: ArchitectureRules): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const layerOf = (rel: string): string | null => {
    for (const layer of rules.layers) {
      for (const pattern of layer.paths) {
        const re = globToRe(pattern);
        if (re.test(rel)) return layer.name;
      }
    }
    return null;
  };
  const { walkFiles } = require('./tools/list.js') as typeof import('./tools/list.js');
  const files = walkFiles(root).files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)).slice(0, 2000);
  const allow = rules.allow ?? {};

  for (const file of files) {
    const report = queryDeps(root, path.join(root, file));
    if (!report) continue;
    const fromLayer = layerOf(file);
    if (fromLayer) {
      for (const imp of report.imports) {
        const toLayer = layerOf(imp);
        if (!toLayer || toLayer === fromLayer) continue;
        const allowed = allow[fromLayer];
        if (allowed && !allowed.includes(toLayer)) {
          violations.push({ kind: 'layer-edge', detail: `${file} (${fromLayer}) imports ${imp} (${toLayer}) — ${fromLayer} allows only [${allowed.join(', ') || 'nothing'}]` });
        }
      }
    }
    for (const rule of rules.forbid ?? []) {
      const fromRe = globToRe(rule.from);
      const toRe = globToRe(rule.to);
      if (fromRe.test(file)) {
        for (const imp of report.imports) {
          if (toRe.test(imp)) {
            violations.push({ kind: 'forbid', detail: `${file} → ${imp}${rule.reason ? ` — ${rule.reason}` : ''}` });
          }
        }
      }
    }
    if (rules.maxFileLines) {
      try {
        const content = readFileSync(path.join(root, file), 'utf8');
        const loc = content.split('\n').length;
        if (loc > rules.maxFileLines) {
          violations.push({ kind: 'file-size', detail: `${file}: ${loc} lines > maxFileLines ${rules.maxFileLines}` });
        }
      } catch {  }
    }
  }

  if (rules.noCycles) {
    const arch = buildArchMap(root, root, 99);
    for (const cycle of arch.cycles) {
      violations.push({ kind: 'cycle', detail: cycle.join(' → ') });
    }
  }
  return violations;
}

function globToRe(pattern: string): RegExp {
  const esc = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${esc.replace(/\/$/, '')}(/.*)?$`);
}
