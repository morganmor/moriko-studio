/**
 * THE reasoning-boundary lexer — one implementation, two runtimes.
 *
 * The proxy (`server/reasoning.ts`) runs it over stream fragments; the client
 * runs it over a finished buffer when a reply has to be re-split (legacy
 * transports, titles, previews). Sharing the code is the point: a boundary the
 * stream honoured must be the same boundary a replay finds, otherwise the
 * transcript disagrees with what the user watched arrive.
 *
 * Some transports hand reasoning over on its own channel
 * (`delta.reasoning_content`, `delta.reasoning`, Gemini `part.thought`,
 * Anthropic `thinking_delta`) and some inline it in `delta.content` behind
 * tags (`<thinking>…</thinking>`, `<thought>…</thought>`,
 * `<reasoning>…</reasoning>`, GLM-5.3 at 70k+ context being the documented
 * offender).
 *
 * The native channel is AUTHORITATIVE: text that arrives on it is reasoning,
 * full stop. A closer tag written inside it — quoted in prose, inside a code
 * fence, or shown as an escaped example — is CONTENT of the thought, not a
 * boundary. The previous scrubber matched a closer anywhere and moved the rest
 * of the thought into the visible answer, which is exactly how a model
 * explaining its own tags got its reasoning truncated.
 *
 * The inline fallback needs boundaries, and both directions are hostile:
 *   - a FALSE OPEN (a tag in prose/code the model is quoting) splits a normal
 *     answer into a reasoning strip;
 *   - a FALSE CLOSE (a closer inside backticks or a fence) lets the answer
 *     leak into the reasoning channel.
 * The lexer therefore (a) only honours an opener at the very start of the
 * response — whitespace may precede it, nothing else — and (b) only honours a
 * closer while the block is in ordinary prose: not inside a fenced block, an
 * inline code span, a quoted span, or after an escape.
 */

/** Tag spellings a reasoning block may open with. Longest match wins. */
const OPEN_TAGS: readonly string[] = ['<thinking>', '<thought>', '<reasoning>', '<' + 'think' + '>'].sort(
  (a, b) => b.length - a.length,
);
/** Tag spellings a reasoning block may close with (any name closes). */
const CLOSE_TAGS: readonly string[] = ['</thinking>', '</thought>', '</reasoning>', '</' + 'think' + '>'].sort(
  (a, b) => b.length - a.length,
);

const ALL_TAGS: readonly string[] = [...OPEN_TAGS, ...CLOSE_TAGS];

/**
 * Which stream this state belongs to:
 *  - `response`  — `delta.content` of a normal answer: strict start anchor,
 *                  context-aware closer.
 *  - `arguments` — `tool_call.arguments` JSON: a tagged thought leaking into
 *                  arguments is a transport artifact, so the tag is
 *                  authoritative anywhere (JSON has no prose semantics).
 *  - `native`    — the provider's own reasoning channel: never split.
 */
export type ReasoningChannel = 'response' | 'arguments' | 'native';

/** The syntactic context a reasoning block is currently inside. */
type LexContext = 'prose' | 'fence' | 'inline';

/**
 * Per-stream lexer state. One instance per content channel and one per
 * tool-call index; owned by the adapter's round, reset every round.
 */
export interface ThinkingScrubState {
  channel: ReasoningChannel;
  /** True while a block opened in an earlier fragment is still unclosed. */
  inside: boolean;
  /** Trailing partial-tag characters held back from the previous fragment. */
  tail: string;
  /** True once the response emitted any non-whitespace prose. Locks openers. */
  answered: boolean;
  context: LexContext;
  /** Fence marker character (` or ~) while inside a fenced block. */
  fence: string;
  /** Backtick-run length while inside an inline code span. */
  inlineTicks: number;
  /** Quote character while inside a quoted span on the current line. */
  quote: string;
  /**
   * A closer seen while a quote was open, buffered with everything after it
   * until the quote resolves. A quote that never closes on its line was an
   * apostrophe-style artifact, and the closer it "protected" was a real
   * boundary — deciding immediately is how a stray `'` swallowed a whole
   * answer into the reasoning strip.
   */
  pendingClose: string | null;
  /** Length of the closer tag `pendingClose` starts with. */
  pendingCloseTag: number;
  /** True at the start of a line (only whitespace seen since the newline). */
  lineStart: boolean;
  /** Native channel: whether the leading wrapper cleanup already ran. */
  nativeStarted: boolean;
  /** Native channel: bytes held until the wrapper decision can be made. */
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

/** Case-insensitive exact match of one tag spelling at `i`. */
function matchTagAt(text: string, i: number, tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (text.length - i < tag.length) continue;
    if (text.slice(i, i + tag.length).toLowerCase() === tag.toLowerCase()) return tag;
  }
  return null;
}

/**
 * The longest suffix of `s` that is a strict prefix of a tag — i.e. the
 * fragment ended mid-tag (`…<thi`). Held back until the next delta proves it
 * out, so a tag split across deltas never leaks as visible text.
 */
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

/** A run of one repeated character, used for fences and inline code spans. */
function charRunAt(text: string, i: number): { char: string; text: string } | null {
  const char = text[i];
  if (char !== '`' && char !== '~') return null;
  let end = i + 1;
  while (text[end] === char) end += 1;
  return { char, text: text.slice(i, end) };
}

/**
 * Consumes one reasoning character (or one multi-character token) into the
 * syntactic context machine. Returns how many characters were consumed.
 */
function consumeReasoningChar(
  work: string,
  i: number,
  state: ThinkingScrubState,
  out: string[],
): number {
  const ch = work[i];

  // Arguments carry no prose semantics: everything is model text.
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

  // A fence opens or closes only at the start of a line, outside inline code.
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
    /**
     * APOSTROPHES ARE NOT QUOTES. `Let's`, `model's`, `models'` put a `'` right
     * next to a word character; treating those as delimiters left a quote open
     * for the rest of the line and made the real closer look quoted. A single
     * quote therefore only OPENS after a non-word character and only CLOSES
     * before one; a double quote is unambiguous enough to toggle as before.
     */
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

/**
 * Native reasoning channel: pass text through verbatim, never split.
 *
 * The ONLY cleanup is an outer wrapper a few gateways add around the whole
 * thought (an opener at character zero of the channel). It is stripped at the
 * start; a trailing wrapper is deliberately left alone — removing it would
 * mean holding back reasoning text on every delta, and a wrapper tag inside
 * the reasoning channel is inert (it can never reach `content`).
 */
function scrubNativeFragment(
  fragment: string,
  state: ThinkingScrubState,
): { text: string | null; reasoning: string | null } {
  if (!fragment) return { text: null, reasoning: null };
  if (state.nativeStarted) return { text: null, reasoning: fragment };

  state.nativePending += fragment;
  // Decide as soon as the prefix cannot be a bare wrapper tag, or once enough
  // bytes have arrived that holding them would stall the live strip.
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

/**
 * Routes one STREAM FRAGMENT of a provider delta into `text` and `reasoning`.
 *
 *  - `native`    → always `reasoning`, verbatim.
 *  - `response`  → an opener is honoured only before any prose has been
 *                  emitted; a closer only in ordinary prose (never inside a
 *                  fence, inline span, quote, or after an escape).
 *  - `arguments` → tag-routed anywhere: JSON has no prose semantics, and a
 *                  leaked thought must not corrupt the arguments string.
 *
 * Returns `reasoning` separately so the caller can route the leaked thinking
 * to the reasoning strip instead of deleting it — the UI keeps showing the
 * model's actual thinking, just on the right channel.
 */
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
      /**
       * The strict start anchor: an opener may only precede all prose.
       *
       * Once the answer is under way, tags stop being syntax — a model that
       * writes `<thinking>` after its first sentence is SHOWING the tag, so the
       * whole quoted pair stays in the answer untouched. Tool-call arguments
       * are the exception: JSON has no prose, and a leaked thought must not
       * corrupt the arguments string, so a tag there is authoritative anywhere.
       */
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
          // A close with no open BEFORE the answer starts: the model echoing a
          // boundary for a block that was already routed. Dropped, not shown.
          i += stray.length;
          continue;
        }
        const hold = partialTagTail(work.slice(i), ALL_TAGS);
        // Only hold when the fragment ENDS here mid-tag. A partial tag further
        // ahead must not swallow the text in front of it.
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

    // A closer seen inside a quote is buffered until the quote resolves.
    if (state.pendingClose !== null) {
      const ch = work[i];
      const closesQuote =
        ch === state.quote &&
        (ch === '"' || work[i + 1] === undefined || !/[A-Za-z0-9]/.test(work[i + 1]));
      if (closesQuote) {
        // The span really was a quote: the tag inside it is thought content.
        reasoning.push(state.pendingClose, ch);
        state.pendingClose = null;
        state.pendingCloseTag = 0;
        state.quote = '';
        i += 1;
        continue;
      }
      if (ch === '\n') {
        // The quote never closed on its line, so it was an apostrophe-style
        // artifact: the closer WAS the boundary, and everything buffered after
        // it belongs to the answer.
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
        // The newline itself is answered by the outside branch.
        continue;
      }
      state.pendingClose += ch;
      i += 1;
      continue;
    }

    // Inside a block: a closer counts only in plain prose.
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

/**
 * End of round for `response`/`arguments`: a held-back tail that never became
 * a tag is ordinary text — hand it back so nothing the model actually sent is
 * ever swallowed. An unclosed block simply ends with the round.
 */
export function flushThinkingScrub(state: ThinkingScrubState): string | null {
  const tail = state.tail;
  state.tail = '';
  /**
   * A closer still buffered under an unclosed quote was a real boundary: the
   * tag is dropped and the text behind it is the answer that follows it.
   */
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

/** End of round for the native channel: release the held wrapper prefix. */
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

/**
 * Whole-message version (for a finished buffer): splits reasoning out using
 * the SAME rules as the stream lexer, so a replay can never disagree with what
 * the user saw live.
 */
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
