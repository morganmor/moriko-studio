

import { rulesFor, COPY_CLICHES, PLACEHOLDER_NAMES, type SlopRule } from './rules.js';

export interface SlopHit {
  rule: string;
  label: string;
  severity: string;
  line: number;
  snippet: string;
  why: string;
  fix: string;
}

export interface ScanReport {
  file: string;
  hits: SlopHit[];
  copyHits: Array<{ phrase: string; line: number }>;
  slopIndex: number;
  verdict: 'clean' | 'watch' | 'slop';
  radar: Record<string, number>;
}

const UI_FILE_RE = /\.(?:tsx|jsx|ts|js|css|html|svelte|vue)$/i;

export function isUiFile(path: string): boolean {
  return UI_FILE_RE.test(path);
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function snippetAt(content: string, index: number): string {
  return content.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, ' ').trim();
}

export function scanContent(path: string, content: string, sensitivity: number): ScanReport {
  const hits: SlopHit[] = [];
  const radar: Record<string, number> = {
    'Color discipline': 0,
    'Typography': 0,
    'Motion': 0,
    'Layout': 0,
  };

  for (const rule of rulesFor() as SlopRule[]) {
    const m = rule.re.exec(content);
    if (!m) continue;
    const global = content.match(new RegExp(rule.re.source, 'gi'));
    const count = global?.length ?? 1;
    hits.push({
      rule: rule.id,
      label: rule.label,
      severity: rule.severity,
      line: lineOf(content, m.index),
      snippet: snippetAt(content, m.index),
      why: rule.why,
      fix: rule.fix,
    });
    const dim =
      rule.id.includes('gradient') || rule.id.includes('black-white') ? 'Color discipline'
      : rule.id.includes('font') ? 'Typography'
      : rule.id.includes('transition') || rule.id.includes('easing') ? 'Motion'
      : 'Layout';
    radar[dim] = (radar[dim] ?? 0) + count * (rule.severity === 'critical' ? 2 : 1);
  }

  const copyHits: ScanReport['copyHits'] = [];
  if (true) {
    for (const { phrase, re } of [...COPY_CLICHES, ...PLACEHOLDER_NAMES]) {
      const m = re.exec(content);
      if (m) copyHits.push({ phrase, line: lineOf(content, m.index) });
    }
  }
  if (copyHits.length > 0) radar['Copy'] = copyHits.length;

  let score = 0;
  for (const h of hits) score += h.severity === 'critical' ? 18 : 8;
  score += copyHits.length * 4;
  const slopIndex = Math.min(100, score);

  const criticalCount = hits.filter((h) => h.severity === 'critical').length;
  const verdict =
    criticalCount >= sensitivity ? 'slop'
    : hits.length > 0 || copyHits.length > 0 ? 'watch'
    : 'clean';

  return { file: path, hits, copyHits, slopIndex, verdict, radar };
}
