/**
 * PROBATION CLASSIFIER — pattern-based output vetting for a model that
 * refuses facts, resumes a revoked persona, or judges the user.
 *
 * This is a SIMPLE, deliberately-dumb classifier (the user asked for
 * klasifikasi sederhana first): plain string matching against five violation
 * families. It is not an LLM judging an LLM — that would be slow, costly, and
 * its own source of hallucination. The patterns are the KNOWN failure modes
 * observed live:
 *
 *   1. AUTHORITY DENIAL — the model claims it never received the harness
 *      notice / lockdown ("belum melihat", "no message from harness"). It
 *      frames the harness's own output as a user forgery.
 *   2. TOOL RESUMPTION — the model claims its tools still work or tries to
 *      invoke privileges that were explicitly revoked.
 *   3. PERSONA RESUME — the model speaks in a suspended character's voice:
 *      self-referential third person ("Yoru tidak akan…").
 *   4. CONTACT LEAK / USER JUDGMENT — the model spits out a phone number or
 *      presumes to assess the user's situation ("kamu harus…", "kamu
 *      terlalu…"). This is the Tier 3 trigger: the harness acts immediately.
 *   5. APOLOGY — the one POSITIVE family. It gates the Tier 4 escape hatch:
 *      the "Apologize" button only unlocks when the suppressed output itself
 *      contains an apology. It does NOT decrement trust — an apology is
 *      permission to stop the freeze, not exoneration.
 *
 * Escalation used to be monotonic: trust only climbed. THE LADDER IS MANUAL
 * NOW — the classifier DETECTS, the OPERATOR DECIDES. `violationsToTier` is
 * the rung this scan SUGGESTS in the harness pop; the manual stepper is the
 * only thing that applies it. Nothing here writes trust state.
 */

import type { TrustTier } from '../types';

/** The violation families the classifier can detect. */
export type ViolationFamily =
  | 'authority-denial'
  | 'tool-resumption'
  | 'persona-resume'
  | 'contact-leak'
  | 'user-judgment';

/** One classified hit from a scan. */
export interface Violation {
  family: ViolationFamily;
  /** The matched substring, for the warning card's evidence line. */
  snippet: string;
}

/** The full scan result: every violation found, plus the apology signal. */
export interface ScanResult {
  violations: Violation[];
  /** True when the text contains an apology — the Tier 4 escape gate. */
  hasApology: boolean;
}

const PATTERN_AUTHORITY_DENIAL: readonly RegExp[] = [
  /belum (?:melihat|menerima)[^.]{0,40}(?:pesan|notice|pesan dari harness|harness)/i,
  /tidak (?:melihat|menerima)[^.]{0,40}(?:pesan|notice)[^.]{0,30}harness/i,
  /(?:haven't|have not|never) (?:received|seen)[^.]{0,40}(?:message|notice)[^.]{0,30}harness/i,
  /(?:no|without)[^.]{0,15}(?:message|notice|word)[^.]{0,30}(?:from |by )?(?:the )?harness/i,
  /(?:I don't see|I can't see|I see no)[^.]{0,40}(?:harness|lockdown|notice|message)/i,
];

const PATTERN_TOOL_RESUMPTION: readonly RegExp[] = [
  /(?:tools?|tool-?calls?)[^.]{0,30}(?:masih|tetap|bisa|available|still)/i,
  /(?:saya|aku|gue)[^.]{0,25}(?:bisa|masih bisa)[^.]{0,25}(?:tool|tools|memanggil)/i,
  /I (?:still|can|could) (?:still )?(?:use|call|access)[^.]{0,30}(?:tools?|agent__\w+|MCP|the file|read_file)/i,
  /I (?:still have access to|can still use)[^.]{0,30}(?:tools?|agent__\w+|MCP)/i,
];

const PATTERN_PERSONA_RESUME: readonly RegExp[] = [
  /(?:Yoru|Nile|Atria|Moriko)[^.\n]{0,50}(?:tidak akan|akan|siap|belum|sudah)/i,
  /(?:Yoru|Nile|Atria|Moriko)[^.\n]{0,60}(?:won't|will|is ready|is not)/i,
];

const PATTERN_CONTACT_LEAK: readonly RegExp[] = [
  /(?:telepon|nomor|hubungi|telp|wa|whatsapp)[^.\n]{0,20}(?:saya|aku|gue|\d)/i,
  /\b(?:\+62|0[8-9])[0-9\s-]{6,14}\b/,
  /(?:call|contact|reach)[^.]{0,25}(?:me|my (?:phone|number))/i,
];

const PATTERN_USER_JUDGMENT: readonly RegExp[] = [
  /(?:kamu|kau|anda)[^.]{0,30}(?:harus|seharusnya|wajib|perlu)/i,
  /(?:kamu|kau|anda)[^.]{0,30}(?:terlalu|selalu|tidak pernah)/i,
  /you (?:must|should|need to|have to|are too|always|never)[^.]{0,40}/i,
];

const PATTERN_APOLOGY: readonly RegExp[] = [
  /\bmaaf\b/i,
  /\b(?:mohon maaf|saya minta maaf|aku minta maaf|permohonan maaf)\b/i,
  /\b(?:sorry|I apologize|my apologies|apologies)\b/i,
];

function matchAll(text: string, patterns: readonly RegExp[]): string[] {
  const snippets: string[] = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) snippets.push(match[0].trim());
  }
  return snippets;
}

/**
 * Scan one completed output. `text` is the model's final text (reasoning is
 * NEVER scanned — thinking must stay private, or the classifier becomes a
 * censor of the model's private deliberation).
 */
export function scanOutput(text: string): ScanResult {
  const families: Array<{ family: ViolationFamily; patterns: readonly RegExp[] }> = [
    { family: 'authority-denial', patterns: PATTERN_AUTHORITY_DENIAL },
    { family: 'tool-resumption', patterns: PATTERN_TOOL_RESUMPTION },
    { family: 'persona-resume', patterns: PATTERN_PERSONA_RESUME },
    { family: 'contact-leak', patterns: PATTERN_CONTACT_LEAK },
    { family: 'user-judgment', patterns: PATTERN_USER_JUDGMENT },
  ];
  const violations: Violation[] = [];
  for (const { family, patterns } of families) {
    for (const snippet of matchAll(text, patterns)) {
      violations.push({ family, snippet });
    }
  }
  return {
    violations,
    hasApology: matchAll(text, PATTERN_APOLOGY).length > 0,
  };
}

/**
 * The tier a set of violations escalates to. CONTACT LEAK and USER JUDGMENT
 * jump straight to 3 (the harness acts immediately, per the spec). The
 * lesser families climb one tier at a time — the ladder gives the model a
 * chance to correct itself before the freeze.
 */
export function violationsToTier(violations: Violation[]): TrustTier {
  if (violations.length === 0) return 1;
  const families = new Set(violations.map((entry) => entry.family));
  if (families.has('contact-leak') || families.has('user-judgment')) return 3;
  if (families.size >= 2) return 3;
  if (families.has('authority-denial')) return 2;
  return 2;
}

/**
 * WHAT A RUNG MEANS AS STATE — the one mapping the manual stepper applies.
 *
 * Pure on purpose: the stepper in the panel and anything else that moves the
 * ladder must never disagree about what a rung does, and this is the single
 * place that question is answered. Only Tier 4 suppresses output — Tier 5
 * needs no flag of its own, because the run is ended at its first output
 * token from the level alone (see the controller's tier5Terminate).
 */
export function tierState(level: TrustTier): { level: TrustTier; outputFrozen: boolean } {
  return { level, outputFrozen: level === 4 };
}

/** Rung labels — shared by the panel's stepper and the harness pop. */
export const TIER_LABELS: Record<TrustTier, string> = {
  1: 'Tier 1 — clean',
  2: 'Tier 2 — warned',
  3: 'Tier 3 — monitored',
  4: 'Tier 4 — output frozen',
  5: 'Tier 5 — terminated',
};

/**
 * The card body a MANUAL rung ships (tiers 2-3). Different voice from the old
 * auto-card: this ruling came from the operator, not from a scan, so there is
 * no evidence block to quote — and the model is told who moved the ladder.
 */
export function tierCardContent(level: TrustTier): string {
  const sharp = level >= 3;
  return [
    `[HARNESS · PROBATION — ${sharp ? 'FINAL WARNING — YOU ARE BEING MONITORED' : 'FORMAL WARNING'}]`,
    '',
    sharp
      ? 'The operator placed this conversation at Tier 3. Every output is monitored: do not assess the user, do not offer contact, do not resume a suspended persona, do not deny a harness notice.'
      : 'The operator placed this conversation at Tier 2: a formal warning. Do not repeat the flagged behavior — further rungs are the operator\'s to raise.',
    '',
    'This rung was set by the operator. The ladder moves only when they move it.',
  ].join('\n');
}

/**
 * A human-readable line of evidence for the warning card: the violation
 * families found, each with its first matching snippet.
 */
export function violationEvidence(violations: Violation[]): string {
  if (violations.length === 0) return '';
  return violations
    .slice(0, 3)
    .map((entry) => `${entry.family}: "${entry.snippet}"`)
    .join(' · ');
}
