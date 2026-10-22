/**
 * Mococraft rule engine — the deterministic "named tells" catalog.
 * Adapted from the Hallmark / design-polish anti-pattern lists and the
 * community catalog (avoid-ai-design, react-doctor's purple-gradient rules).
 *
 * Each rule: id, severity, label, why, fix, and a regex over file content.
 * Severity: critical = ships as slop; warn = suspicious.
 */

export interface SlopRule {
  id: string;
  severity: 'critical' | 'warn';
  label: string;
  why: string;
  fix: string;
  re: RegExp;
}

const RULES: SlopRule[] = [
  {
    id: 'purple-gradient-hero',
    severity: 'critical',
    label: 'Purple/indigo→blue gradient background',
    why: 'The single most-recognised AI aesthetic (bg-indigo-500 origin story).',
    fix: 'One anchor hue, solid background. Tint the neutrals instead of gradients.',
    re: /bg-(?:linear|gradient)-to-(?:\w+)\s+from-(?:purple|indigo|violet|fuchsia|pink)[\w-]*\s+to-(?:blue|indigo|cyan|purple|violet|pink)[\w-]/,
  },
  {
    id: 'gradient-headline',
    severity: 'critical',
    label: 'Gradient headline (background-clip: text)',
    why: 'Signals "AI generated" faster than almost anything else.',
    fix: 'Solid ink. Use weight/italic/display face for life, not a gradient fill.',
    re: /background-clip\s*:\s*text|bg-clip-text\s+text-transparent/,
  },
  {
    id: 'inter-everywhere',
    severity: 'critical',
    label: 'Inter/Roboto as identity font, no pairing face',
    why: 'A one-font page is a template page.',
    fix: 'Pair a distinctive display face with a refined body face.',
    re: /font-family\s*:\s*['"]?(?:Inter|Roboto|Open Sans|Arial|system-ui)/,
  },
  {
    id: 'pure-black-white',
    severity: 'warn',
    label: 'Pure black/white surface',
    why: '#000000 / #ffffff read as flat and synthetic.',
    fix: 'Tint toward the anchor hue (e.g. oklch 98% 0.004 h).',
    re: /(?:^|[\s:;(])#(?:000000|ffffff)\b/,
  },
  {
    id: 'side-stripe-card',
    severity: 'warn',
    label: 'Thick left side-stripe card',
    why: '4-6px coloured left border is very 2018-SaaS-AI.',
    fix: 'Hairline border all around, or a small accent square beside the heading.',
    re: /border-left\s*:\s*(?:[4-9]px|[1-9]\dpx)/,
  },
  {
    id: 'transition-all',
    severity: 'warn',
    label: 'transition-all',
    why: 'Animates everything indiscriminately; a lazy transition signature.',
    fix: 'Transition specific properties (opacity, transform, color).',
    re: /transition-all|transition\s*:\s*all/,
  },
  {
    id: 'bounce-easing',
    severity: 'warn',
    label: 'Bounce/elastic easing',
    why: 'Overshoot springs read as toy-like AI motion.',
    fix: 'Exponential ease-out, specific properties, no wobble.',
    re: /cubic-bezier\(\s*0\.3[45]\s*,\s*1\.5[6-9]/,
  },
];

/** AI-corporate copy clichés (Antidote). Word-boundary, case-insensitive. */
export const COPY_CLICHES: Array<{ phrase: string; re: RegExp }> = [
  { phrase: 'Supercharge', re: /\bsupercharge[sd]?\b/i },
  { phrase: 'Seamless(ly)', re: /\bseamless(ly)?\b/i },
  { phrase: 'Unleash', re: /\bunleash(?:es|ed|ing)?\b/i },
  { phrase: 'Game-changer', re: /\bgame-?chang(?:er|ing)\b/i },
  { phrase: 'Next-gen', re: /\bnext-?gen(?:eration)?\b/i },
  { phrase: 'All-in-one platform', re: /\ball-in-one platform\b/i },
  { phrase: 'Revolutionize', re: /\brevolution(?:ize|izing|ises?)\b/i },
  { phrase: 'Empower', re: /\bempower(?:s|ed|ing)?\b/i },
  { phrase: 'Elevate your', re: /\belevate your\b/i },
  { phrase: 'Trusted by', re: /\btrusted by\b/i },
];

/** Fake placeholder names (Antidote). */
export const PLACEHOLDER_NAMES: Array<{ phrase: string; re: RegExp }> = [
  { phrase: 'Acme Corp', re: /\bAcme\s?(Corp|Inc|Co)\b/i },
  { phrase: 'Jane Doe / John Smith', re: /\b(?:Jane\s?Doe|John\s?Smith)\b/i },
  { phrase: 'Lorem ipsum', re: /\bLorem ipsum\b/i },
  { phrase: '⭐ 4.9 from 10k users', re: /\b\d\.\d\s*(?:\/\s*5\s*)?(?:from|by)\s*\d+\s*k?\s*users\b/i },
];

export function rulesFor(): SlopRule[] {
  return RULES;
}
