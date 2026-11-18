

export interface CraftDna {
  id: string;
  tokens: Record<string, string>;
  fonts: { display: string; body: string };
}

export interface CraftScan {
  ran: boolean;
  
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


export function craftApi(api: any): MococraftApi | null {
  try {
    const mod = api?.api?.use?.('mococraft');
    return mod && typeof mod.activeDna === 'function' ? (mod as MococraftApi) : null;
  } catch {
    return null;
  }
}


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
      tokens[key.replace(/^--moco-/, '')] = value;
    }
    return { id: dna.id, tokens, fonts: { display: dna.displayFont, body: dna.bodyFont } };
  } catch {
    return null;
  }
}


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
