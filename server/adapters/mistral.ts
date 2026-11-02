/**
 * MISTRAL ADAPTER — same wire mechanics as the OpenAI adapter.
 *
 * This file mirrors server/adapters/openai.ts: identical request-body
 * construction, identical SSE handling, identical tool loop, guard, meter,
 * steer, injections and image gating. Only the two wire facts Mistral alone
 * owns remain, and they stay BY DESIGN (user-locked):
 *
 *  1. ASSISTANT HISTORY REPLAY — reasoning replays inside `content` as
 *     Mistral's chunk list: [{ type: 'thinking', thinking: [{ type: 'text',
 *     text }] }, { type: 'text', text }]. The field `reasoning_content` does
 *     NOT exist on Mistral's message schema — sending it is HTTP 422
 *     ("extra_forbidden"), observed live on message #252 of a tool loop.
 *  2. STREAM SHAPE — with reasoning on, streaming deltas carry `delta.content`
 *     as a chunk LIST (ThinkChunk/TextChunk) — parsed here with the SAME
 *     splitContentBlocks the OpenAI adapter uses.
 *
 * Everything else follows the OpenAI adapter verbatim.
 */

import type { ChatMessage } from '../contracts.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, type StreamHandler, type StreamParams } from '../sse.js';
import { idle, STREAM_IDLE_MS } from '../liveness.js';
import { resolveSteerPartRefs } from '../attachmentStore.js';
import { drainSteers, steerTextOf, steersToUserParts } from '../steer.js';
import { drainInjections, injectionText } from '../addons/inject.js';
import {
  createReasoningBlockEmitter,
  createThinkingScrubState,
  flushThinkingScrub,
  modelEffortLadder,
  modelReasons,
  scrubThinkingFragment,
  thinkingActive,
  thinkingSuppressesSampling,
  type ThinkingScrubState,
} from '../reasoning.js';
import {
  createLoopGuard,
  estimateTokensFromChars,
  executeCalls,
  prepareTools,
  repairPartialJson,
  toolCallSignature,
  wrapUpInstruction,
  type LoopStopReason,
  type PreparedTools,
} from '../mcp/loop.js';
import { createContextMeter, type ContextMeter } from '../mcp/contextMeter.js';
import { buildSystemInstruction, splitContentBlocks } from './openai.js';
import { gateToolImages, imageCapableFor, separateImageParts, separateVideoParts, IMAGE_OMITTED_NOTE, VIDEO_OMITTED_NOTE } from './visionGate.js';
import { ToolBuildTracker } from './toolCallProgress.js';

interface PendingOpenAiCall {
  id?: string;
  name: string;
  arguments: string;
}

/**
 * Deterministic 9-char alphanumeric `[a-zA-Z0-9]{9}` tool_call_id required by
 * Mistral's Pydantic validator when an upstream chunk omits `id`.
 */
function mistralToolCallId(iteration: number, index: number): string {
  const iterPart = Math.max(0, iteration).toString(36).padStart(4, '0').slice(-4);
  const idxPart = Math.max(0, index).toString(36).padStart(4, '0').slice(-4);
  return `c${iterPart}${idxPart}`;
}

/**
 * MISTRAL CHUNKLIST — the wire type for assistant `content` when reasoning is on.
 *
 * ChatMessage.content arrives as a plain string (or null on tool-only turns)
 * plus a separate reasoning string; Mistral wants ONE list: thinking chunks
 * first, then text. Reconstructs the exact shape Mistral documents for replay:
 *   [{ type: 'thinking', thinking: [{ type: 'text', text }] }, { type: 'text', text }]
 */
function toMistralChunks(
  text: string | null,
  reasoning: string | null,
): Array<Record<string, unknown>> | null {
  const chunks: Array<Record<string, unknown>> = [];
  if (reasoning && reasoning.trim()) {
    chunks.push({ type: 'thinking', thinking: [{ type: 'text', text: reasoning }] });
  }
  if (text !== null && text !== '') {
    chunks.push({ type: 'text', text });
  }
  // EMPTY chunk lists are not a valid Mistral content shape. A tool-only round
  // that already spent its reasoning replays as `null` (the OpenAI convention),
  // never as [] — an empty list poisons the next round's arguments.
  return chunks.length > 0 ? chunks : null;
}

/**
 * The serializer: ChatMessage → Mistral wire message.
 *
 * HARD RULE: `reasoning_content` NEVER appears on a Mistral message. It is
 * destructured OUT first — a stored field the OpenAI contract invented, which
 * Mistral's pydantic schema rejects with 422 extra_forbidden.
 */
function mistralWireMessage(
  message: ChatMessage,
  thinking: boolean,
  canReason: boolean,
): Record<string, unknown> {
  // Strip EVERYTHING not in Mistral's message schema in one move.
  const { reasoning_content: reasoningContent, content, ...rest } = message;

  if (message.role === 'assistant' && (content === null || typeof content === 'string')) {
    const reasoning = typeof reasoningContent === 'string' ? reasoningContent : '';
    if (thinking || (canReason && reasoning.trim() !== '')) {
      return { ...rest, content: toMistralChunks(content, reasoning) ?? content };
    }
    return { ...rest, content };
  }

  // User/tool scalar strings and multimodal part arrays pass through; the
  // image/video gate below reshapes multimodal parts when needed.
  return { ...rest, content };
}

/**
 * Whether THIS model reasons: the resolved capability cascade is AUTHORITATIVE
 * when present; the model catalogue is only the fallback. An OR here would
 * replay thinking chunk lists at models whose capability says non-reasoning.
 */
function mistralModelReasons(params: StreamParams): boolean {
  if (params.capability) return params.capability.reasoning;
  return modelReasons(params.model, params.providerId);
}

export async function streamMistral(
  params: StreamParams,
  onEvent: StreamHandler,
): Promise<void> {
  const { baseUrl, apiKey, model, messages, settings, signal } = params;

  const systemInstruction = buildSystemInstruction(params);
  const meter: ContextMeter = createContextMeter({
    systemInstruction,
    systemSegments: [],
    toolDefsChars: 0,
    messages,
  });
  const prepared: PreparedTools = await prepareTools(settings, (tools) =>
    tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.wireName,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    })),
  );

  const imageCapable = await imageCapableFor(params.model, params.providerId, params.capability);
  const videoCapable = params.capability?.videoIn === true;
  const canReason = mistralModelReasons(params);
  const thinking = thinkingActive(settings.thinkingLevel, model, params.providerId);
  const effortLadder = modelEffortLadder(model, params.providerId);
  /** Sampling knobs are meaningless while the model reasons — omit, never lie. */
  const omitSampling = thinkingSuppressesSampling(
    settings.thinkingLevel,
    model,
    params.providerId,
    baseUrl,
  );

  const toWireMessage = (message: ChatMessage): Record<string, unknown> => {
    const wire = mistralWireMessage(message, thinking, canReason);
    if (imageCapable && videoCapable) return wire;
    if (!Array.isArray(wire.content)) return wire;
    let parts = wire.content;
    const notes: string[] = [];
    if (!imageCapable) {
      const imageSplit = separateImageParts(parts);
      parts = imageSplit.kept;
      if (imageSplit.dropped > 0) notes.push(IMAGE_OMITTED_NOTE.repeat(imageSplit.dropped));
    }
    if (!videoCapable) {
      const videoSplit = separateVideoParts(parts);
      parts = videoSplit.kept;
      if (videoSplit.dropped > 0) notes.push(VIDEO_OMITTED_NOTE.repeat(videoSplit.dropped));
    }
    if (notes.length === 0) return wire;
    return {
      ...wire,
      content: [...parts, ...notes.map((noteText) => ({ type: 'text', text: noteText }))],
    };
  };

  const convo: Array<Record<string, unknown>> = [
    ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
    ...messages.map(toWireMessage),
  ];
  /** One lifecycle for the whole run: block ids stay stable across rounds. */
  const reasoningBlocks = createReasoningBlockEmitter(onEvent);

  const guard = createLoopGuard(params.contextLimit, params.compactGuard);
  let forcedStop: LoopStopReason | null = null;
  /**
   * The guard asked for an in-run compaction. The run does NOT end: this flag
   * only stops the loop from issuing another round BEFORE the client has
   * shrunk the context, so the next request cannot overflow. The client
   * resumes the run on the compacted context.
   */
  let compactRequested = false;

  if (prepared.count > 0 && prepared.defs) {
    const defsChars = JSON.stringify(prepared.defs).length;
    onEvent({ type: 'context_tools', chars: defsChars });
    meter.addToolChars(defsChars);
  }

  /** Summed across tool rounds — MUST share the cadence of sumCacheReadTokens. */
  let sumPromptTokens = 0;
  let sumCompletionTokens = 0;
  let sumBilledTokens = 0;
  let sumCacheReadTokens = 0;
  let sawAnyUsage = false;
  const flushUsage = (): void => {
    if (!sawAnyUsage) return;
    onEvent({
      type: 'usage',
      promptTokens: sumPromptTokens > 0 ? sumPromptTokens : undefined,
      completionTokens: sumCompletionTokens,
      totalTokens: sumBilledTokens,
      cacheReadTokens: sumCacheReadTokens > 0 ? sumCacheReadTokens : undefined,
    });
  };

  const frozen = params.settings.trust?.outputFrozen === true;
  let choiceMade = false;

  for (let iteration = 0; ; iteration += 1) {
    const streamIdle = idle(signal, STREAM_IDLE_MS, 'STREAM_IDLE');
    try {
    const useTools = prepared.count > 0 && !forcedStop;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: convo,
      ...(omitSampling ? {} : { temperature: settings.temperature, top_p: settings.topP }),
      ...(settings.maxOutputTokens !== null ? { max_tokens: settings.maxOutputTokens } : {}),
      ...(prepared.defs && useTools
        ? { tools: prepared.defs, tool_choice: frozen && !choiceMade ? { type: 'function', function: { name: 'agent__harness_choice' } } : 'auto' }
        : {}),
    };

    if (/glm/i.test(model) && typeof body.temperature === 'number' && body.temperature > 1) {
      body.temperature = 1;
    }

    if (settings.structuredOutputs && !useTools) {
      body.response_format = { type: 'json_object' };
    }

    // MISTRAL EFFORT: `reasoning_effort` is a ROOT-LEVEL parameter.
    //  • When the user picked Off on a reasoning model whose catalogued ladder
    //    includes `none` (mistral-small-2603, mistral-medium-2604, glm-5-2),
    //    Mistral documents `reasoning_effort: "none"` to disable thinking.
    //  • When thinking is active, send the selected level verbatim — Mistral
    //    validates per model (zai-glm-5-3*: low/high/max) and surfaces errors.
    if (canReason && settings.thinkingLevel === 'off' && effortLadder?.includes('off')) {
      body.reasoning_effort = 'none';
    } else if (thinking && settings.thinkingLevel && settings.thinkingLevel !== 'off') {
      body.reasoning_effort = settings.thinkingLevel;
    }

    // stream_options.include_usage is OpenAI's switch; Mistral ignores it and
    // sends usage unprompted — an unknown body field risks a strict 422, so it
    // never rides a Mistral request.

    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: streamIdle.signal,
      headers: {
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'Moriko Studio',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    await assertOk(response, 'Mistral');
    if (!response.body) throw new Error('Mistral returned an empty stream.');

    let text = '';
    /** This round's chain-of-thought, verbatim, for the wire replay below. */
    let turnReasoning = '';
    const contentScrub = createThinkingScrubState();
    const argsScrub = new Map<number, ThinkingScrubState>();
    let sawUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheReadTokens?: number } | undefined;
    let finishReason: string | undefined;
    const callsByIndex = new Map<number, PendingOpenAiCall>();
    /** LIVE ASSEMBLY — see toolCallProgress.ts (ported from Chuze). */
    const buildTracker = new ToolBuildTracker();

    for await (const payload of iterateSse(response.body, () => streamIdle.reset())) {
      if (payload === '[DONE]') break;

      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | Array<Record<string, unknown>> | null;
            reasoning?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        error?: { message?: string };
      };

      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      if (chunk.error?.message !== undefined) {
        const errorMessage = coerceText(chunk.error.message)?.trim() || 'Mistral stream error.';
        reasoningBlocks.end();
        flushUsage();
        onEvent({ type: 'error', message: errorMessage });
        return;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      // MISTRAL STREAM SHAPE (user-locked shape #2) — parsed with the OpenAI
      // adapter's own splitter:
      //   thinking phase  → delta.content = [{ type: 'thinking', thinking: [...] }]
      //   transition      → [{ ThinkChunk(close), TextChunk(first) }]
      //   answer phase    → plain string
      const blocks = splitContentBlocks(delta?.content);
      const reasoning =
        coerceText(delta?.reasoning_content) ?? coerceText(delta?.reasoning) ?? blocks.reasoning;
      if (reasoning) {
        meter.addReasoningChars(reasoning.length);
        meter.maybeEmit(onEvent);
        turnReasoning += reasoning;
        reasoningBlocks.push(reasoning);
      }

      const contentDelta = blocks.text ?? coerceText(delta?.content);
      if (contentDelta) {
        // The answer starts here — the block is closed before the first token.
        reasoningBlocks.end();
        const scrubbed = scrubThinkingFragment(contentDelta, contentScrub);
        if (scrubbed.reasoning) {
          turnReasoning += scrubbed.reasoning;
          reasoningBlocks.push(scrubbed.reasoning);
        }
        if (scrubbed.text) {
          text += scrubbed.text;
          meter.addOutputChars(scrubbed.text.length);
          meter.maybeEmit(onEvent);
          onEvent({ type: 'text', delta: scrubbed.text });
        }
      }

      if (delta?.tool_calls?.length) reasoningBlocks.end();
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const pending = callsByIndex.get(index) ?? { name: '', arguments: '' };
        if (fragment.id) pending.id = fragment.id;
        const nameFragment = coerceText(fragment.function?.name);
        if (nameFragment) pending.name += nameFragment;
        const argsFragment = coerceText(fragment.function?.arguments);
        if (argsFragment) {
          let argScrub = argsScrub.get(index);
          if (!argScrub) {
            argScrub = createThinkingScrubState('arguments');
            argsScrub.set(index, argScrub);
          }
          const scrubbed = scrubThinkingFragment(argsFragment, argScrub);
          if (scrubbed.text) pending.arguments += scrubbed.text;
        }
        callsByIndex.set(index, pending);
        // Publish the growing payload: the first fragment forces a frame so the
        // strip appears instantly, later ones ride the ~120 ms throttle.
        const isFirst = !buildTracker.sawAnyFragment;
        buildTracker.ingest(index, nameFragment ?? '', argsFragment ?? '');
        buildTracker.maybeEmit(onEvent, isFirst);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      if (chunk.usage) {
        sawUsage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
        };
      }
    }

    const contentTail = flushThinkingScrub(contentScrub);
    if (contentTail) {
      text += contentTail;
      onEvent({ type: 'text', delta: contentTail });
    }
    // Every round ends with a closed block: nothing else arrives for it.
    reasoningBlocks.end();
    for (const [callIndex, scrub] of argsScrub) {
      const tail = flushThinkingScrub(scrub);
      if (!tail) continue;
      const pending = callsByIndex.get(callIndex);
      if (pending) pending.arguments += tail;
    }

    if (sawUsage) {
      sawAnyUsage = true;
      sumPromptTokens += sawUsage.promptTokens ?? 0;
      sumCompletionTokens += sawUsage.completionTokens ?? 0;
      sumBilledTokens +=
        sawUsage.totalTokens ?? (sawUsage.promptTokens ?? 0) + (sawUsage.completionTokens ?? 0);
      sumCacheReadTokens += sawUsage.cacheReadTokens ?? 0;
    }

    if (finishReason === 'model_context_window_exceeded') {
      flushUsage();
      onEvent({
        type: 'error',
        message:
          'Context window exceeded (model_context_window_exceeded). The conversation is longer ' +
          'than this model accepts — compact the thread or start a new chat.',
      });
      onEvent({ type: 'done', finishReason: 'context_length' });
      return;
    }

    const pendingCalls = [...callsByIndex.values()].filter((call) => call.name);
    const wantsTools = finishReason === 'tool_calls' || pendingCalls.length > 0;

    if (!wantsTools || !useTools) {
      flushUsage();
      onEvent({ type: 'done', finishReason: forcedStop ?? (finishReason ?? 'stop') });
      return;
    }

    /**
     * WIRE-SAFE ARGUMENTS — a truncated arguments stream (e.g.
     * {"height":860,"variants":) executes fine via repairPartialJson, but the
     * raw string poisons the wire: providers that JSON.parse tool-call
     * arguments (Python backends) reject the WHOLE request. Repaired arguments
     * ride the wire, the follow-up history, and the stored segments.
     */
    const wireSafeArguments = (raw: string): string => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === '{}') return '{}';
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        const repaired = repairPartialJson(trimmed);
        return repaired ? JSON.stringify(repaired) : '{}';
      }
    };

    const toolRequests = pendingCalls.map((call, index) => {
      if (!call.id) call.id = mistralToolCallId(iteration, index);
      return {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: wireSafeArguments(call.arguments) },
      } as const;
    });
    // The tool CALLS the model just made ride the wire in `tools` too.
    meter.addToolChars(
      toolRequests.reduce((sum, call) => sum + call.function.name.length + call.function.arguments.length, 0),
    );

    /**
     * MISTRAL REPLAY (user-locked shape #1): when reasoning is active (or the
     * model emitted thinking chunks anyway, as zai-glm-5-3 always does), the
     * assistant turn replays as ONE chunk-list message. Non-reasoning models
     * replay plain string content. `reasoning_content` never exists on this
     * wire — the chunk list IS Mistral's reasoning channel.
     */
    const assistantReasoning = turnReasoning.trim();
    convo.push({
      role: 'assistant',
      content:
        thinking || assistantReasoning !== ''
          ? toMistralChunks(text || null, turnReasoning || null) ?? null
          : text,
      ...(toolRequests.length > 0 ? { tool_calls: toolRequests } : {}),
    });

    if (signal?.aborted) {
      flushUsage();
      onEvent({ type: 'done', finishReason: 'aborted' });
      return;
    }

    const steered = drainSteers(params.sessionId);
    for (const entry of steered) onEvent({ type: 'steer', id: entry.id, text: steerTextOf(entry), parts: entry.parts });
    const steerParts = steersToUserParts(steered);
    resolveSteerPartRefs(steerParts);
    if (steerParts.length > 0) {
      meter.addInputChars(JSON.stringify(steerParts).length);
      convo.push({ role: 'user', content: steerParts });
    }

    const injections = drainInjections(params.sessionId ?? undefined);
    if (injections.length > 0) {
      const injectParts: Array<{ type: 'text'; text: string }> = injections.map((entry) => {
        onEvent({ type: 'steer', id: `addon-inject-${entry.id}`, text: `[${entry.addonId}] ${injectionText(entry)}` });
        return { type: 'text', text: `System notice from the ${entry.addonId} addon:\n${injectionText(entry)}` };
      });
      meter.addInputChars(injectParts.reduce((sum, part) => sum + part.text.length, 0));
      convo.push({ role: 'user', content: injectParts });
    }

    const executed = await executeCalls(
      toolRequests.map((call) => ({
        id: call.id,
        wireName: call.function.name,
        rawArgs: call.function.arguments,
      })),
      prepared.byName,
      signal,
      onEvent,
      params.sessionId,
      params.settings.terminalMode ?? 'auto',
      params.settings.confirmDeletes === true,
      params.model,
      params.settings.enforcement?.level && params.settings.enforcement.level >= 3
        ? (params.settings.enforcement.level as 3 | 4 | 5)
        : undefined,
      params.settings.enforcement?.message ?? params.settings.lockdown?.message,
      params.settings.webAccess,
      params.capability,
      params.settings.trust?.level,
    );
    for (const event of executed.events) {
      if (event.__streamed) continue;
      onEvent(event as Parameters<StreamHandler>[0]);
    }

    if (frozen) {
      for (const event of executed.events) {
        if (event.type === 'tool_call' && event.toolName === 'harness_choice') {
          choiceMade = true;
          try {
            const parsed = JSON.parse(event.args || '{}') as { choice?: string };
            if (parsed.choice === 'apologize') {
              flushUsage();
              onEvent({ type: 'done', finishReason: 'harness_stopped' });
              return;
            }
          } catch {
          }
        }
      }
    }

    guard.record(
      toolRequests.map((call) =>
        toolCallSignature(call.function.name as string, call.function.arguments as string),
      ),
      sawUsage,
      estimateTokensFromChars(
        executed.followUp.reduce((sum, output) => sum + String(output.text ?? '').length, 0),
      ),
      executed.followUp.map((output) => ({
        wireName: output.wireName as string,
        errorCode: output.errorCode as string | undefined,
      })),
    );
    // The round's tool outputs now ride the wire: price them into `tools`.
    meter.addToolChars(
      executed.followUp.reduce((sum, output) => sum + String(output.text ?? '').length, 0),
    );
    // The provider's own completion count REPLACES the estimated tail.
    meter.recordUsage(sawUsage);
    forcedStop = guard.stopReason();

    // TELEMETRY FIRST: the client's ContextChip shows the guard's own
    // arithmetic, so the number on screen and the number being acted on are
    // the same value from the same computation.
    {
      const telemetry = guard.telemetry();
      onEvent({ type: 'context_telemetry', ...telemetry });
      // The buckets, authoritative and per-second, at the round boundary.
      meter.flush(onEvent);
      if (forcedStop === 'compact') {
        const snap = meter.snapshot();
        onEvent({
          type: 'context_compaction_request',
          liveContextTokens: snap.liveContextTokens,
          contextLimit: null,
          trigger: 'context-limit',
        });
        forcedStop = null;
        compactRequested = true;
      }
    }

    for (const output of executed.followUp) {
      const gated = gateToolImages(
        output.images as Array<{ mime: string; dataUrl: string }> | undefined,
        imageCapable,
      );
      const images = gated.images;
      const text0 = output.text as string;
      const text = gated.omitted > 0 ? `${text0}\n\n${IMAGE_OMITTED_NOTE.repeat(gated.omitted)}` : text0;
      convo.push(
        images?.length
          ? {
              role: 'tool',
              tool_call_id: output.id as string,
              content: [
                { type: 'text', text },
                ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
              ],
            }
          : { role: 'tool', tool_call_id: output.id as string, content: text },
      );
    }

    if (forcedStop) {
      convo.push({ role: 'user', content: wrapUpInstruction(forcedStop) });
    }
    // IN-RUN COMPACTION HANDOFF: close the stream, not the task. The finish
    // reason tells the client to compact and AUTO-RESUME this run — it is
    // explicitly not a completed answer, so nothing asks the model for a
    // summary and no tool is stripped mid-step.
    if (compactRequested) {
      flushUsage();
      meter.flush(onEvent);
      onEvent({ type: 'done', finishReason: 'context_compaction' });
      return;
    }
    } finally {
      streamIdle.clear();
    }
  }
}
