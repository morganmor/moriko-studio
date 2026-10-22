/**
 * Moco Canvas — Mococraft bridge (P3, plan §11).
 *
 * Consumes the mod API exposed by mococraft (api.api.use('mococraft')) for:
 *  - the locked Design DNA → scene tokens/fonts (mapping --moco-* → tokens),
 *  - the slop scan on compiled output before `export` (the write-tool gate
 *    does NOT see addon-written files, so this scan is mandatory — plan §17).
 *
 * Moco Canvas MUST run without Mococraft: every function here degrades to a
 * neutral fallback with a note, never throws.
 */

export interface CraftDna {
  id: string;
  tokens: Record<string, string>;
  fonts: { display: string; body: string };
}

export interface CraftScan {
  ran: boolean;
  /** slop index 0–100 when the scan ran */
  slopIndex?: number;
  verdict?: string;
  notes: string[];
}

interface MococraftApi {
  activeDna(): string;
  dnaById(id: string): {
    id: string;
    name: string;
    palette: Record<string, string>;
    displayFont: string;
    bodyFont: string;
  } | null;
  scanContent(path: string, content: string, sensitivity?: number): {
    slopIndex: number;
    verdict: string;
    hits: Array<{ rule: string; line: number; label: string; fix: string; severity: string }>;
    copyHits: Array<{ line: number; phrase: string }>;
  };
  isUiFile(path: string): boolean;
}

/** null when mococraft is absent or has not exposed its mod API yet. */
export function craftApi(api: any): MococraftApi | null {
  try {
    const mod = api?.api?.use?.('mococraft');
    return mod && typeof mod.activeDna === 'function' ? (mod as MococraftApi) : null;
  } catch {
    return null;
  }
}

/** The locked Mococraft DNA mapped to scene shape — null when unavailable. */
export function craftDna(api: any): CraftDna | null {
  const mod = craftApi(api);
  if (!mod) return null;
  try {
    const id = mod.activeDna();
    if (!id) return null;
    const dna = mod.dnaById(id);
    if (!dna) return null;
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(dna.palette)) {
      // "--moco-canvas" → canvas, "--moco-ink" → ink …
      tokens[key.replace(/^--moco-/, '')] = value;
    }
    return { id: dna.id, tokens, fonts: { display: dna.displayFont, body: dna.bodyFont } };
  } catch {
    return null;
  }
}

/**
 * Mandatory pre-export slop scan (plan §11/§17). Returns a ran:false result
 * with a note when Mococraft is not installed — export proceeds, honestly.
 */
export function scanForExport(api: any, path: string, content: string): CraftScan {
  const mod = craftApi(api);
  if (!mod) {
    return { ran: false, notes: ['Mococraft not available — slop scan skipped (install/enable mococraft for the gate).'] };
  }
  try {
    if (!mod.isUiFile(path)) {
      return { ran: false, notes: [`"${path}" is not a UI file — slop scan not applicable.`] };
    }
    const report = mod.scanContent(path, content, 2);
    const notes = [
      ...report.hits.map((h) => `[${h.rule}] L${h.line}: ${h.label} — ${h.fix}`),
      ...report.copyHits.map((c) => `[copy-cliché] L${c.line}: "${c.phrase}"`),
    ];
    return { ran: true, slopIndex: report.slopIndex, verdict: report.verdict, notes };
  } catch (error) {
    return { ran: false, notes: [`slop scan threw: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
