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



export type ReasoningLevel = NonNullable<StreamParams['settings']['thinkingLevel']>;


const LADDER: readonly ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const index = (level: ReasoningLevel): number => LADDER.indexOf(level);


function nearest(ladder: readonly ReasoningLevel[], level: ReasoningLevel): ReasoningLevel {
  const target = index(level);
  return ladder.reduce((best, candidate) => {
    const d = Math.abs(index(candidate) - target);
    const bestD = Math.abs(index(best) - target);
    return d < bestD ? candidate : best;
  });
}


const FROM_MODELS_DEV: Record<string, ReasoningLevel> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};


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


export function effortLadderFromMeta(meta: ModelMeta | undefined): readonly ReasoningLevel[] | null {
  if (!meta || meta.reasoning !== true) return null;
  return effortLadderFromEfforts(meta.efforts);
}


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


export function modelReasons(model: string, providerId?: string): boolean {
  const ladder = modelEffortLadder(model, providerId);
  if (ladder) return ladder.some((level) => level !== 'off');
  return lookupModelMetadata(model)?.reasoning === true;
}


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


function thinkingOffVendor(model: string, providerId: string | undefined, baseUrl?: string): ThinkingOffVendor | undefined {
  const identity = `${providerId ?? ''} ${model} ${baseUrl ?? ''}`;
  const vendor = THINKING_OFF_VENDORS.find((entry) => entry.matches.test(identity));
  if (!vendor) return undefined;
  return modelReasons(model, providerId) ? vendor : undefined;
}


export function applyThinkingDisabled(
  body: Record<string, unknown>,
  model: string,
  providerId?: string,
  baseUrl?: string,
): void {
  thinkingOffVendor(model, providerId, baseUrl)?.apply(body);
}


export function replaysReasoningContent(
  model: string,
  providerId?: string,
  baseUrl?: string,
): boolean {
  if (!modelReasons(model, providerId)) return false;
  return /deepseek|dpsk/i.test(`${providerId ?? ''} ${model} ${baseUrl ?? ''}`);
}


export function thinkingActive(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  providerId?: string,
): boolean {
  if (!level || level === 'off') return false;
  return modelReasons(model, providerId);
}


export function thinkingSuppressesSampling(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  providerId?: string,
  baseUrl?: string,
): boolean {
  if (!thinkingActive(level, model, providerId)) return false;
  return /deepseek|dpsk/i.test(`${providerId ?? ''} ${model} ${baseUrl ?? ''}`);
}


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


export {
  createThinkingScrubState,
  flushNativeReasoning,
  flushThinkingScrub,
  scrubThinkingFragment,
  splitInlineThinking,
  type ReasoningChannel,
  type ThinkingScrubState,
};


export interface ReasoningBlockEmitter {
  
  push: (text: string | null | undefined) => void;
  
  end: () => void;
  
  readonly lastBlockText: string;
}

export function createReasoningBlockEmitter(onEvent: StreamHandler): ReasoningBlockEmitter {
  let counter = 0;
  let openId: string | null = null;
  let current = '';
  let lastClosed = '';
  return {
    push(text) {
      if (!text) return;
      if (openId === null) {
        counter += 1;
        openId = `reason-${counter}`;
        current = '';
        onEvent({ type: 'reasoning_start', blockId: openId } satisfies StreamEvent);
      }
      current += text;
      onEvent({ type: 'reasoning', delta: text, blockId: openId } satisfies StreamEvent);
    },
    end() {
      if (openId === null) return;
      const id = openId;
      openId = null;
      if (current.trim()) lastClosed = current;
      current = '';
      onEvent({ type: 'reasoning_end', blockId: id } satisfies StreamEvent);
    },
    get lastBlockText() {
      return openId !== null ? current : lastClosed;
    },
  };
}


const BUDGET_SHARE: Record<Exclude<ReasoningLevel, 'off'>, number> = {
  minimal: 0.02,
  low: 0.05,
  medium: 0.15,
  high: 0.3,
  xhigh: 0.5,
  max: 1,
};


const MIN_ANTHROPIC_BUDGET = 1024;
const MIN_GEMINI_BUDGET = 512;


const ANTHROPIC_TOP_THINKING = 128_000 - 1024;
const GEMINI_TOP_THINKING = 65_536;


function maxOutputFor(model: string, _baseUrl: string): number {
  const meta = lookupModelMetadata(model);
  return meta?.maxOut ?? 32_768;
}


export function anthropicMaxOutput(model: string): number {
  return lookupModelMetadata(model)?.maxOut ?? 32_768;
}


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


const T_OPEN = '<' + 'thinking' + '>';
const T_CLOSE = '</' + 'thinking' + '>';
const U_OPEN = '<' + 'think' + '>';
const U_CLOSE = '</' + 'think' + '>';
const R_OPEN = '<' + 'reason' + 'ing>';
const FENCE = '`' + '`' + '`';


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
