/**
 * Addon v2 dependency graph (A2) — topological activation order + semver-lite
 * range checks + conflict detection. Cycles and version mismatches mark the
 * addon Blocked with a reason ( surfaced in the Hub), never crash the host.
 */

export interface GraphNode {
  id: string;
  version: string;
  dependencies: Record<string, string>;
  conflicts: string[];
}

export interface GraphResult {
  /** Activation order (dependencies first). Addons with problems are omitted. */
  order: string[];
  /** id → reason it cannot activate. */
  blocked: Record<string, string>;
}

/** Compare two semvers: -1 | 0 | 1. Tolerates pre-release tails (ignored). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Minimal range check: ^, ~, >=, =, exact. Returns false for garbage. */
export function rangeSatisfies(range: string, version: string): boolean {
  const r = range.trim();
  if (r === '*' || r === '') return true;
  const m = /^([\^~>=]*)\s*(\d+\.\d+\.\d+)/.exec(r);
  if (!m) return r === version;
  const [, op, base] = m;
  const c = cmpVersion(version, base);
  if (op === '^') return c >= 0 && cmpVersion(version, majorBump(base)) < 0;
  if (op === '~') return c >= 0 && cmpVersion(version, minorBump(base)) < 0;
  if (op === '>=') return c >= 0;
  return c === 0;
}

function majorBump(v: string): string {
  const [a] = v.split('.');
  return `${Number.parseInt(a, 10) + 1}.0.0`;
}

function minorBump(v: string): string {
  const [a, b] = v.split('.');
  return `${a}.${Number.parseInt(b, 10) + 1}.0`;
}

/** Resolve activation order for the given addon set. `moriko-core` is the
 *  harness API itself — its version is supplied by the caller. */
export function resolveGraph(nodes: GraphNode[], coreVersion = '2.0.0'): GraphResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const blocked: Record<string, string> = {};

  for (const node of nodes) {
    for (const conflict of node.conflicts) {
      if (byId.has(conflict)) {
        blocked[node.id] = `Conflicts with installed addon "${conflict}"`;
      }
    }
    if (blocked[conflictKey(nodes, node.id)]) {
    }
  }
  for (const node of nodes) {
    for (const other of nodes) {
      if (other.id !== node.id && other.conflicts.includes(node.id)) {
        blocked[node.id] = `"${other.id}" declares a conflict with "${node.id}"`;
      }
    }
  }

  for (const node of nodes) {
    for (const [dep, range] of Object.entries(node.dependencies)) {
      if (dep === 'moriko-core') {
        if (!rangeSatisfies(range, coreVersion)) {
          blocked[node.id] = `Requires harness API ${range} (installed ${coreVersion})`;
        }
        continue;
      }
      const target = byId.get(dep);
      if (!target) {
        blocked[node.id] = `Dependency "${dep}" is not installed`;
        continue;
      }
      if (!rangeSatisfies(range, target.version)) {
        blocked[node.id] = `Dependency "${dep}" ${range} not satisfied (installed ${target.version})`;
      }
      if (blocked[target.id] && !blocked[node.id]) {
        blocked[node.id] = `Dependency "${dep}" is blocked: ${blocked[target.id]}`;
      }
    }
  }

  const installable = nodes.filter((n) => !blocked[n.id]);
  const inDeg = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const n of installable) {
    inDeg.set(n.id, 0);
    edges.set(n.id, []);
  }
  for (const n of installable) {
    for (const dep of Object.keys(n.dependencies)) {
      if (dep === 'moriko-core' || !inDeg.has(dep)) continue;
      edges.get(dep)!.push(n.id);
      inDeg.set(n.id, (inDeg.get(n.id) ?? 0) + 1);
    }
  }
  const queue = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of edges.get(id) ?? []) {
      const d = (inDeg.get(next) ?? 1) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  for (const n of installable) {
    if (!order.includes(n.id)) blocked[n.id] = 'Dependency cycle detected';
  }
  order.sort((a, b) => a.localeCompare(b));
  return { order, blocked };
}

function conflictKey(nodes: GraphNode[], id: string): string {
  return nodes.find((n) => n.conflicts.includes(id))?.id ?? '';
}
