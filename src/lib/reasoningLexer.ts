


const OPEN_TAGS: readonly string[] = ['<thinking>', '<thought>', '<reasoning>', '<' + 'think' + '>'].sort(
  (a, b) => b.length - a.length,
);

const CLOSE_TAGS: readonly string[] = ['</thinking>', '</thought>', '</reasoning>', '</' + 'think' + '>'].sort(
  (a, b) => b.length - a.length,
);

const ALL_TAGS: readonly string[] = [...OPEN_TAGS, ...CLOSE_TAGS];


export type ReasoningChannel = 'response' | 'arguments' | 'native';


type LexContext = 'prose' | 'fence' | 'inline';


export interface ThinkingScrubState {
  channel: ReasoningChannel;
  
  inside: boolean;
  
  tail: string;
  
  answered: boolean;
  context: LexContext;
  
  fence: string;
  
  inlineTicks: number;
  
  quote: string;
  
  pendingClose: string | null;
  
  pendingCloseTag: number;
  
  lineStart: boolean;
  
  nativeStarted: boolean;
  
  nativePending: string;
}

export function createThinkingScrubState(channel: ReasoningChannel = 'response'): ThinkingScrubState {
  return {
    channel,
    inside: false,
    tail: '',
    answered: false,
    context: 'prose',
    fence: '',
    inlineTicks: 0,
    quote: '',
    pendingClose: null,
    pendingCloseTag: 0,
    lineStart: true,
    nativeStarted: false,
    nativePending: '',
  };
}


function matchTagAt(text: string, i: number, tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (text.length - i < tag.length) continue;
    if (text.slice(i, i + tag.length).toLowerCase() === tag.toLowerCase()) return tag;
  }
  return null;
}


function partialTagTail(s: string, tags: readonly string[]): string {
  const longest = Math.min(s.length, Math.max(...tags.map((tag) => tag.length)) - 1);
  for (let k = longest; k >= 1; k -= 1) {
    const suffix = s.slice(-k);
    if (!suffix.startsWith('<')) continue;
    const lowered = suffix.toLowerCase();
    if (tags.some((tag) => tag.length > k && tag.toLowerCase().startsWith(lowered))) return suffix;
  }
  return '';
}


function charRunAt(text: string, i: number): { char: string; text: string } | null {
  const char = text[i];
  if (char !== '`' && char !== '~') return null;
  let end = i + 1;
  while (text[end] === char) end += 1;
  return { char, text: text.slice(i, end) };
}


function consumeReasoningChar(
  work: string,
  i: number,
  state: ThinkingScrubState,
  out: string[],
): number {
  const ch = work[i];

  if (state.channel === 'arguments') {
    out.push(ch);
    return 1;
  }

  if (ch === '\n') {
    out.push(ch);
    state.quote = '';
    if (state.context === 'inline') state.context = 'prose';
    state.lineStart = true;
    return 1;
  }

  if (state.lineStart && state.context !== 'inline') {
    const run = charRunAt(work, i);
    if (run && run.text.length >= 3) {
      out.push(run.text);
      if (state.context === 'fence' && run.char === state.fence) {
        state.context = 'prose';
        state.fence = '';
      } else if (state.context !== 'fence') {
        state.context = 'fence';
        state.fence = run.char;
      }
      state.lineStart = false;
      return run.text.length;
    }
  }

  if (ch === ' ' || ch === '\t') {
    out.push(ch);
    return 1;
  }
  state.lineStart = false;

  if (state.context === 'fence') {
    out.push(ch);
    return 1;
  }

  if (ch === '\\') {
    out.push(ch);
    const next = work[i + 1];
    if (next === undefined) return 1;
    out.push(next);
    return 2;
  }

  if (ch === '`') {
    const run = charRunAt(work, i);
    if (run) {
      if (state.context === 'inline' && run.text.length === state.inlineTicks) {
        state.context = 'prose';
        state.inlineTicks = 0;
      } else if (state.context === 'prose') {
        state.context = 'inline';
        state.inlineTicks = run.text.length;
      }
      out.push(run.text);
      return run.text.length;
    }
  }

  if ((ch === '"' || ch === "'") && state.context === 'prose') {
    out.push(ch);
    
    const prev = work[i - 1];
    const next = work[i + 1];
    const opensHere = ch === '"' || (prev !== undefined && !/[A-Za-z0-9]/.test(prev));
    const closesHere = ch === '"' || next === undefined || !/[A-Za-z0-9]/.test(next);
    if (state.quote === ch) {
      if (closesHere) state.quote = '';
    } else if (state.quote === '' && opensHere) {
      state.quote = ch;
    }
    return 1;
  }

  out.push(ch);
  return 1;
}


function scrubNativeFragment(
  fragment: string,
  state: ThinkingScrubState,
): { text: string | null; reasoning: string | null } {
  if (!fragment) return { text: null, reasoning: null };
  if (state.nativeStarted) return { text: null, reasoning: fragment };

  state.nativePending += fragment;
  const settled = state.nativePending.length >= 24 || state.nativePending.includes('\n');
  if (!settled) return { text: null, reasoning: null };

  const pending = state.nativePending;
  state.nativePending = '';
  state.nativeStarted = true;
  const lead = pending.length - pending.trimStart().length;
  const opener = matchTagAt(pending, lead, OPEN_TAGS);
  const reasoning = opener ? pending.slice(lead + opener.length) : pending;
  return { text: null, reasoning: reasoning || null };
}


export function scrubThinkingFragment(
  fragment: string,
  state: ThinkingScrubState,
): { text: string | null; reasoning: string | null } {
  if (state.channel === 'native') return scrubNativeFragment(fragment, state);

  let work = state.tail ? state.tail + fragment : fragment;
  state.tail = '';
  if (!work) return { text: null, reasoning: null };

  const text: string[] = [];
  const reasoning: string[] = [];
  let i = 0;

  while (i < work.length) {
    if (!state.inside) {
      
      const proseOnly = state.answered && state.channel !== 'arguments';
      if (!proseOnly) {
        const opener = matchTagAt(work, i, OPEN_TAGS);
        if (opener) {
          state.inside = true;
          state.context = 'prose';
          state.fence = '';
          state.inlineTicks = 0;
          state.quote = '';
          state.lineStart = false;
          i += opener.length;
          continue;
        }
        const stray = matchTagAt(work, i, CLOSE_TAGS);
        if (stray) {
          i += stray.length;
          continue;
        }
        const hold = partialTagTail(work.slice(i), ALL_TAGS);
        if (hold && work.length - hold.length === i) {
          state.tail = hold;
          break;
        }
      }
      const ch = work[i];
      text.push(ch);
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') state.answered = true;
      i += 1;
      continue;
    }

    if (state.pendingClose !== null) {
      const ch = work[i];
      const closesQuote =
        ch === state.quote &&
        (ch === '"' || work[i + 1] === undefined || !/[A-Za-z0-9]/.test(work[i + 1]));
      if (closesQuote) {
        reasoning.push(state.pendingClose, ch);
        state.pendingClose = null;
        state.pendingCloseTag = 0;
        state.quote = '';
        i += 1;
        continue;
      }
      if (ch === '\n') {
        const rest = state.pendingClose.slice(state.pendingCloseTag);
        state.pendingClose = null;
        state.pendingCloseTag = 0;
        state.quote = '';
        state.inside = false;
        state.context = 'prose';
        state.fence = '';
        state.inlineTicks = 0;
        state.lineStart = true;
        if (rest) {
          text.push(rest);
          state.answered = true;
        }
        continue;
      }
      state.pendingClose += ch;
      i += 1;
      continue;
    }

    if (state.context === 'prose') {
      const closer = matchTagAt(work, i, CLOSE_TAGS);
      if (closer) {
        if (state.quote !== '') {
          state.pendingClose = closer;
          state.pendingCloseTag = closer.length;
          i += closer.length;
          continue;
        }
        state.inside = false;
        state.context = 'prose';
        state.fence = '';
        state.inlineTicks = 0;
        i += closer.length;
        continue;
      }
      const hold = partialTagTail(work.slice(i), CLOSE_TAGS);
      if (hold && work.length - hold.length === i) {
        state.tail = hold;
        break;
      }
    }

    i += consumeReasoningChar(work, i, state, reasoning);
  }

  return {
    text: text.length > 0 ? text.join('') : null,
    reasoning: reasoning.length > 0 ? reasoning.join('') : null,
  };
}


export function flushThinkingScrub(state: ThinkingScrubState): string | null {
  const tail = state.tail;
  state.tail = '';
  
  const rest = state.pendingClose === null ? '' : state.pendingClose.slice(state.pendingCloseTag);
  state.pendingClose = null;
  state.pendingCloseTag = 0;
  state.inside = false;
  state.context = 'prose';
  state.fence = '';
  state.inlineTicks = 0;
  state.quote = '';
  const text = tail + rest;
  return text || null;
}


export function flushNativeReasoning(state: ThinkingScrubState): string | null {
  if (state.nativeStarted) return null;
  const pending = state.nativePending;
  state.nativePending = '';
  state.nativeStarted = true;
  if (!pending) return null;
  const lead = pending.length - pending.trimStart().length;
  const opener = matchTagAt(pending, lead, OPEN_TAGS);
  const reasoning = opener ? pending.slice(lead + opener.length) : pending;
  return reasoning || null;
}


export function splitInlineThinking(content: string): {
  content: string;
  reasoning: string;
} {
  const state = createThinkingScrubState('response');
  const routed = scrubThinkingFragment(content, state);
  const tail = flushThinkingScrub(state);
  const text = (routed.text ?? '') + (tail ?? '');
  return { content: text.trim(), reasoning: (routed.reasoning ?? '').trim() };
}
