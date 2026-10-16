/**
 * RS-PRD v1 model + validation (RSA/T R1). Self-contained: runs inside the
 * harness process via tsx with NO imports from server/ — the addon contract.
 */

export const FORMAT_ID = 'rs-prd';
export const FORMAT_VERSION = 1;
export const MAX_HISTORY = 500;

/** Actor = who did it. `user` is the ONLY kind allowed to delete. */
export function actor(kind, name, extra) {
  return { kind, name: name || undefined, ...(extra || {}) };
}

export const STATES = ['locked', 'available', 'claimed', 'in_progress', 'review', 'done', 'blocked', 'dropped'];
export const TIERS = ['bronze', 'silver', 'gold', 'diamond'];
export const TIER_POINTS = { bronze: 10, silver: 20, gold: 40, diamond: 80 };
export const KINDS = ['feature', 'bugfix', 'refactor', 'chore', 'research', 'test'];

export function newPrdDoc(user) {
  return {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    rev: 0,
    prd: {
      id: 'prd_' + Math.random().toString(36).slice(2, 7),
      title: '',
      summary: '',
      status: 'draft',
      createdAt: new Date().toISOString(),
      createdBy: user,
      language: 'en',
      goals: [],
      nonGoals: [],
      constraints: [],
      globalScope: { include: ['src/**'], exclude: ['**/*.env', '.data/**'] },
      architecture: '',
      modules: [],
      milestones: [],
      nonFunctional: [],
      risks: [],
      technicalDecisions: [],
    },
    achievements: [],
    history: [],
  };
}

/** Validate the document shape; returns a list of readable problems. */
export function validateDoc(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['document is not an object'];
  if (doc.format !== FORMAT_ID) problems.push(`format: expected "${FORMAT_ID}"`);
  if (typeof doc.version !== 'number' || doc.version > FORMAT_VERSION) problems.push('version: newer than supported (read-only mode)');
  if (!doc.prd || typeof doc.prd !== 'object') problems.push('prd: missing');
  else {
    if (typeof doc.prd.id !== 'string' || !doc.prd.id) problems.push('prd.id: missing');
    if (typeof doc.prd.title !== 'string') problems.push('prd.title: must be a string');
    if (!['draft', 'running', 'paused', 'done', 'archived'].includes(doc.prd.status)) problems.push('prd.status: invalid');
    if (!doc.prd.createdBy || !['user', 'agent', 'operator', 'system'].includes(doc.prd.createdBy.kind)) problems.push('prd.createdBy: invalid actor');
  }
  if (!Array.isArray(doc.achievements)) problems.push('achievements: not an array');
  else {
    const seen = new Set();
    for (const a of doc.achievements) {
      if (!a.id || seen.has(a.id)) problems.push(`achievement id "${a.id}": missing/duplicate`);
      seen.add(a.id);
      if (!STATES.includes(a.state)) problems.push(`${a.id}: invalid state "${a.state}"`);
      if (a.tier && !TIERS.includes(a.tier)) problems.push(`${a.id}: invalid tier`);
      if (!Array.isArray(a.acceptance)) problems.push(`${a.id}: acceptance must be an array`);
      if (a.scope && (a.scope.include && !Array.isArray(a.scope.include))) problems.push(`${a.id}: scope.include must be an array`);
      if (a.scope && (a.scope.exclude && !Array.isArray(a.scope.exclude))) problems.push(`${a.id}: scope.exclude must be an array`);
      if (a.contracts !== undefined) {
        if (!a.contracts || typeof a.contracts !== 'object') {
          problems.push(`${a.id}: contracts must be an object`);
        } else {
          if (a.contracts.provides !== undefined && !Array.isArray(a.contracts.provides)) {
            problems.push(`${a.id}: contracts.provides must be an array of strings`);
          }
          if (a.contracts.consumes !== undefined && !Array.isArray(a.contracts.consumes)) {
            problems.push(`${a.id}: contracts.consumes must be an array of strings`);
          }
        }
      }
      if (a.claim && !['user', 'agent', 'operator', 'system'].includes(a.claim.by?.kind)) problems.push(`${a.id}: claim.by invalid`);
      for (const dep of a.dependsOn || []) {
        if (!doc.achievements.some((x) => x.id === dep)) problems.push(`${a.id}: dependsOn "${dep}" not found`);
      }
    }
  }
  return problems;
}

/** Migrate an older doc forward. v1 is the first version — future-proof hook. */
export function migrate(doc) {
  if (doc.version === 1) return doc;
  return doc;
}

/** Normalize a raw "module" line (string or {name, desc}).
 *  Architecture modules divide the PRD into self-contained parts whose
 *  achievements can be worked in parallel by different agents without
 *  colliding. Each achievement may point at its module via `moduleId`. */
export function normModules(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 60).map((m, idx) => {
    const o = typeof m === 'string' ? { name: m } : m || {};
    const id = String(o.id ?? `m${String(1 + (o.no ?? idx)).padStart(2, '0')}`);
    const allowed = Array.isArray(o.allowedImports)
      ? o.allowedImports.map((x) => String(x)).slice(0, 30)
      : undefined;
    return {
      id,
      name: String(o.name ?? '').slice(0, 120),
      desc: String(o.desc ?? '').slice(0, 500),
      layer: o.layer ? String(o.layer).slice(0, 40) : undefined,
      allowedImports: allowed,
      scope: { include: (o.scope?.include || []).slice(0, 20), exclude: (o.scope?.exclude || []).slice(0, 20) },
    };
  }).filter((m) => m.name);
}

/** Normalize achievement symbol contracts ({ provides: string[], consumes: string[] }). */
export function normContracts(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const provides = Array.isArray(raw.provides) ? raw.provides.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : [];
  const consumes = Array.isArray(raw.consumes) ? raw.consumes.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : [];
  return { provides, consumes };
}

/** Normalize a milestone line (string or {title, goal, target}).
 *  Milestones are delivery checkpoints used by the orchestrator to sequence
 *  large architectural work — an achievement can `dependsOn` a milestone id
 *  the same way it depends on another achievement. */
export function normMilestones(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 30).map((m) => {
    const o = typeof m === 'string' ? { title: m } : m || {};
    return {
      id: String(o.id ?? `M${String(1 + (o.no ?? 0)).padStart(2, '0')}`),
      title: String(o.title ?? '').slice(0, 140),
      goal: String(o.goal ?? '').slice(0, 500),
    };
  }).filter((m) => m.title);
}

/** Non-functional requirements: measurable cross-cutting qualities. */
export function normNonFunctional(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 40).map((n, idx) => {
    const o = typeof n === 'string' ? { text: n } : n || {};
    return {
      id: String(o.id ?? `nf${String(idx + 1).padStart(2, '0')}`),
      text: String(o.text ?? '').slice(0, 300),
      metric: String(o.metric ?? '').slice(0, 200),
    };
  }).filter((n) => n.text);
}

/** Risks with likelihood/impact so the orchestrator can plan mitigation. */
export function normRisks(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 40).map((r, idx) => {
    const o = typeof r === 'string' ? { text: r } : r || {};
    return {
      id: String(o.id ?? `r${String(idx + 1).padStart(2, '0')}`),
      text: String(o.text ?? '').slice(0, 500),
      mitigation: String(o.mitigation ?? '').slice(0, 300),
      severity: ['low', 'medium', 'high'].includes(o.severity) ? o.severity : 'medium',
    };
  }).filter((r) => r.text);
}

/** Normalize technical decisions (string or {text, reason}). */
export function normTechnicalDecisions(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 30).map((td) => {
    const o = typeof td === 'string' ? { text: td } : td || {};
    return {
      text: String(o.text ?? '').slice(0, 500),
      reason: String(o.reason ?? '').slice(0, 300),
      at: o.at ? String(o.at) : new Date().toISOString(),
    };
  }).filter((td) => td.text);
}

/** Minimal glob → RegExp (no deps): **, *, segment-boundaries only. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i += 2; if (glob[i] === '/') i += 1; out += '.*'; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Does `path` match the scope (include minus exclude)? */
export function inScope(scope, relPath) {
  if (!scope) return true;
  const inc = (scope.include || []).map(globToRegExp);
  const exc = (scope.exclude || []).map(globToRegExp);
  if (inc.length > 0 && !inc.some((re) => re.test(relPath))) return false;
  return !exc.some((re) => re.test(relPath));
}

/** Compute derived state hints: which achievements are unlocked now. */
export function unlocked(doc, achievement) {
  return (achievement.dependsOn || []).every((dep) => {
    const target = doc.achievements.find((a) => a.id === dep);
    return !target || target.state === 'done' || target.state === 'dropped';
  });
}

export function score(doc) {
  return doc.achievements
    .filter((a) => a.state === 'done')
    .reduce((sum, a) => sum + (a.points ?? TIER_POINTS[a.tier] ?? 10), 0);
}

export function maxScore(doc) {
  return doc.achievements.reduce((sum, a) => sum + (a.points ?? TIER_POINTS[a.tier] ?? 10), 0);
}
