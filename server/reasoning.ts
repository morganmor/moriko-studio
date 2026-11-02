import type { StreamEvent } from './contracts.js';
import type { StreamHandler, StreamParams } from './sse.js';
import {
  createThinkingScrubState,
  flushNativeReasoning,
  flushThinkingScrub,
  scrubThinkingFragment,
  splitInlineThinking,
  type ReasoningChannel,
  type ThinkingScrubState,
} from '../src/lib/reasoningLexer.js';
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

/** Whether the catalog knows this model to reason at all. */
export function modelReasons(model: string, providerId?: string): boolean {
  const ladder = modelEffortLadder(model, providerId);
  if (ladder) return ladder.some((level) => level !== 'off');
  return lookupModelMetadata(model)?.reasoning === true;
}

/**
 * THE SWITCHES THAT ACTUALLY TURN THINKING OFF.
 *
 * `applyReasoningEffort` omitting `reasoning_effort` is not "off": every
 * thinking-first family ships with thinking ENABLED by default, so omitting
 * the knob quietly reasons at the provider default (DeepSeek documents
 * thinking-on as the default; its Chat Completions switch is the separate
 * `thinking` object). Each vendor gets its documented disable control here,
 * never an invented field, and only when the catalog says the model reasons
 * — an endpoint we know nothing about is left alone.
 */
interface ThinkingOffVendor {
  id: string;
  matches: RegExp;
  apply: (body: Record<string, unknown>) => void;
}

const THINKING_OFF_VENDORS: readonly ThinkingOffVendor[] = [
  {
    id: 'deepseek',
    matches: /deepseek|dpsk/i,
    apply: (body) => {
      body.thinking = { type: 'disabled' };
    },
  },
  {
    id: 'chat-template',
    matches: /moonshot|kimi|zhipu|glm|minimax|qwen|vllm|sglang|baseten/i,
    apply: (body) => {
      const existing = body.chat_template_kwargs;
      body.chat_template_kwargs = {
        ...(existing && typeof existing === 'object' && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {}),
        enable_thinking: false,
      };
    },
  },
];

/** Which vendor's thinking-off control applies to this endpoint, if any. */
function thinkingOffVendor(model: string, providerId: string | undefined, baseUrl?: string): ThinkingOffVendor | undefined {
  const identity = `${providerId ?? ''} ${model} ${baseUrl ?? ''}`;
  const vendor = THINKING_OFF_VENDORS.find((entry) => entry.matches.test(identity));
  if (!vendor) return undefined;
  return modelReasons(model, providerId) ? vendor : undefined;
}

/**
 * Sets the provider's own thinking-off control when the model reasons by
 * default. Exported so the branch is testable without a live provider.
 */
export function applyThinkingDisabled(
  body: Record<string, unknown>,
  model: string,
  providerId?: string,
  baseUrl?: string,
): void {
  thinkingOffVendor(model, providerId, baseUrl)?.apply(body);
}

/**
 * Whether this endpoint documents `reasoning_content` as a REPLAY field on
 * assistant history.
 *
 * DeepSeek's tool contract makes it mandatory — an assistant turn without the
 * field is a 400, even when the turn has no thought to give back — so the
 * field must be fabricated as an empty string there. Every other family we
 * speak to does not accept the key on input, and inventing it would create the
 * exact error it is meant to prevent. Stored reasoning is replayed when it
 * exists for any thinking model; only the EMPTY one is vendor-gated.
 */
export function replaysReasoningContent(
  model: string,
  providerId?: string,
  baseUrl?: string,
): boolean {
  if (!modelReasons(model, providerId)) return false;
  return /deepseek|dpsk/i.test(`${providerId ?? ''} ${model} ${baseUrl ?? ''}`);
}

/**
 * Whether this request will actually think: the user asked for reasoning and
 * the model is capable of it. Used by adapters that must drop sampling knobs
 * the provider ignores or rejects in thinking mode.
 */
export function thinkingActive(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  providerId?: string,
): boolean {
  if (!level || level === 'off') return false;
  return modelReasons(model, providerId);
}

/**
 * DeepSeek's thinking mode ignores `temperature` (all sampling penalties) and
 * fixes `top_p` for V4 Pro with tools. Sending them is not an error, but it
 * misreports what the request controls — so they are omitted instead.
 */
export function thinkingSuppressesSampling(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  providerId?: string,
  baseUrl?: string,
): boolean {
  if (!thinkingActive(level, model, providerId)) return false;
  return /deepseek|dpsk/i.test(`${providerId ?? ''} ${model} ${baseUrl ?? ''}`);
}

/**
 * Sets `reasoning_effort` on an OpenAI-compatible request body.
 *
 * THREE RULES. No name-based family guesses, no invented protocol fields:
 *  - 'off' sends the provider's own thinking-off control (see
 *    THINKING_OFF_VENDORS) — omitting the field is NOT off, because
 *    thinking-first models keep thinking at their default effort.
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
  baseUrl?: string,
): void {
  if (level === 'off') {
    applyThinkingDisabled(body, model, providerId, baseUrl);
    return;
  }
  const catalogued = modelEffortLadder(model, providerId);
  if (!catalogued) {
    body.reasoning_effort = level;
    return;
  }
  const resolved = nearest(catalogued, level);
  if (resolved !== 'off') body.reasoning_effort = resolved;
}

/**
 * The lexer itself lives in `src/lib/reasoningLexer.ts` because the CLIENT
 * needs it too: a finished reply is re-split with the same rules the stream
 * used, and a boundary must never differ between what streamed and what is
 * replayed. Re-exported here so adapters keep importing one module.
 */
export {
  createThinkingScrubState,
  flushNativeReasoning,
  flushThinkingScrub,
  scrubThinkingFragment,
  splitInlineThinking,
  type ReasoningChannel,
  type ThinkingScrubState,
};

/* ------------------------------------------------------------------------- *
 * BLOCK LIFECYCLE
 *
 * Reasoning is a BLOCK, not a flat delta channel: it opens, it streams, and
 * it closes — before the answer starts, before a tool call, or at the end of
 * the round. The client needs those boundaries to render one strip per block
 * and to stop guessing "the reasoning ended because a different segment type
 * arrived". One emitter per run; ids are stable, so the same block keeps its
 * identity across the whole stream.
 * ------------------------------------------------------------------------- */

export interface ReasoningBlockEmitter {
  /** Route reasoning text, opening the block on first use. */
  push: (text: string | null | undefined) => void;
  /** Close the open block exactly once. Safe to call when nothing is open. */
  end: () => void;
}

export function createReasoningBlockEmitter(onEvent: StreamHandler): ReasoningBlockEmitter {
  let counter = 0;
  let openId: string | null = null;
  return {
    push(text) {
      if (!text) return;
      if (openId === null) {
        counter += 1;
        openId = `reason-${counter}`;
        onEvent({ type: 'reasoning_start', blockId: openId } satisfies StreamEvent);
      }
      onEvent({ type: 'reasoning', delta: text, blockId: openId } satisfies StreamEvent);
    },
    end() {
      if (openId === null) return;
      const id = openId;
      openId = null;
      onEvent({ type: 'reasoning_end', blockId: id } satisfies StreamEvent);
    },
  };
}

/**
 * Budget-style reasoning knobs (Anthropic `budget_tokens`, Gemini
 * `thinkingBudget`) are never hard-coded: the ceiling is the MODEL's own
 * max-output limit from the metadata snapshot, and the level picks a
 * proportion of that ceiling. A 64k-output model and a 512k-output model
 * therefore get genuinely different budgets for the same "High" setting.
 * `max` asks for the model's FULL allowance and is then capped by the tuned
 * provider tops below — Anthropic 128K, Gemini 64K (claude-opus-latest maxOut
 * is 128,000; Gemini's is 65,536 — Max lands exactly on both).
 */
const BUDGET_SHARE: Record<Exclude<ReasoningLevel, 'off'>, number> = {
  minimal: 0.02,
  low: 0.05,
  medium: 0.15,
  high: 0.3,
  xhigh: 0.5,
  max: 1,
};

/** Floors keep tiny models from producing budgets the API round-trips to 0. */
const MIN_ANTHROPIC_BUDGET = 1024;
const MIN_GEMINI_BUDGET = 512;

/** Tuned provider thinking tops: Anthropic 128K, Gemini 64K. */
const ANTHROPIC_TOP_THINKING = 128_000 - 1024;
const GEMINI_TOP_THINKING = 65_536;

/**
 * Resolves the model's max-output limit for budget scaling. Falls back to
 * 32,768 when the snapshot has no entry — the same default window the
 * Anthropic adapter sends, so an unknown model still gets a real budget
 * instead of a token-sized one (it used to be 8,192, which shrank every
 * level of the ladder to nothing).
 */
function maxOutputFor(model: string, _baseUrl: string): number {
  const meta = lookupModelMetadata(model);
  return meta?.maxOut ?? 32_768;
}

/**
 * Anthropic's required `max_tokens` when the user picked Max. Reasoning lives
 * INSIDE this one window (completion_tokens counts thinking too), so Max = the
 * model's full ceiling covering reasoning + answer together. Unknown model →
 * 32,768: the API demands the field — it can never be omitted.
 */
export function anthropicMaxOutput(model: string): number {
  return lookupModelMetadata(model)?.maxOut ?? 32_768;
}

/** Anthropic `thinking.budget_tokens`, or undefined when reasoning is off. */
export function anthropicThinkingBudget(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): number | undefined {
  if (level === 'off') return undefined;
  const ceiling = maxOutputFor(model, baseUrl);
  const top = Math.max(
    Math.min(ANTHROPIC_TOP_THINKING, ceiling - 1024),
    MIN_ANTHROPIC_BUDGET,
  );
  const budget = Math.floor(ceiling * BUDGET_SHARE[level]);
  return Math.min(Math.max(budget, MIN_ANTHROPIC_BUDGET), top);
}

/** Gemini `thinkingConfig.thinkingBudget`; 0 disables thinking outright. */
export function geminiThinkingBudget(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): number {
  if (level === 'off') return 0;
  const ceiling = maxOutputFor(model, baseUrl);
  const top = Math.max(Math.min(GEMINI_TOP_THINKING, ceiling), MIN_GEMINI_BUDGET);
  return Math.min(Math.max(Math.floor(ceiling * BUDGET_SHARE[level]), MIN_GEMINI_BUDGET), top);
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
const U_CLOSE = '</' + 'think' + '>';
const R_OPEN = '<' + 'reason' + 'ing>';
const FENCE = '`' + '`' + '`';

/**
 * Self-test for the lexer. Run with
 * `MORIKO_TEST_REASONING=1 npx tsx server/reasoning.ts`.
 *
 * The cases pin the two failure directions that produced the "the model is
 * bad at opening/closing reasoning" reports: a tag the model QUOTES must
 * never open a block or cut the answer short, and a channel that IS reasoning
 * must never be split by a closer it merely mentions.
 */
export function runScrubs(): void {
  const cases: Array<{
    name: string;
    fragments: string[];
    expectText: string;
    expectReasoning: string;
    channel?: ReasoningChannel;
  }> = [
    {
      name: 'plain text passes through untouched',
      fragments: ['hello world', ' second part'],
      expectText: 'hello world second part',
      expectReasoning: '',
    },
    {
      name: 'opener at stream start opens a block',
      fragments: [T_OPEN + 'secret', ' body' + T_CLOSE + ' after'],
      expectText: ' after',
      expectReasoning: 'secret body',
    },
    {
      name: 'leading whitespace may precede the opener',
      fragments: ['\n  ' + T_OPEN + 'secret' + T_CLOSE + ' answer'],
      expectText: '\n   answer',
      expectReasoning: 'secret',
    },
    {
      name: 'opener after prose is quoted text, never a block',
      fragments: ['Sure. ' + T_OPEN + 'nope' + T_CLOSE + ' done'],
      expectText: 'Sure. ' + T_OPEN + 'nope' + T_CLOSE + ' done',
      expectReasoning: '',
    },
    {
      name: 'opening tag split across deltas',
      fragments: ['<thi', 'nking>secret body', U_CLOSE + ' tail'],
      expectText: ' tail',
      expectReasoning: 'secret body',
    },
    {
      name: 'closing tag split across deltas',
      fragments: [U_OPEN + 'secret', ' tail</thi', 'nk> after'],
      expectText: ' after',
      expectReasoning: 'secret tail',
    },
    {
      name: 'closer inside inline code does NOT close the block',
      fragments: [
        T_OPEN + 'he wrote `' + T_CLOSE + '` as an example',
        ' and kept thinking' + U_CLOSE + ' visible',
      ],
      expectText: ' visible',
      expectReasoning: 'he wrote `' + T_CLOSE + '` as an example and kept thinking',
    },
    {
      name: 'closer inside a fenced block does NOT close the block',
      fragments: [
        T_OPEN + 'sample:\n' + FENCE + '\n' + T_CLOSE + '\n' + FENCE + '\nstill reasoning',
        U_CLOSE + ' answer',
      ],
      expectText: ' answer',
      expectReasoning: 'sample:\n' + FENCE + '\n' + T_CLOSE + '\n' + FENCE + '\nstill reasoning',
    },
    {
      name: 'closer inside quotes does NOT close the block',
      fragments: [
        T_OPEN + 'the tag "' + T_CLOSE + '" is literal',
        ' keep going' + U_CLOSE + ' end',
      ],
      expectText: ' end',
      expectReasoning: 'the tag "' + T_CLOSE + '" is literal keep going',
    },
    {
      name: 'apostrophe before a closer does not swallow the answer',
      fragments: [T_OPEN + "Let's check the result" + T_CLOSE + ' The answer is 42.'],
      expectText: ' The answer is 42.',
      expectReasoning: "Let's check the result",
    },
    {
      name: 'an unmatched quote does not swallow the answer',
      fragments: [T_OPEN + 'he said "check' + T_CLOSE + ' The answer is 42.'],
      expectText: ' The answer is 42.',
      expectReasoning: 'he said "check',
    },
    {
      name: 'a quoted closer with an apostrophe inside stays content',
      fragments: [
        T_OPEN + 'quote "it\'s ' + T_CLOSE + ' here" then keep going' + U_CLOSE + ' end',
      ],
      expectText: ' end',
      expectReasoning: 'quote "it\'s ' + T_CLOSE + ' here" then keep going',
    },
    {
      name: 'escaped closer is not a boundary',
      fragments: [T_OPEN + 'try \\' + T_CLOSE + ' here', ' more' + U_CLOSE + ' x'],
      expectText: ' x',
      expectReasoning: 'try \\' + T_CLOSE + ' here more',
    },
    {
      name: 'unclosed block runs to end of round',
      fragments: [R_OPEN + 'hidden thinking', ' still hidden'],
      expectText: '',
      expectReasoning: 'hidden thinking still hidden',
    },
    {
      name: 'stray closer before any prose is dropped',
      fragments: [T_CLOSE + 'prose starts here'],
      expectText: 'prose starts here',
      expectReasoning: '',
    },
    {
      name: 'a quoted tag after prose stays in the answer',
      fragments: ['prose ' + T_CLOSE + ' more prose'],
      expectText: 'prose ' + T_CLOSE + ' more prose',
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
      fragments: [U_OPEN + 'inner' + T_CLOSE + ' q'],
      expectText: ' q',
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
      channel: 'arguments',
      fragments: ['{"path": "src/f', U_OPEN + 'leaked into args' + T_CLOSE, 'inal.ts"}'],
      expectText: '{"path": "src/final.ts"}',
      expectReasoning: 'leaked into args',
    },
    {
      name: 'native channel never splits on a closer it mentions',
      channel: 'native',
      fragments: [
        'The regex closes on ' + T_CLOSE + ' which my parser must not treat as a boundary here',
        ' and the thought continues.',
      ],
      expectText: '',
      expectReasoning:
        'The regex closes on ' + T_CLOSE + ' which my parser must not treat as a boundary here and the thought continues.',
    },
    {
      name: 'native channel strips only a leading wrapper',
      channel: 'native',
      fragments: [T_OPEN + 'wrapped thought body that is long enough'],
      expectText: '',
      expectReasoning: 'wrapped thought body that is long enough',
    },
  ];

  let failures = 0;
  for (const c of cases) {
    let text = '';
    let reasoning = '';
    const state = createThinkingScrubState(c.channel ?? 'response');
    for (const fragment of c.fragments) {
      const out = scrubThinkingFragment(fragment, state);
      if (out.text) text += out.text;
      if (out.reasoning) reasoning += out.reasoning;
    }
    const tail = state.channel === 'native' ? flushNativeReasoning(state) : flushThinkingScrub(state);
    if (tail) {
      if (state.channel === 'native') reasoning += tail;
      else text += tail;
    }
    if (text !== c.expectText || reasoning !== c.expectReasoning) {
      failures += 1;
      console.error(`FAIL ${c.name}`);
      console.error(`  text:      ${JSON.stringify(text)} (want ${JSON.stringify(c.expectText)})`);
      console.error(`  reasoning: ${JSON.stringify(reasoning)} (want ${JSON.stringify(c.expectReasoning)})`);
    }
  }

  // Whole-message split must agree with the stream lexer.
  const atStart = splitInlineThinking(T_OPEN + 'deep' + T_CLOSE + ' answer');
  if (atStart.content !== 'answer' || atStart.reasoning !== 'deep') {
    failures += 1;
    console.error('FAIL splitInlineThinking leading block');
    console.error(`  content:   ${JSON.stringify(atStart.content)}`);
    console.error(`  reasoning: ${JSON.stringify(atStart.reasoning)}`);
  }
  const lateBlock = splitInlineThinking('answer ' + T_OPEN + 'quoted' + T_CLOSE + ' end');
  if (lateBlock.content !== 'answer ' + T_OPEN + 'quoted' + T_CLOSE + ' end' || lateBlock.reasoning !== '') {
    failures += 1;
    console.error('FAIL splitInlineThinking must not split a quoted tag');
    console.error(`  content:   ${JSON.stringify(lateBlock.content)}`);
    console.error(`  reasoning: ${JSON.stringify(lateBlock.reasoning)}`);
  }
  const unclosedWhole = splitInlineThinking(T_OPEN + 'hidden tail');
  if (unclosedWhole.content !== '' || unclosedWhole.reasoning !== 'hidden tail') {
    failures += 1;
    console.error('FAIL splitInlineThinking unclosed case');
    console.error(`  content:   ${JSON.stringify(unclosedWhole.content)}`);
    console.error(`  reasoning: ${JSON.stringify(unclosedWhole.reasoning)}`);
  }

  // Thinking-off controls: a reasoning model gets a real switch, a model the
  // catalog says cannot reason gets nothing invented for it.
  const deepseekBody: Record<string, unknown> = {};
  applyThinkingDisabled(deepseekBody, 'deepseek-v4-pro', 'deepseek');
  if (JSON.stringify(deepseekBody.thinking) !== JSON.stringify({ type: 'disabled' })) {
    failures += 1;
    console.error(`FAIL thinking-off for deepseek: ${JSON.stringify(deepseekBody)}`);
  }
  const unknownBody: Record<string, unknown> = {};
  applyThinkingDisabled(unknownBody, 'definitely-not-a-real-model-xyz', 'custom');
  if (Object.keys(unknownBody).length !== 0) {
    failures += 1;
    console.error(`FAIL thinking-off must not invent fields: ${JSON.stringify(unknownBody)}`);
  }

  const total = cases.length + 5;
  if (failures === 0) console.log(`reasoning lexer: ${total} cases passed`);
  else process.exitCode = 1;
}

if (process.env.MORIKO_TEST_REASONING === '1') {
  runScrubs();
}
