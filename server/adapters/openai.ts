import {
  applyReasoningEffort,
  createReasoningBlockEmitter,
  createThinkingScrubState,
  flushNativeReasoning,
  flushThinkingScrub,
  modelReasons,
  replaysReasoningContent,
  scrubThinkingFragment,
  thinkingActive,
  thinkingSuppressesSampling,
  type ThinkingScrubState,
} from '../reasoning.js';
import type { ChatMessage } from '../contracts.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, type StreamHandler, type StreamParams } from '../sse.js';
import { idle, STREAM_IDLE_MS } from '../liveness.js';
import { resolveSteerPartRefs } from '../attachmentStore.js';
import { drainSteers, steerTextOf, steersToUserParts } from '../steer.js';
import { drainInjections, injectionText } from '../addons/inject.js';
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
import { gateToolImages, imageCapableFor, separateImageParts, separateVideoParts, IMAGE_OMITTED_NOTE, VIDEO_OMITTED_NOTE } from './visionGate.js';
import { ToolBuildTracker } from './toolCallProgress.js';

/**
 * Composes the system message: the user's own System Prompt first, then the
 * harness's built-in injections (agent tools, MCP tools, structured outputs)
 * in order. The injections are built once per request by the chat route and
 * also streamed to the UI, so what the model sees is exactly inspectable.
 */
export function buildSystemInstruction(params: StreamParams): string {
  const { stable, volatile } = buildSystemSegments(params);
  return [stable, volatile].filter(Boolean).join('\n\n');
}

/**
 * The STATIC/DYNAMIC boundary of the system message.
 *
 * `stable` is the user's own system prompt — byte-identical on every turn, so
 * a provider can cache it (and the tool schemas that precede it) once and
 * reuse it for the rest of the conversation.
 *
 * `volatile` is everything the harness injects: the skills catalogue, the env
 * block, live todos, attachments. It changes between turns, so it must sit
 * AFTER the cache breakpoint or every request would miss.
 *
 * buildSystemInstruction() is derived from this so the two can never diverge.
 */
export function buildSystemSegments(params: StreamParams): { stable: string; volatile: string } {
  const stable = params.settings.systemInstruction?.trim() ?? '';
  const volatile = params.harnessInjections
    .map((injection) => injection.content)
    .filter(Boolean)
    .join('\n\n');
  return { stable, volatile };
}

interface PendingOpenAiCall {
  id?: string;
  name: string;
  arguments: string;
}

interface ContentBlockSplit {
  reasoning: string | null;
  text: string | null;
}

/**
 * Splits a block-list delta.content (Mistral reasoning models: zai-glm-5-3,
 * magistral, ...). Reasoning rides THINKING blocks —
 *   [{ type: 'thinking', thinking: [{ type: 'text', text: '...' }] }]
 * — while answer deltas are a plain string or [{ type: 'text', text }].
 * coerceText is deliberately kept away from thinking blocks: it probes
 * text/content only, so it would silently drop them, and routing them
 * through here keeps reasoning out of the visible answer.
 */
export function splitContentBlocks(content: unknown): ContentBlockSplit {
  if (!Array.isArray(content)) return { reasoning: null, text: null };
  let reasoning = '';
  let text = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type === 'thinking') {
      reasoning += coerceText(record.thinking) ?? '';
    } else {
      text += coerceText(record) ?? '';
    }
  }
  return { reasoning: reasoning || null, text: text || null };
}

/**
 * OpenAI Chat Completions adapter.
 *
 * Also serves every OpenAI-compatible vendor (OpenRouter, Groq, DeepSeek,
 * Mistral, Ollama, LM Studio, vLLM …), which is why the shape stays strictly
 * within the documented Chat Completions surface.
 *
 * With Use MCP on, the aggregated MCP tool defs ride the request and
 * `tool_calls` completions are executed against the user's servers in a loop
 * until the model answers without calling anything (or iterations run out).
 */
export async function streamOpenAiCompatible(
  params: StreamParams,
  onEvent: StreamHandler,
): Promise<void> {
  const { baseUrl, apiKey, model, messages, settings, signal } = params;

  const systemInstruction = buildSystemInstruction(params);
  /**
   * THE PER-SECOND METER: prices the exact request (system message, tool
   * defs, the messages array) with the SHARED estimator, then grows the
   * buckets from every streamed delta. Emits throttled `context_live` frames.
   */
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
  /** VIDEO is its own capability — a model with vision does not necessarily
   *  accept `video_url`, and a model with neither must never be handed the
   *  binary's path to chase with text tools. */
  const videoCapable = params.capability?.videoIn === true;
  /**
   * REASONING ON THE WIRE. A thinking model gets its own chain-of-thought
   * back on the native `reasoning_content` field — never as tag text inside
   * `content` — because DeepSeek (and every provider that follows its tool
   * contract) rejects a tool-bearing request whose assistant turns lack it.
   * A model that does not reason never sees the field: unknown message keys
   * are a 400 on several gateways, and there is nothing to replay.
   */
  const thinkingOn = thinkingActive(params.settings.thinkingLevel, model, params.providerId);
  /**
   * Whether stored reasoning may ride this request. Thinking models always
   * may. A tool-bearing request also replays it even when the user just set
   * effort to Off: providers document that history requirements are keyed to
   * the presence of `tools`, and a mid-conversation Off must not invalidate
   * tool rounds that were produced while thinking.
   */
  const replayReasoning =
    thinkingOn || (prepared.count > 0 && modelReasons(model, params.providerId));
  /**
   * DeepSeek's tool contract is satisfied by an EMPTY `reasoning_content`, but
   * only DeepSeek documents the key on input: sending `reasoning_content: ''`
   * to a relay that rejects unknown message keys is the same 400 in reverse.
   */
  const requiresReasoningContent = replaysReasoningContent(model, params.providerId, baseUrl);
  /** DeepSeek ignores sampling in thinking mode; sending it would lie. */
  const omitSampling = thinkingSuppressesSampling(
    params.settings.thinkingLevel,
    model,
    params.providerId,
    baseUrl,
  );
  const toWireMessage = (message: ChatMessage): Record<string, unknown> => {
    const { reasoning_content: reasoningContent, ...rest } = message;
    const stored =
      typeof reasoningContent === 'string' && reasoningContent.trim() ? reasoningContent : null;
    const withReasoning =
      replayReasoning && stored !== null
        ? { ...rest, reasoning_content: stored }
        : message.role === 'assistant' && requiresReasoningContent
          ? // A turn that produced no thought still must carry the field.
            { ...rest, reasoning_content: '' }
          : rest;
    if (imageCapable && videoCapable) return { ...withReasoning };
    if (!Array.isArray(withReasoning.content)) return { ...withReasoning };
    /**
     * TWO GATES, TWO CAPABILITIES. Image parts and video parts are gated
     * independently: vision without video input must still drop the video,
     * and neither gate may ever degrade a video into a file PATH — a path on a
     * text-only model is what sent the model hunting binaries with read_file.
     */
    let parts = withReasoning.content;
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
    if (notes.length === 0) return { ...withReasoning };
    return {
      ...withReasoning,
      content: [...parts, ...notes.map((text) => ({ type: 'text', text }))],
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
      stream_options: { include_usage: true },
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

    applyReasoningEffort(body, settings.thinkingLevel, model, params.providerId, baseUrl);

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

    await assertOk(response, 'Provider');
    if (!response.body) throw new Error('Provider returned an empty stream.');

    let text = '';
    /** This round's chain-of-thought, verbatim, for the wire replay below. */
    let turnReasoning = '';
    const contentScrub = createThinkingScrubState();
    /** The provider's own reasoning channel: pass-through, never split. */
    const nativeScrub = createThinkingScrubState('native');
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
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number };
        error?: { message?: string };
      };

      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      if (chunk.error?.message !== undefined) {
        const errorMessage = coerceText(chunk.error.message)?.trim() || 'Provider stream error.';
        reasoningBlocks.end();
        flushUsage();
        onEvent({ type: 'error', message: errorMessage });
        return;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      const blocks = splitContentBlocks(delta?.content);
      const reasoning =
        coerceText(delta?.reasoning_content) ?? coerceText(delta?.reasoning) ?? blocks.reasoning;
      if (reasoning) {
        // Native channel: this IS reasoning. A closer tag the model quotes
        // inside it is thought content, never a boundary.
        meter.addReasoningChars(reasoning.length);
        meter.maybeEmit(onEvent);
        const routed = scrubThinkingFragment(reasoning, nativeScrub);
        if (routed.reasoning) {
          turnReasoning += routed.reasoning;
          reasoningBlocks.push(routed.reasoning);
        }
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
          cacheReadTokens:
            chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens,
        };
      }
    }

    const nativeTail = flushNativeReasoning(nativeScrub);
    if (nativeTail) {
      turnReasoning += nativeTail;
      reasoningBlocks.push(nativeTail);
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
      if (!call.id) call.id = `call_${iteration}_${index}`;
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
     * THE 400 FIX. With tools on the request, DeepSeek requires every
     * assistant turn — including the one that requested these calls — to carry
     * its `reasoning_content`, and that requirement does not relax for a turn
     * where the model merely answered. An empty string rides along while
     * thinking is on; a model that never reasons never sees the field.
     */
    const assistantReasoning = turnReasoning || (requiresReasoningContent ? '' : undefined);
    convo.push({
      role: 'assistant',
      ...(text ? { content: text } : { content: null }),
      ...(toolRequests.length > 0 ? { tool_calls: toolRequests } : {}),
      ...(assistantReasoning !== undefined ? { reasoning_content: assistantReasoning } : {}),
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
