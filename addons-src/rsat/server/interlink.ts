/**
 * RSA/T Interlinked & Architectural Scanner Engine (R8).
 * Self-contained inside addons-src/rsat/server/ (NO imports from host server/).
 *
 * Scans the bound Moriko workspace in real time:
 *  - Discovers TS/TSX/JS/JSX source files across src/, server/, addons-src/
 *  - Parses exports (functions, classes, hooks, types, components) -> OUT sockets
 *  - Parses imports (value vs type-only, named symbols) -> IN sockets & glowing wires
 *  - Maps every file to PRD Architecture Modules (layer + allowedImports) and
 *    Achievement Quest claims/ledgers (active touch, cross-agent links)
 *  - Detects circular dependencies (Tarjan SCC) & cross-layer violations
 *  - Emits both the ComfyUI Node-Wire Graph payload AND the @RSLK v1 Agent DSL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { inScope } from './model.js';
import { workspaceOf, loadDoc, readAllLedgers, DIR } from './store.js';

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.data', '.moriko', '.turbo', 'vendor',
]);
const ADDONS_DIR = 'addons-src';

const POSITIONS_FILE = `${DIR}/interlink-positions.json`;
const MAX_SCAN_FILES = 600;
const MAX_CANVAS_NODES = 48;

/** Cache hasil scan per workspace root (TTL 4 detik agar responsif tapi hemat I/O). */
const graphCache = new Map();
const CACHE_TTL_MS = 4000;

export function invalidateInterlinkCache(root) {
  if (root) graphCache.delete(root);
  else graphCache.clear();
}

/** Baca posisi kustom node yang digeser user di kanvas Interlinked. */
export function loadNodePositions(ws) {
  try {
    if (!ws?.root() || !ws.exists(POSITIONS_FILE)) return {};
    const parsed = JSON.parse(ws.read(POSITIONS_FILE));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Simpan posisi node yang digeser user ke `.moriko/rsat/interlink-positions.json`. */
export async function saveNodePositions(api, sessionId, positions) {
  const ws = workspaceOf(api, sessionId);
  if (!ws?.root()) return { saved: false };
  const current = loadNodePositions(ws);
  const merged = { ...current };
  if (positions && typeof positions === 'object') {
    for (const [k, v] of Object.entries(positions)) {
      if (v && typeof v.x === 'number' && typeof v.y === 'number') {
        merged[k] = { x: Math.round(v.x), y: Math.round(v.y) };
      }
    }
  }
  if (!ws.exists('.moriko')) await ws.write(`${DIR}/.gitignore`, '*\n');
  await ws.write(POSITIONS_FILE, JSON.stringify(merged, null, 2));
  invalidateInterlinkCache(ws.root());
  return { saved: true, count: Object.keys(merged).length };
}

/** Walk direktori workspace secara deterministik. */
function walkWorkspaceFiles(rootDir, maxFiles = MAX_SCAN_FILES, includeAddons = false) {
  const out = [];
  function walk(absDir, relPrefix) {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      if (ent.name.startsWith('.') && ent.name !== '.moriko') continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (ent.name === ADDONS_DIR && !includeAddons) continue;
        walk(path.join(absDir, ent.name), rel);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (CODE_EXTS.has(ext) && !ent.name.endsWith('.d.ts')) {
          out.push(rel);
        }
      }
    }
  }
  walk(rootDir, '');
  return out;
}

/** Resolve relative specifier (`./store.js` -> `addons-src/rsat/server/store.ts`). */
function resolveImportTarget(fromFile, spec, fileSet) {
  if (!spec || !spec.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromFile);
  const baseJoined = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [baseJoined];
  const stripped = baseJoined.replace(/\.(m?js|jsx|ts|tsx)$/, '');
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
    candidates.push(stripped + ext);
  }
  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

/** Parse cepat & akurat untuk export dan import dari satu file sumber. */
export function parseFileAstLight(source) {
  const exportsList = [];
  const seenExp = new Set();
  const addExp = (label, kind) => {
    const clean = label.trim();
    if (!clean || seenExp.has(clean)) return;
    seenExp.add(clean);
    exportsList.push({ label: clean, kind });
  };

  if (/export\s+default\s+function\s+([A-Za-z0-9_$]+)/.test(source)) {
    const m = source.match(/export\s+default\s+function\s+([A-Za-z0-9_$]+)/);
    addExp(`default ${m[1]}()`, 'runtime');
  } else if (/export\s+default\s+/.test(source)) {
    addExp('default export', 'runtime');
  }

  const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = fnRe.exec(source)) !== null) {
    const name = m[1];
    addExp(`${name}()`, /^use[A-Z]/.test(name) ? 'hook' : 'runtime');
  }

  const constRe = /export\s+(?:const|let|class)\s+([A-Za-z0-9_$]+)/g;
  while ((m = constRe.exec(source)) !== null) {
    const name = m[1];
    addExp(name, /^use[A-Z]/.test(name) ? 'hook' : /Store|Rpc|Api/i.test(name) ? 'store' : 'runtime');
  }

  const typeRe = /export\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/g;
  while ((m = typeRe.exec(source)) !== null) {
    addExp(m[1], 'type');
  }

  const importsList = [];
  const impRe = /import\s+(type\s+)?(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
  while ((m = impRe.exec(source)) !== null) {
    const isTypeStmt = Boolean(m[1]);
    const clause = (m[2] || '').trim();
    const spec = m[3].trim();
    const symbols = [];
    let allType = isTypeStmt;

    if (clause) {
      const braceMatch = clause.match(/\{([\s\S]*?)\}/);
      if (braceMatch) {
        const parts = braceMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
        let typeCount = 0;
        for (const p of parts) {
          const isPartType = /^type\s+/.test(p);
          if (isPartType) typeCount++;
          const symName = p.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (symName) symbols.push(isPartType && !isTypeStmt ? `type ${symName}` : symName);
        }
        if (parts.length > 0 && typeCount === parts.length) allType = true;
      }
      const defPart = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, '').trim();
      if (defPart && !defPart.startsWith('*')) {
        symbols.unshift(defPart);
      } else if (defPart.startsWith('* as ')) {
        symbols.unshift(defPart.replace('* as ', '*:'));
      }
    }
    importsList.push({
      spec,
      symbols: symbols.length ? symbols.slice(0, 6) : [spec.split('/').pop() || 'import'],
      isType: allType,
    });
  }

  return { exports: exportsList.slice(0, 8), imports: importsList };
}

/** Deduksi modul arsitektur otomatis bila PRD belum mendefinisikan modules[]. */
function deriveModules(doc, allFiles) {
  if (doc?.prd?.modules?.length > 0) {
    return doc.prd.modules.map((m, idx) => {
      const defLayer =
        m.layer ||
        (/client|ui|view|comp/i.test(m.name)
          ? 'presentation'
          : /server|api|engine|rpc/i.test(m.name)
          ? 'application'
          : /store|model|shared|type/i.test(m.name)
          ? 'domain'
          : idx === 0
          ? 'domain'
          : idx === 1
          ? 'presentation'
          : 'application');
      return {
        id: m.id || `M-0${idx + 1}`,
        name: m.name,
        layer: defLayer,
        include: m.scope?.include?.length ? m.scope.include : ['**'],
        exclude: m.scope?.exclude || [],
        allowedImports: Array.isArray(m.allowedImports) && m.allowedImports.length
          ? m.allowedImports
          : doc.prd.modules.map((x) => x.id),
      };
    });
  }

  const modules = [
    {
      id: 'M-01',
      name: 'Core Types & Shared State',
      layer: 'domain',
      include: ['src/types.ts', 'src/types/**', 'src/lib/**', 'src/store/**', 'shared/**'],
      exclude: [],
      allowedImports: ['M-01'],
    },
    {
      id: 'M-02',
      name: 'Client Presentation (src)',
      layer: 'presentation',
      include: ['src/**'],
      exclude: ['src/types.ts', 'src/types/**', 'src/lib/**', 'src/store/**'],
      allowedImports: ['M-01', 'M-02'],
    },
    {
      id: 'M-03',
      name: 'Server / API / Agents',
      layer: 'application',
      include: ['server/**'],
      exclude: [],
      allowedImports: ['M-01', 'M-03'],
    },
    {
      id: 'M-04',
      name: 'Tooling, Scripts & Docs',
      layer: 'infrastructure',
      include: ['scripts/**', 'docs/**', 'design/**', 'public/**'],
      exclude: [],
      allowedImports: ['M-01', 'M-02', 'M-03', 'M-04'],
    },
  ];
  if (allFiles.some((f) => f.startsWith('addons-src/'))) {
    modules.push({
      id: 'M-09',
      name: 'Builtin Addons (addons-src)',
      layer: 'infrastructure',
      include: ['addons-src/**'],
      exclude: [],
      allowedImports: ['M-01', 'M-02', 'M-03', 'M-04', 'M-09'],
    });
  }
  return modules;
}

function matchModuleForFile(file, modules) {
  for (const m of modules) {
    if (inScope({ include: m.include, exclude: m.exclude }, file)) {
      return m;
    }
  }
  return modules[modules.length - 1] || { id: 'M-01', name: 'Core', layer: 'shared', allowedImports: ['M-01'] };
}

/** Tarjan Strongly Connected Components untuk mendeteksi circular dependency. */
function findCycleEdges(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  function strongconnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) || []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(new Set(comp));
    }
  }

  for (const n of nodes) {
    if (!indices.has(n)) strongconnect(n);
  }

  const cycleEdgeKeys = new Set();
  for (const comp of sccs) {
    for (const e of edges) {
      if (comp.has(e.from) && comp.has(e.to)) {
        cycleEdgeKeys.add(`${e.from}->${e.to}`);
      }
    }
  }
  return { sccCount: sccs.length, cycleEdgeKeys };
}

/** Bangun graf Interlinked penuh dari workspace aktif. */
export function buildWorkspaceInterlink(api, sessionId, opts = {}) {
  const ws = workspaceOf(api, sessionId);
  const root = ws?.root();
  if (!root) {
    return { clusters: [], nodes: [], wires: [], dsl: '@RSLK v1 | no bound workspace', stats: { totalFiles: 0 } };
  }

  const cacheKey = `${root}::${opts.focusPath || ''}::${opts.moduleId || ''}`;
  const cached = graphCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && !opts.force) {
    return cached.data;
  }

  const doc = loadDoc(api, sessionId);
  const ledgers = readAllLedgers(api, sessionId, 250);
  const savedPos = loadNodePositions(ws);

  const scopeMentionsAddons = (scope) => {
    if (!scope) return false;
    const globs = [...(scope.include || []), ...(scope.exclude || [])];
    return globs.some((g) => String(g).includes('addons-src') || String(g).startsWith('addons/'));
  };
  const includeAddons = Boolean(
    scopeMentionsAddons(doc?.prd?.globalScope) ||
    (doc?.prd?.modules || []).some((m) => scopeMentionsAddons(m.scope)) ||
    (doc?.achievements || []).some((a) => scopeMentionsAddons(a.scope)),
  );

  const allFiles = walkWorkspaceFiles(root, MAX_SCAN_FILES, includeAddons);
  const fileSet = new Set(allFiles);
  const modules = deriveModules(doc, allFiles);

  const recentTouched = new Map();
  for (const l of ledgers) {
    const clean = String(l.path || '').replace(/\\/g, '/');
    if (!recentTouched.has(clean)) recentTouched.set(clean, l);
  }

  const parsedMap = new Map();
  const rawEdges = [];
  const fanInMap = new Map();
  const fanOutMap = new Map();

  for (const f of allFiles) {
    fanInMap.set(f, 0);
    fanOutMap.set(f, 0);
  }

  for (const f of allFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(root, f), 'utf-8');
    } catch {
      continue;
    }
    const ast = parseFileAstLight(content);
    parsedMap.set(f, ast);

    for (const imp of ast.imports) {
      const target = resolveImportTarget(f, imp.spec, fileSet);
      if (target && target !== f) {
        rawEdges.push({
          from: target,
          to: f,
          symbols: imp.symbols,
          isType: imp.isType,
        });
        fanOutMap.set(f, (fanOutMap.get(f) || 0) + 1);
        fanInMap.set(target, (fanInMap.get(target) || 0) + 1);
      }
    }
  }

  const edgeByKey = new Map();
  const dedupedEdges = [];
  for (const e of rawEdges) {
    const key = `${e.from}=>${e.to}`;
    const hit = edgeByKey.get(key);
    if (hit) {
      hit.symbols = [...new Set([...hit.symbols, ...e.symbols])].slice(0, 6);
      hit.isType = hit.isType && e.isType;
    } else {
      edgeByKey.set(key, e);
      dedupedEdges.push(e);
    }
  }

  const scoredFiles = allFiles.map((f) => {
    const fi = fanInMap.get(f) || 0;
    const fo = fanOutMap.get(f) || 0;
    const isTouched = recentTouched.has(f) ? 50 : 0;
    const isProject = /^(src|server|client|shared)\//.test(f) ? 12 : 0;
    const isAddon = f.startsWith('addons-src/') ? -20 : 0;
    const inClaimedQuest = (doc?.achievements || []).some(
      (a) => ['claimed', 'in_progress', 'review'].includes(a.state) && inScope(a.scope, f),
    )
      ? 40
      : 0;
    const focusBoost = opts.focusPath && f.includes(opts.focusPath) ? 100 : 0;
    return { file: f, score: fi * 3 + fo * 2 + isTouched + isProject + isAddon + inClaimedQuest + focusBoost };
  });

  scoredFiles.sort((a, b) => b.score - a.score);
  const selectedFiles = new Set(scoredFiles.slice(0, MAX_CANVAS_NODES).map((x) => x.file));

  const filteredEdges = dedupedEdges.filter((e) => selectedFiles.has(e.from) && selectedFiles.has(e.to));
  const { sccCount, cycleEdgeKeys } = findCycleEdges([...selectedFiles], filteredEdges);

  const clusters = [];
  const filesByModule = new Map();
  for (const m of modules) filesByModule.set(m.id, []);
  for (const f of selectedFiles) {
    const mod = matchModuleForFile(f, modules);
    const list = filesByModule.get(mod.id) || [];
    list.push(f);
    filesByModule.set(mod.id, list);
  }

  let colX = 40;
  const nodes = [];

  const normalizeSymName = (raw) =>
    String(raw || '')
      .trim()
      .replace(/^default\s+/, '')
      .replace(/\(\)$/, '')
      .replace(/^type\s+/, '')
      .trim();

  const questAstIndex = new Map();
  for (const a of doc?.achievements || []) {
    const exportedSyms = new Set();
    const importedSyms = new Set();
    const scopedFiles = allFiles.filter(
      (f) => inScope(a.scope, f) || (a.files || []).some((fl) => fl.path === f),
    );
    for (const sf of scopedFiles) {
      const p = parsedMap.get(sf);
      if (!p) continue;
      for (const ex of p.exports || []) {
        exportedSyms.add(normalizeSymName(ex.label));
        if (ex.label.startsWith('default ')) exportedSyms.add('default export');
      }
      for (const im of p.imports || []) {
        for (const s of im.symbols || []) {
          importedSyms.add(normalizeSymName(s));
        }
      }
    }
    const declaredProvides = (a.contracts?.provides || []).map(normalizeSymName).filter(Boolean);
    const declaredConsumes = (a.contracts?.consumes || []).map(normalizeSymName).filter(Boolean);
    const matchedProvides = declaredProvides.filter((s) => exportedSyms.has(s));
    const missingProvides = declaredProvides.filter((s) => !exportedSyms.has(s));
    const matchedConsumes = declaredConsumes.filter((s) => importedSyms.has(s));
    const missingConsumes = declaredConsumes.filter((s) => !importedSyms.has(s));
    questAstIndex.set(a.id, {
      quest: a,
      scopedFiles,
      exportedSyms,
      importedSyms,
      declaredProvides,
      declaredConsumes,
      matchedProvides,
      missingProvides,
      matchedConsumes,
      missingConsumes,
    });
  }

  for (const m of modules) {
    const mFiles = filesByModule.get(m.id) || [];
    const ghostQuests = (doc?.achievements || []).filter((a) => {
      if (a.state === 'dropped') return false;
      const targetModId = a.moduleId && modules.some((mod) => mod.id === a.moduleId) ? a.moduleId : modules[0]?.id;
      if (targetModId !== m.id) return false;
      const hasContract = (a.contracts?.provides?.length || 0) > 0 || (a.contracts?.consumes?.length || 0) > 0;
      if (!hasContract) return false;
      const hasSelectedFile = mFiles.some(
        (f) => inScope(a.scope, f) || (a.files || []).some((fl) => fl.path === f),
      );
      return !hasSelectedFile;
    });

    const totalItems = mFiles.length + ghostQuests.length;
    if (totalItems === 0) continue;
    const subCols = totalItems > 5 ? 2 : 1;
    const colW = subCols === 2 ? 580 : 310;
    const rows = Math.ceil(totalItems / subCols);
    const clusterH = Math.max(460, rows * 195 + 80);

    clusters.push({
      id: m.id,
      name: m.name,
      layer: m.layer,
      allowedImports: m.allowedImports,
      x: colX,
      y: 44,
      w: colW,
      h: clusterH,
    });

    mFiles.forEach((f, idx) => {
      const cIdx = idx % subCols;
      const rIdx = Math.floor(idx / subCols);
      const nodeId = `n:${f}`;
      const defaultX = colX + 26 + cIdx * 276;
      const defaultY = 98 + rIdx * 192;
      const pos = savedPos[nodeId] || { x: defaultX, y: defaultY };

      const activeOwners = (doc?.achievements || []).filter(
        (a) => ['claimed', 'in_progress', 'review'].includes(a.state) && inScope(a.scope, f),
      );
      const anyOwner =
        activeOwners[0] ||
        (doc?.achievements || []).find((a) => (a.files || []).some((fl) => fl.path === f) || inScope(a.scope, f));

      const touchRec = recentTouched.get(f);
      const holder =
        anyOwner?.claim?.label ||
        anyOwner?.claim?.by?.name ||
        touchRec?.by?.label ||
        touchRec?.by?.name ||
        (anyOwner?.state === 'done' ? 'completed' : 'unassigned');

      const ast = parsedMap.get(f) || { exports: [], imports: [] };
      const qCheck = anyOwner ? questAstIndex.get(anyOwner.id) : null;
      const hasDeclaredProvides = Boolean(qCheck && qCheck.declaredProvides.length > 0);
      const hasDeclaredConsumes = Boolean(qCheck && qCheck.declaredConsumes.length > 0);
      const declaredProvideSet = new Set(qCheck?.declaredProvides || []);
      const declaredConsumeSet = new Set(qCheck?.declaredConsumes || []);

      const fileExportNames = (ast.exports || []).map((ex) => normalizeSymName(ex.label));
      const undeclaredExports = hasDeclaredProvides
        ? fileExportNames.filter((sym) => !declaredProvideSet.has(sym))
        : [];

      const rawOutputs = [];
      for (const ex of ast.exports || []) {
        const clean = normalizeSymName(ex.label);
        const isMatched =
          declaredProvideSet.has(clean) ||
          (ex.label.startsWith('default ') && declaredProvideSet.has('default export'));
        const contractStatus = hasDeclaredProvides ? (isMatched ? 'matched' : 'undeclared') : 'unscoped';
        rawOutputs.push({
          label: ex.label,
          kind: ex.kind,
          contractStatus,
        });
      }
      if (qCheck && qCheck.missingProvides.length > 0) {
        const isPrimaryFileForQuest = qCheck.scopedFiles[0] === f || qCheck.scopedFiles.length <= 1;
        if (isPrimaryFileForQuest) {
          for (const missingSym of qCheck.missingProvides) {
            rawOutputs.push({
              label: missingSym,
              kind: 'runtime',
              contractStatus: 'missing',
            });
          }
        }
      }
      if (rawOutputs.length === 0) {
        rawOutputs.push({ label: 'module', kind: 'runtime', contractStatus: 'unscoped' });
      }
      rawOutputs.sort((a, b) => {
        const rank = { missing: 0, matched: 1, undeclared: 2, unscoped: 3 };
        return (rank[a.contractStatus] ?? 3) - (rank[b.contractStatus] ?? 3);
      });
      const outputs = rawOutputs.slice(0, 4).map((ex, i) => ({
        id: `${nodeId}:out:${i}`,
        label: ex.label,
        kind: ex.kind,
        contractStatus: ex.contractStatus,
      }));

      const incomingEdges = filteredEdges.filter((e) => e.to === f);
      const inputs = incomingEdges.slice(0, 4).map((e, i) => {
        const edgeSyms = e.symbols.map(normalizeSymName);
        let contractStatus = 'unscoped';
        if (hasDeclaredConsumes) {
          contractStatus = edgeSyms.some((s) => declaredConsumeSet.has(s)) ? 'matched' : 'undeclared';
        }
        return {
          id: `${nodeId}:in:${i}`,
          label: e.symbols.slice(0, 2).join(', '),
          kind: e.isType ? 'type' : /^use[A-Z]/.test(e.symbols[0] || '') ? 'hook' : 'runtime',
          contractStatus,
        };
      });

      if (qCheck && qCheck.missingConsumes.length > 0 && inputs.length < 4) {
        const isPrimaryFileForQuest = qCheck.scopedFiles[0] === f || qCheck.scopedFiles.length <= 1;
        if (isPrimaryFileForQuest) {
          for (const missingCon of qCheck.missingConsumes.slice(0, 4 - inputs.length)) {
            inputs.push({
              id: `${nodeId}:in:${inputs.length}`,
              label: missingCon,
              kind: 'runtime',
              contractStatus: 'missing',
            });
          }
        }
      }

      const contractCheck = qCheck
        ? {
            questId: anyOwner.id,
            declaredProvides: qCheck.declaredProvides,
            declaredConsumes: qCheck.declaredConsumes,
            matchedProvides: qCheck.matchedProvides,
            missingProvides: qCheck.missingProvides,
            undeclaredExports,
            matchedConsumes: qCheck.matchedConsumes,
            missingConsumes: qCheck.missingConsumes,
          }
        : undefined;

      let contractViolation;
      if (qCheck && qCheck.missingProvides.length > 0) {
        const isPrimaryFileForQuest = qCheck.scopedFiles[0] === f || qCheck.scopedFiles.length <= 1;
        if (isPrimaryFileForQuest) {
          contractViolation = `CONTRACT DRIFT (${anyOwner.id}): Missing promised export(s) [${qCheck.missingProvides.join(', ')}] in AST.`;
        }
      }

      const baseTitle = path.posix.basename(f);

      nodes.push({
        id: nodeId,
        file: f,
        fullPath: f,
        title: touchRec?.summary ? String(touchRec.summary).slice(0, 38) : baseTitle,
        moduleId: m.id,
        layer: m.layer,
        questId: anyOwner?.id,
        holder,
        state: anyOwner?.state || 'available',
        x: pos.x,
        y: pos.y,
        fanIn: fanInMap.get(f) || 0,
        fanOut: fanOutMap.get(f) || 0,
        touched: Boolean(touchRec),
        inputs,
        outputs,
        violation: contractViolation,
        contractCheck,
      });
    });

    ghostQuests.forEach((gq, gIdx) => {
      const idx = mFiles.length + gIdx;
      const cIdx = idx % subCols;
      const rIdx = Math.floor(idx / subCols);
      const ghostPath = gq.scope?.include?.[0] || `${gq.id}/pending-contract.ts`;
      const nodeId = `n:ghost:${gq.id}`;
      const defaultX = colX + 26 + cIdx * 276;
      const defaultY = 98 + rIdx * 192;
      const pos = savedPos[nodeId] || { x: defaultX, y: defaultY };
      const qCheck = questAstIndex.get(gq.id);
      const holder = gq.claim?.label || gq.claim?.by?.name || 'unassigned';

      const outputs = (qCheck?.declaredProvides || []).slice(0, 4).map((sym, i) => ({
        id: `${nodeId}:out:${i}`,
        label: sym,
        kind: 'runtime',
        contractStatus: 'missing',
      }));
      const inputs = (qCheck?.declaredConsumes || []).slice(0, 4).map((sym, i) => ({
        id: `${nodeId}:in:${i}`,
        label: sym,
        kind: 'runtime',
        contractStatus: 'missing',
      }));

      nodes.push({
        id: nodeId,
        file: `${gq.id} (pending)`,
        fullPath: ghostPath,
        title: `[Ghost] ${gq.title}`.slice(0, 38),
        moduleId: m.id,
        layer: m.layer,
        questId: gq.id,
        holder,
        state: gq.state || 'available',
        x: pos.x,
        y: pos.y,
        fanIn: 0,
        fanOut: 0,
        touched: false,
        inputs,
        outputs: outputs.length ? outputs : [{ id: `${nodeId}:out:0`, label: 'pending', kind: 'runtime', contractStatus: 'missing' }],
        violation:
          qCheck && qCheck.missingProvides.length > 0
            ? `PENDING CONTRACT (${gq.id}): Awaiting implementation of [${qCheck.missingProvides.join(', ')}] in ${ghostPath}.`
            : undefined,
        contractCheck: qCheck
          ? {
              questId: gq.id,
              declaredProvides: qCheck.declaredProvides,
              declaredConsumes: qCheck.declaredConsumes,
              matchedProvides: qCheck.matchedProvides,
              missingProvides: qCheck.missingProvides,
              undeclaredExports: [],
              matchedConsumes: qCheck.matchedConsumes,
              missingConsumes: qCheck.missingConsumes,
            }
          : undefined,
        isGhost: true,
      });
    });

    colX += colW + 44;
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const modById = new Map(modules.map((m) => [m.id, m]));

  const inputIndexByEdge = new Map();
  const incomingCountByFile = new Map();
  for (const e of filteredEdges) {
    const c = incomingCountByFile.get(e.to) || 0;
    incomingCountByFile.set(e.to, c + 1);
    inputIndexByEdge.set(e, c);
  }

  const wires = [];
  filteredEdges.forEach((e, idx) => {
    const srcNode = nodeById.get(`n:${e.from}`);
    const dstNode = nodeById.get(`n:${e.to}`);
    if (!srcNode || !dstNode) return;

    const srcMod = modById.get(srcNode.moduleId);
    const dstMod = modById.get(dstNode.moduleId);

    const isLayerViolation =
      dstMod &&
      Array.isArray(dstMod.allowedImports) &&
      dstMod.allowedImports.length > 0 &&
      !dstMod.allowedImports.includes(srcNode.moduleId);

    const isCycle = cycleEdgeKeys.has(`${e.from}->${e.to}`);
    const isCrossAgent =
      srcNode.questId &&
      dstNode.questId &&
      srcNode.questId !== dstNode.questId &&
      srcNode.holder !== dstNode.holder &&
      srcNode.holder !== 'unassigned' &&
      dstNode.holder !== 'unassigned';

    let kind = 'data';
    let note = `${dstNode.file} imports [${e.symbols.join(', ')}] from ${srcNode.file}`;

    if (isLayerViolation || isCycle) {
      kind = 'broken';
      note = isCycle
        ? `CIRCULAR DEPENDENCY detected between ${srcNode.file} and ${dstNode.file}`
        : `LAYER VIOLATION: ${dstNode.moduleId} (${dstNode.layer}) is not allowed to import from ${srcNode.moduleId} (${srcNode.layer})`;
      dstNode.violation = note;
    } else if (isCrossAgent) {
      kind = 'cross';
      note = `CROSS-QUEST LINK: ${srcNode.questId} (${srcNode.holder}) -> ${dstNode.questId} (${dstNode.holder})`;
    } else if (srcNode.touched || dstNode.touched) {
      kind = 'active';
      note = `Active session wire — recently touched in ledger`;
    } else if (e.isType) {
      kind = 'type';
      note = `Type/Interface contract binding`;
    }

    const fromSocket = srcNode.outputs[0]?.id || `${srcNode.id}:out:0`;
    const inIdx = inputIndexByEdge.get(e) ?? 0;
    const toSocket = dstNode.inputs[inIdx]?.id || dstNode.inputs[0]?.id || `${dstNode.id}:in:0`;

    wires.push({
      id: `w-${idx}`,
      fromNode: srcNode.id,
      fromSocket,
      toNode: dstNode.id,
      toSocket,
      symbols: e.symbols,
      kind,
      note,
    });
  });

  const dsl = formatRslkServer(clusters, nodes, wires, {
    workspaceName: path.basename(root),
    focusPath: opts.focusPath,
    sccCount,
    totalScanned: allFiles.length,
  });

  const result = {
    clusters,
    nodes,
    wires,
    dsl,
    stats: {
      totalScanned: allFiles.length,
      canvasNodes: nodes.length,
      wires: wires.length,
      cycles: sccCount,
      violations: wires.filter((w) => w.kind === 'broken').length,
      crossAgent: wires.filter((w) => w.kind === 'cross').length,
    },
  };

  graphCache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

/** Format Khusus Agent: @RSLK v1 (Server-side generator untuk rsat_interlink tool). */
export function formatRslkServer(clusters, nodes, wires, meta = {}) {
  const broken = wires.filter((w) => w.kind === 'broken');
  const cross = wires.filter((w) => w.kind === 'cross');
  const lines = [
    `@RSLK v1 | ws="${meta.workspaceName || 'workspace'}" | scanned=${meta.totalScanned ?? nodes.length} nodes=${nodes.length} wires=${wires.length} cycles=${meta.sccCount ?? 0} cross_agent=${cross.length} violations=${broken.length}`,
    `@LEGEND: [N:file] Node | --(sym)--> Runtime | ==(Type)==> Contract | ~~(sym)~~> Active Touch | !!(err)!!> Violation`,
    ``,
    `# 1. ARCHITECTURE MODULES & LAYER MATRIX`,
  ];

  for (const c of clusters) {
    lines.push(`[${c.id}] "${c.name}" (layer:${c.layer}) -> allowedImports:[${(c.allowedImports || []).join(', ')}]`);
  }

  const focus = meta.focusPath ? String(meta.focusPath).replace(/\\/g, '/') : '';
  const targetNodes = focus
    ? nodes.filter((n) => n.file.includes(focus) || (n.fullPath && n.fullPath.includes(focus)))
    : nodes;

  lines.push(``, `# 2. INTERLINKED TOPOLOGY ${focus ? `(FILTERED: "${focus}")` : `(TOP ${targetNodes.length} ARCHITECTURAL HUBS)`}`);

  for (const n of targetNodes) {
    const I = n.fanIn + n.fanOut === 0 ? '0.00' : (n.fanOut / (n.fanIn + n.fanOut)).toFixed(2);
    const flags = [n.touched ? '*ACTIVE_TOUCH*' : '', n.violation ? '!VIOLATION!' : ''].filter(Boolean).join(' ');
    lines.push(
      `[N:${n.file}] (quest:${n.questId ?? 'unassigned'} [${n.state} by ${n.holder}] | mod:${n.moduleId} | layer:${n.layer} | fanIn:${n.fanIn} fanOut:${n.fanOut} I=${I}) ${flags}`.trim(),
    );
    if (n.outputs?.length) {
      lines.push(
        `  PROVIDES: ${n.outputs
          .map((o) => {
            const st =
              o.contractStatus === 'matched'
                ? '✓'
                : o.contractStatus === 'missing'
                  ? '✗MISSING:'
                  : o.contractStatus === 'undeclared'
                    ? '?UNDECLARED:'
                    : '';
            return `${st}${o.label}:${o.kind}`;
          })
          .join(', ')}`,
      );
    }
    if (n.contractCheck && (n.contractCheck.declaredProvides.length > 0 || n.contractCheck.declaredConsumes.length > 0)) {
      lines.push(
        `  CONTRACT: matched=[${n.contractCheck.matchedProvides.join(',')}] missing=[${n.contractCheck.missingProvides.join(',')}] undeclared=[${n.contractCheck.undeclaredExports.join(',')}]`,
      );
    }
    const outWires = wires.filter((w) => w.fromNode === n.id);
    for (const w of outWires) {
      const dst = nodes.find((x) => x.id === w.toNode);
      if (!dst) continue;
      const arrow =
        w.kind === 'type'
          ? `==(${w.symbols.join(',')})==>`
          : w.kind === 'broken'
          ? `!!(${w.symbols.join(',')})!!>`
          : w.kind === 'active'
          ? `~~(${w.symbols.join(',')})~~>`
          : `--(${w.symbols.join(',')})-->`;
      const crossTag = w.kind === 'cross' ? ` [CROSS-AGENT: ${n.holder} -> ${dst.holder}]` : '';
      lines.push(`  |${arrow} [N:${dst.file}] (quest:${dst.questId ?? '-'} | mod:${dst.moduleId})${crossTag}`);
    }
    if (focus) {
      const inWires = wires.filter((w) => w.toNode === n.id);
      for (const w of inWires) {
        const src = nodes.find((x) => x.id === w.fromNode);
        if (src) lines.push(`  <--(${w.symbols.join(',')})-- [N:${src.file}] (quest:${src.questId ?? '-'} by ${src.holder})`);
      }
    }
  }

  const contractDrifts = nodes.filter(
    (n) => n.contractCheck && n.contractCheck.missingProvides && n.contractCheck.missingProvides.length > 0,
  );
  lines.push(``, `# 3. ARCHITECTURAL & MULTI-AGENT ALERTS`);
  if (broken.length === 0 && cross.length === 0 && contractDrifts.length === 0) {
    lines.push(`(clean — 0 layer/contract violations, 0 cross-agent collisions)`);
  } else {
    for (const w of broken) {
      const src = nodes.find((x) => x.id === w.fromNode);
      const dst = nodes.find((x) => x.id === w.toNode);
      lines.push(`[ALERT:VIOLATION] ${dst?.file} -> ${src?.file}: ${w.note}`);
    }
    for (const cn of contractDrifts) {
      lines.push(
        `[ALERT:CONTRACT_DRIFT] ${cn.questId ?? cn.file} (${cn.file}): Missing promised export(s) [${cn.contractCheck.missingProvides.join(', ')}] in AST.`,
      );
    }
    for (const w of cross) {
      const src = nodes.find((x) => x.id === w.fromNode);
      const dst = nodes.find((x) => x.id === w.toNode);
      lines.push(`[WARN:CROSS_AGENT] ${src?.file} (${src?.holder}) feeds ${dst?.file} (${dst?.holder}) via [${w.symbols.join(', ')}]`);
    }
  }

  return lines.join('\n');
}

/**
 * Verifikasi apakah seluruh simbol yang dijanjikan di `achievement.contracts.provides`
 * benar-benar telah di-export pada AST file di dalam scope quest tersebut.
 */
export function verifyQuestContracts(api, sessionId, achievement) {
  const normalizeSymName = (raw) =>
    String(raw || '')
      .trim()
      .replace(/^default\s+/, '')
      .replace(/\(\)$/, '')
      .replace(/^type\s+/, '')
      .trim();
  const provides = (achievement?.contracts?.provides || []).map(normalizeSymName).filter(Boolean);
  if (provides.length === 0) {
    return { ok: true, missingProvides: [], matchedProvides: [], scopedFiles: [] };
  }
  const graph = buildWorkspaceInterlink(api, sessionId, { force: true });
  const qNodes = (graph.nodes || []).filter((n) => n.questId === achievement.id && !n.isGhost);
  const matchedSet = new Set();
  for (const n of qNodes) {
    for (const m of n.contractCheck?.matchedProvides || []) {
      matchedSet.add(m);
    }
  }
  const missingProvides = provides.filter((s) => !matchedSet.has(s));
  const matchedProvides = provides.filter((s) => matchedSet.has(s));
  return {
    ok: missingProvides.length === 0,
    missingProvides,
    matchedProvides,
    scopedFiles: qNodes.map((n) => n.fullPath),
  };
}

/**
 * Cek cepat untuk Guard saat Agent menulis ke `relPath`:
 * 1) Apakah file tersebut melanggar allowedImports modulnya?
 * 2) Berapa downstream consumer di luar quest Agent tersebut (blast radius)?
 */
export function inspectFileArchImpact(api, sessionId, relPath) {
  try {
    const clean = String(relPath || '').replace(/\\/g, '/');
    const g = buildWorkspaceInterlink(api, sessionId);
    const node = g.nodes.find((n) => n.fullPath === clean || n.file === clean || clean.endsWith(n.file));
    if (!node) return null;
    const downstream = g.wires
      .filter((w) => w.fromNode === node.id)
      .map((w) => g.nodes.find((n) => n.id === w.toNode))
      .filter(Boolean);
    const crossDownstream = downstream.filter((d) => d.questId && d.questId !== node.questId);
    return {
      node,
      fanIn: node.fanIn,
      violation: node.violation || null,
      crossDownstream: crossDownstream.map((d) => `${d.file} (${d.questId} by ${d.holder})`),
    };
  } catch {
    return null;
  }
}
