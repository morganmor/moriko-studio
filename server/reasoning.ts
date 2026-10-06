import type { StreamParams } from './sse.js';
import {
  isCataloguedProvider,
  lookupExactProviderModel,
  lookupModelMetadata,
  modelWideEfforts,
  type ModelMeta,
} from './modelMetadata.js';

/**
 * Central reasoning-effort normalization.
 *
 * Every provider family exposes a different "how hard should the model
 * think" knob (OpenAI `reasoning_effort`, DeepSeek's clamped ladder,
 * Anthropic/Gemini token budgets), and vocabularies drift per release. All
 * of that lives HERE as data; adapters just call `applyReasoning*` and stay
 * dumb. Unknown levels resolve to the nearest supported value on a family's
 * ladder, so any UI choice works on any provider without per-vendor
 * if-trees — and genuinely unsupported choices surface as provider errors,
 * never silent misconfiguration.
 */

export type ReasoningLevel = NonNullable<StreamParams['settings']['thinkingLevel']>;

/** Canonical order, weakest → strongest. */
const LADDER: readonly ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const index = (level: ReasoningLevel): number => LADDER.indexOf(level);

/** The nearest supported level on a family ladder (ties resolve downward). */
function nearest(ladder: readonly ReasoningLevel[], level: ReasoningLevel): ReasoningLevel {
  const target = index(level);
  return ladder.reduce((best, candidate) => {
    const d = Math.abs(index(candidate) - target);
    const bestD = Math.abs(index(best) - target);
    return d < bestD ? candidate : best;
  });
}

/**
 * models.dev's effort spelling → our canonical level. `none` is the catalog's
 * word for "no reasoning" and maps to `off`; every other value is identical.
 * `default` (2 models) is a provider-default marker, not a level, and is
 * dropped — it names no amount of effort.
 */
const FROM_MODELS_DEV: Record<string, ReasoningLevel> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * THE MODEL'S OWN LADDER, straight from models.dev.
 *
 * The family ladders below are guesses made from a model name and a base URL;
 * models.dev publishes the real answer per provider+model, and it genuinely
 * differs — the same `deepseek-v4.1-flash` id is catalogued as
 * `[high, xhigh]` on one gateway, `[none, high]` on another and
 * `[low, medium, high]` on a third. Clamping against a guessed ladder is how
 * a UI choice got silently rewritten to a DIFFERENT level (picking Medium
 * landed on Low, because the guessed DeepSeek ladder had no medium at all).
 *
 * Resolution, in order:
 *  1. the provider IS catalogued AND published an entry for this model → that
 *     entry's ladder (the gateway's truth, restrictions included),
 *  2. otherwise → the model's own capability: the union of every catalogued
 *     deployment's vocabulary for that model id. This covers a custom gateway
 *     (nothing published) and a catalogued one that has not listed the model
 *     yet — in both cases the gateway has told us nothing to hide by,
 *  3. the catalog knows the model and says it does not reason → `['off']`,
 *     which makes the caller omit the parameter entirely,
 *  4. nothing catalogued at all → null — the caller sends the user's level
 *     verbatim. The catalog made no promise, so the harness invents none.
 *
 * The client mirrors these tiers exactly (thinkingLadderFor in
 * src/lib/modelMeta.ts): the dropdown and the wire must never disagree.
 */
export function modelEffortLadder(
  model: string,
  providerId?: string,
): readonly ReasoningLevel[] | null {
  if (providerId && isCataloguedProvider(providerId)) {
    const exact = lookupExactProviderModel(providerId, model);
    if (exact) {
      if (exact.reasoning !== true) return ['off'];
      const ladder = effortLadderFromMeta(exact);
      if (ladder) return ladder;
    }
  }
  const wide = effortLadderFromEfforts(modelWideEfforts(model));
  if (wide) return wide;
  const tolerant = lookupModelMetadata(model);
  if (tolerant && tolerant.reasoning !== true) return ['off'];
  return null;
}

/**
 * The mapping itself, separated from the lookup so tests can pin the rules
 * without depending on what the live catalog happens to contain today.
 */
export function effortLadderFromMeta(meta: ModelMeta | undefined): readonly ReasoningLevel[] | null {
  if (!meta || meta.reasoning !== true) return null;
  return effortLadderFromEfforts(meta.efforts);
}

/** models.dev's raw effort vocabulary → canonical levels, weakest → strongest. */
export function effortLadderFromEfforts(
  efforts: readonly string[] | null | undefined,
): readonly ReasoningLevel[] | null {
  if (!efforts || efforts.length === 0) return null;
  const mapped = new Set<ReasoningLevel>();
  for (const value of efforts) {
    const level = FROM_MODELS_DEV[String(value).trim().toLowerCase()];
    if (level) mapped.add(level);
  }
  if (mapped.size === 0) return null;
  return LADDER.filter((level) => mapped.has(level));
}

/**
 * Sets `reasoning_effort` on an OpenAI-compatible request body.
 *
 * THREE RULES. No name-based family guesses, no invented protocol fields:
 *  - 'off' omits the field entirely — the provider applies its own default.
 *    A model that always reasons keeps reasoning: that is the model's
 *    nature, known to anyone who read its card. No switch is invented, no
 *    level is floored.
 *  - a level on the model's CATALOGUED ladder (models.dev, the same ladder
 *    the UI offers) is clamped to the nearest listed level.
 *  - anything else is sent VERBATIM — the user chose it; the provider that
 *    accepts or rejects it answers directly, and its error is relayed as-is.
 */
export function applyReasoningEffort(
  body: Record<string, unknown>,
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  providerId?: string,
): void {
  if (level === 'off') return;
  const catalogued = modelEffortLadder(model, providerId);
  if (!catalogued) {
    body.reasoning_effort = level;
    return;
  }
  const resolved = nearest(catalogued, level);
  if (resolved !== 'off') body.reasoning_effort = resolved;
}

/**
 * Tag patterns for inline reasoning that some models emit INSIDE the
 * `content` (or `tool_call.arguments`) stream instead of using the separate
 * `reasoning_content` channel — GLM-5.3 at 70k+ context is the documented
 * offender. The scrub must be safe to run on a FRAGMENT: a thinking block
 * can open in one delta and close in a later one, so a partial-open or a
 * partial-close has to survive until the rest arrives.
 *
 * `\1` backreferences the TAG NAME (group 1), not the inner text — that is
 * what makes `(Authored thinking)…(closing matching tag)` pair correctly
 * while a mismatched pair does not.
 */
const THINK_FULL = /<(think|thought|thinking)>([\s\S]*?)<\/\1>/gi;
const THINK_OPEN = /<(think|thought|thinking)>([\s\S]*)$/i;
const THINK_CLOSE = /^([\s\S]*?)<\/(?:think|thought|thinking)>/i;
const ANY_THINK_TAG = /<\/?(?:think|thought|thinking)>/i;
/** Unanchored opener — locates where reasoning COULD begin in a fragment. */
const THINK_OPENER = /<(?:think|thought|thinking)>/i;
/** Every lone tag, anywhere — for whole-string cleanup passes. */
export const ALL_THINK_TAGS = /<\/?(?:think|thought|thinking)>/gi;

/** Every spelling whose prefix could still grow into a complete tag. */
const THINK_TAG_SPELLINGS = ['<think>', '</think>', '<thought>', '</thought>', '<thinking>', '</thinking>'];

/**
 * The longest suffix of `s` that is a strict prefix of a think tag — i.e.
 * the fragment ended mid-tag (`…<thi`). Held back until the next delta
 * proves it out: a tag split across deltas must never leak as visible text.
 */
function partialThinkTagTail(s: string): string {
  for (let k = Math.min(s.length, 10); k >= 1; k -= 1) {
    const suffix = s.slice(-k);
    if (!suffix.startsWith('<')) continue;
    if (THINK_TAG_SPELLINGS.some((tag) => tag.length > k && tag.startsWith(suffix))) return suffix;
  }
  return '';
}

/**
 * Per-stream scrub state. One instance per content channel and one per
 * tool-call index; owned by the adapter's round, reset every round.
 */
export interface ThinkingScrubState {
  /** True while a block opened in an earlier fragment is still unclosed. */
  inside: boolean;
  /** Trailing partial-tag characters held back from the previous fragment. */
  tail: string;
}

export function createThinkingScrubState(): ThinkingScrubState {
  return { inside: false, tail: '' };
}

/**
 * Removes tag-wrapped reasoning from a STREAM FRAGMENT, advancing `state`.
 *
 *  - NOT inside, no tags → plain text, byte-identical pass-through (except a
 *    partial tag at the very end, which is held back until proven out).
 *  - NOT inside, `<x>…</x>` → inner text routed to reasoning, prose around it
 *    kept in text.
 *  - NOT inside, `<x>` unclosed → everything after the tag is reasoning; the
 *    `inside` bit carries across fragments.
 *  - NOT inside, stray `</x>` (a close with no open — the model echoing a
 *    boundary for a block that was already routed) → the tag is dropped, the
 *    prose around it kept. Left alone it would render as a raw HTML block and
 *    swallow the rest of the paragraph's formatting.
 *  - INSIDE → everything up to the closing tag is reasoning (a partial close
 *    at the tail is held back, so a `</thi` + `nk>` split across deltas still
 *    ends the block instead of streaming the rest of the answer as thinking).
 *
 * Returns `reasoning` separately so the adapter can route the leaked thinking
 * to the reasoning strip instead of deleting it — the UI keeps showing the
 * model's actual thinking, just on the right channel.
 */
export function scrubInlineThinkingFragment(
  fragment: string,
  state: ThinkingScrubState,
): { text: string | null; reasoning: string | null } {
  let work = state.tail ? state.tail + fragment : fragment;
  state.tail = '';
  if (!work) return { text: null, reasoning: null };

  const text: string[] = [];
  const reasoning: string[] = [];

  if (!state.inside && work.includes('</')) {
    const hasBlock = THINK_FULL.test(work);
    THINK_FULL.lastIndex = 0;
    if (!hasBlock) {
      const openPos = work.search(THINK_OPENER);
      const limit = openPos === -1 ? work.length : openPos;
      work = work.slice(0, limit).replace(ALL_THINK_TAGS, '') + work.slice(limit);
    }
    if (!work) return { text: null, reasoning: null };
  }

  if (!state.inside && !ANY_THINK_TAG.test(work)) {
    const hold = partialThinkTagTail(work);
    if (hold) {
      state.tail = hold;
      work = work.slice(0, work.length - hold.length);
    }
    return { text: work || null, reasoning: null };
  }

  while (work.length > 0) {
    if (!state.inside) {
      // silently miss the tag entirely (the reasoning-leak bug).
      const fullAt = work.search(THINK_FULL);
      const openAt = work.search(THINK_OPEN);
      THINK_FULL.lastIndex = 0;
      THINK_OPEN.lastIndex = 0;

      const take = fullAt !== -1 && (openAt === -1 || fullAt <= openAt) ? 'full' : openAt !== -1 ? 'open' : 'none';

      if (take === 'none') {
        const hold = partialThinkTagTail(work);
        if (hold) state.tail = hold;
        const out = hold ? work.slice(0, work.length - hold.length) : work;
        if (out) text.push(out);
        break;
      }

      if (take === 'full') {
        const before = work.slice(0, fullAt);
        if (before) text.push(before);
        const match = THINK_FULL.exec(work.slice(fullAt));
        if (match) {
          if (match[2].trim()) reasoning.push(match[2].trim());
          work = work.slice(fullAt + match[0].length);
        } else {
          work = work.slice(fullAt + 1);
        }
        THINK_FULL.lastIndex = 0;
        continue;
      }

      const before = work.slice(0, openAt);
      if (before) text.push(before);
      const opener = work.slice(openAt).match(THINK_OPENER);
      work = opener ? work.slice(openAt + opener[0].length) : work.slice(openAt + 1);
      state.inside = true;
      continue;
    }

    const closed = work.match(THINK_CLOSE);
    if (closed) {
      if (closed[1].trim()) reasoning.push(closed[1].trim());
      work = work.slice(closed[0].length);
      state.inside = false;
      continue;
    }

    const closeHold = partialThinkTagTail(work);
    if (closeHold.startsWith('</')) {
      const done = work.slice(0, work.length - closeHold.length);
      if (done.trim()) reasoning.push(done.trim());
      state.tail = closeHold;
      break;
    }

    if (work.trim()) reasoning.push(work.trim());
    break;
  }

  return {
    text: text.length > 0 ? text.join('') : null,
    reasoning: reasoning.length > 0 ? reasoning.join('\n') : null,
  };
}

/**
 * End of round: a held-back tail that never became a tag is ordinary text —
 * hand it back so nothing the model actually sent is ever swallowed. An
 * unclosed block simply ends with the round (its content was already routed
 * to reasoning fragment by fragment).
 */
export function flushThinkingScrub(state: ThinkingScrubState): string | null {
  const tail = state.tail;
  state.tail = '';
  state.inside = false;
  return tail || null;
}

/** Whole-message version (for a finished buffer): splits reasoning out. */
export function splitInlineThinking(content: string): {
  content: string;
  reasoning: string;
} {
  const reasoningParts: string[] = [];
  let rest = content.replace(THINK_FULL, (_match, _tag: string, inner: string) => {
    if (inner.trim()) reasoningParts.push(inner.trim());
    return '';
  });
  const unclosed = rest.match(THINK_OPEN);
  if (unclosed?.index !== undefined) {
    const tail = unclosed[2];
    const closed = tail.match(THINK_CLOSE);
    if (closed) {
      if (closed[1].trim()) reasoningParts.push(closed[1].trim());
      rest = rest.slice(0, unclosed.index) + tail.slice(closed[0].length);
    } else {
      if (tail.trim()) reasoningParts.push(tail.trim());
      rest = rest.slice(0, unclosed.index);
    }
  }
  rest = rest.replace(ALL_THINK_TAGS, '');
  return { content: rest.trim(), reasoning: reasoningParts.join('\n\n').trim() };
}

/**
 * Budget-style reasoning knobs (Anthropic `budget_tokens`, Gemini
 * `thinkingBudget`) are never hard-coded: the ceiling is the MODEL's own
 * max-output limit from the metadata snapshot, and the level picks a
 * proportion of that ceiling. A 64k-output model and a 512k-output model
 * therefore get genuinely different budgets for the same "High" setting —
 * the budget always follows the provider/model, never a fixed constant.
 */
const BUDGET_SHARE: Record<Exclude<ReasoningLevel, 'off'>, number> = {
  minimal: 0.02,
  low: 0.05,
  medium: 0.15,
  high: 0.3,
  xhigh: 0.5,
  max: 0.8,
};

/** Floors keep tiny models from producing budgets the API round-trips to 0. */
const MIN_ANTHROPIC_BUDGET = 1024;
const MIN_GEMINI_BUDGET = 512;

/**
 * Resolves the model's max-output limit for budget scaling. Falls back to a
 * conservative default only when the snapshot has no entry at all — the
 * fallback is a floor, not a budget: real models always scale above it.
 */
function maxOutputFor(model: string, _baseUrl: string): number {
  const meta = lookupModelMetadata(model);
  return meta?.maxOut ?? 8192;
}

/** Anthropic `thinking.budget_tokens`, or undefined when reasoning is off. */
export function anthropicThinkingBudget(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): number | undefined {
  if (level === 'off') return undefined;
  const ceiling = maxOutputFor(model, baseUrl);
  const budget = Math.floor(ceiling * BUDGET_SHARE[level]);
  return Math.min(Math.max(budget, MIN_ANTHROPIC_BUDGET), Math.max(ceiling - 512, MIN_ANTHROPIC_BUDGET));
}

/** Gemini `thinkingConfig.thinkingBudget`; 0 disables thinking outright. */
export function geminiThinkingBudget(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): number {
  if (level === 'off') return 0;
  const ceiling = maxOutputFor(model, baseUrl);
  return Math.max(Math.floor(ceiling * BUDGET_SHARE[level]), MIN_GEMINI_BUDGET);
}

/**
 * Test-only think tags. A transport that scrubs inline reasoning (Moriko's
 * own stream included) eats a COMPLETE tag written literally into source —
 * the earlier fixtures here arrived on disk stripped of theirs, which is how
 * the silent-mangling failure mode was caught. Composition from plain
 * constants is immune: the tag strings are built at runtime, never typed.
 */
const T_OPEN = '<' + 'thinking' + '>';
const T_CLOSE = '</' + 'thinking' + '>';
const U_OPEN = '<' + 'think' + '>';

/**
 * Self-test for the fragment scrubber. Run with
 * `MORIKO_TEST_REASONING=1 npx tsx server/reasoning.ts`. The cases cover the
 * failure modes seen at 70k+ context: complete blocks, blocks split across
 * fragments, a TAG SPLIT ACROSS DELTAS (open or close — the old scrubber
 * leaked or swallowed on these), stray closing tags, unclosed blocks,
 * near-tag text that must never be held, and the end-of-round flush that
 * returns a held-back tail that never became a tag.
 */
export function runScrubs(): void {
  const cases: Array<{
    name: string;
    fragments: string[];
    expectText: string;
    expectReasoning: string;
  }> = [
    {
      name: 'plain text passes through untouched',
      fragments: ['hello world', ' second part'],
      expectText: 'hello world second part',
      expectReasoning: '',
    },
    {
      name: 'complete block in one fragment',
      fragments: [`before ${T_OPEN}secret thought${T_CLOSE} after`],
      expectText: 'before  after',
      expectReasoning: 'secret thought',
    },
    {
      name: 'block split across fragments',
      fragments: [`start ${T_OPEN}`, ' thinking here', ` and then${T_CLOSE}`, ' done after'],
      expectText: 'start  done after',
      expectReasoning: 'thinking here\nand then',
    },
    {
      name: 'opening tag split across deltas',
      fragments: ['head <thi', 'nk>secret body', `${T_CLOSE} tail`],
      expectText: 'head  tail',
      expectReasoning: 'secret body',
    },
    {
      name: 'closing tag split across deltas',
      fragments: [`body ${T_OPEN}secret`, ' tail</thi', 'nk> after'],
      expectText: 'body  after',
      expectReasoning: 'secret\ntail',
    },
    {
      name: 'unclosed block runs to end of round',
      fragments: [`visible ${T_OPEN}hidden thinking`, ' still hidden'],
      expectText: 'visible ',
      expectReasoning: 'hidden thinking\nstill hidden',
    },
    {
      name: 'stray closing tag with no opener is dropped, prose kept',
      fragments: [`prose ${T_CLOSE} more prose`],
      expectText: 'prose  more prose',
      expectReasoning: '',
    },
    {
      name: 'lt followed by non-tag text is never swallowed',
      fragments: ['a < b', ' and c > d'],
      expectText: 'a < b and c > d',
      expectReasoning: '',
    },
    {
      name: 'bare lt at a fragment boundary resolves in order',
      fragments: ['x <', 'y'],
      expectText: 'x <y',
      expectReasoning: '',
    },
    {
      name: 'mismatched names still close the open block',
      fragments: [`p ${U_OPEN}inner${T_CLOSE} q`],
      expectText: 'p  q',
      expectReasoning: 'inner',
    },
    {
      name: 'held tail that never becomes a tag is flushed as text',
      fragments: ['done <thi'],
      expectText: 'done <thi',
      expectReasoning: '',
    },
    {
      name: 'reasoning leak inside tool args json',
      fragments: ['{"path": "src/f', `${U_OPEN}leaked into args${T_CLOSE}`, 'inal.ts"}'],
      expectText: '{"path": "src/final.ts"}',
      expectReasoning: 'leaked into args',
    },
  ];

  let failures = 0;
  for (const c of cases) {
    let text = '';
    let reasoning = '';
    const state = createThinkingScrubState();
    for (const fragment of c.fragments) {
      const out = scrubInlineThinkingFragment(fragment, state);
      if (out.text) text += out.text;
      if (out.reasoning) reasoning += (reasoning ? '\n' : '') + out.reasoning;
    }
    const tail = flushThinkingScrub(state);
    if (tail) text += tail;
    if (text !== c.expectText || reasoning !== c.expectReasoning) {
      failures += 1;
      console.error(`FAIL ${c.name}`);
      console.error(`  text:      ${JSON.stringify(text)} (want ${JSON.stringify(c.expectText)})`);
      console.error(`  reasoning: ${JSON.stringify(reasoning)} (want ${JSON.stringify(c.expectReasoning)})`);
    }
  }

  const whole = splitInlineThinking(`answer ${T_OPEN}deep${T_CLOSE} after stray ${T_CLOSE} end`);
  if (whole.content !== 'answer  after stray  end' || whole.reasoning !== 'deep') {
    failures += 1;
    console.error('FAIL splitInlineThinking whole-message case');
    console.error(`  content:   ${JSON.stringify(whole.content)}`);
    console.error(`  reasoning: ${JSON.stringify(whole.reasoning)}`);
  }
  const unclosedWhole = splitInlineThinking(`x ${T_OPEN}hidden tail`);
  if (unclosedWhole.content !== 'x' || unclosedWhole.reasoning !== 'hidden tail') {
    failures += 1;
    console.error('FAIL splitInlineThinking unclosed case');
    console.error(`  content:   ${JSON.stringify(unclosedWhole.content)}`);
    console.error(`  reasoning: ${JSON.stringify(unclosedWhole.reasoning)}`);
  }

  const total = cases.length + 2;
  if (failures === 0) console.log(`reasoning scrubber: ${total} cases passed`);
  else process.exitCode = 1;
}

if (process.env.MORIKO_TEST_REASONING === '1') {
  runScrubs();
}
