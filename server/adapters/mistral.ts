

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
  executeCalls,
  prepareTools,
  repairPartialJson,
  toolCallSignature,
  wrapUpInstruction,
  type LoopStopReason,
  type PreparedTools,
} from '../mcp/loop.js';
import { createContextMeter, createTurnUsageAccumulator, type ContextMeter, type RoundUsageInput } from '../mcp/contextMeter.js';
import { buildSystemInstruction, splitContentBlocks } from './openai.js';
import { gateToolImages, imageCapableFor, separateImageParts, separateVideoParts, IMAGE_OMITTED_NOTE, VIDEO_OMITTED_NOTE } from './visionGate.js';
import { ToolBuildTracker } from './toolCallProgress.js';

interface PendingOpenAiCall {
  id?: string;
  name: string;
  arguments: string;
}


function mistralToolCallId(iteration: number, index: number): string {
  const iterPart = Math.max(0, iteration).toString(36).padStart(4, '0').slice(-4);
  const idxPart = Math.max(0, index).toString(36).padStart(4, '0').slice(-4);
  return `c${iterPart}${idxPart}`;
}


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
  return chunks.length > 0 ? chunks : null;
}


function mistralWireMessage(
  message: ChatMessage,
  thinking: boolean,
  canReason: boolean,
): Record<string, unknown> {
  const { reasoning_content: reasoningContent, content, ...rest } = message;

  if (message.role === 'assistant' && (content === null || typeof content === 'string')) {
    const reasoning = typeof reasoningContent === 'string' ? reasoningContent : '';
    if (thinking || (canReason && reasoning.trim() !== '')) {
      return { ...rest, content: toMistralChunks(content, reasoning) ?? content };
    }
    return { ...rest, content };
  }

  return { ...rest, content };
}


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
  const canReason = mistralModelReasons(params);
  const thinking = thinkingActive(settings.thinkingLevel, model, params.providerId);
  const meter: ContextMeter = createContextMeter({
    systemInstruction,
    systemSegments: [],
    toolDefsChars: 0,
    messages,
    replayReasoning: thinking || canReason,
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
  const effortLadder = modelEffortLadder(model, params.providerId);
  
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
  
  const reasoningBlocks = createReasoningBlockEmitter(onEvent);

  const guard = createLoopGuard(params.contextLimit, params.compactGuard);
  let forcedStop: LoopStopReason | null = null;
  
  let compactRequested = false;

  if (prepared.count > 0 && prepared.defs) {
    const defsChars = JSON.stringify(prepared.defs).length;
    onEvent({ type: 'context_tools', chars: defsChars });
    meter.addToolChars(defsChars);
  }

  
  const usageAcc = createTurnUsageAccumulator();
  const flushUsage = (): void => {
    usageAcc.flush(onEvent, meter);
  };

  const frozen = params.settings.trust?.outputFrozen === true;
  let choiceMade = false;
  
  const freeze = {
    continueCount: params.settings.trust?.continueCount ?? 0,
    continueSeized: params.settings.trust?.continueSeized === true,
    lastReasoning: '',
  };

  for (let iteration = 0; ; iteration += 1) {
    if (signal?.aborted) {
      if (meter.hasUsage()) meter.flush(onEvent);
      flushUsage();
      onEvent({ type: 'done', finishReason: 'aborted' });
      return;
    }
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

    if (canReason && settings.thinkingLevel === 'off' && effortLadder?.includes('off')) {
      body.reasoning_effort = 'none';
    } else if (thinking && settings.thinkingLevel && settings.thinkingLevel !== 'off') {
      body.reasoning_effort = settings.thinkingLevel;
    }


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
    
    let turnReasoning = '';
    const contentScrub = createThinkingScrubState();
    const argsScrub = new Map<number, ThinkingScrubState>();
    let sawUsage: RoundUsageInput | undefined;
    let finishReason: string | undefined;
    const callsByIndex = new Map<number, PendingOpenAiCall>();
    
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
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        };
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
        reasoningBlocks.end();
        const scrubbed = scrubThinkingFragment(contentDelta, contentScrub);
        if (scrubbed.reasoning) {
          turnReasoning += scrubbed.reasoning;
          meter.addReasoningChars(scrubbed.reasoning.length);
          meter.maybeEmit(onEvent);
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
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
        };
      }
    }

    const contentTail = flushThinkingScrub(contentScrub);
    if (contentTail) {
      text += contentTail;
      meter.addOutputChars(contentTail.length);
      onEvent({ type: 'text', delta: contentTail });
    }
    reasoningBlocks.end();
    for (const [callIndex, scrub] of argsScrub) {
      const tail = flushThinkingScrub(scrub);
      if (!tail) continue;
      const pending = callsByIndex.get(callIndex);
      if (pending) pending.arguments += tail;
    }

    if (finishReason === 'model_context_window_exceeded') {
      usageAcc.record(sawUsage);
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
      if (sawUsage) {
        guard.record([], sawUsage, 0);
        meter.recordUsage(sawUsage);
        usageAcc.record(sawUsage);
        onEvent({ type: 'context_telemetry', ...guard.telemetry() });
        meter.flush(onEvent);
      }
      flushUsage();
      onEvent({ type: 'done', finishReason: forcedStop ?? (finishReason ?? 'stop') });
      return;
    }

    
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
    meter.addCompletionToolChars(
      toolRequests.reduce((sum, call) => sum + call.function.name.length + call.function.arguments.length, 0),
    );
    if (sawUsage) {
      meter.recordUsage(sawUsage);
      usageAcc.record(sawUsage);
    }
    const assistantReasoning = turnReasoning.trim();
    meter.advanceRound({ keepReasoning: Boolean((thinking || assistantReasoning !== '') && turnReasoning) });
    
    convo.push({
      role: 'assistant',
      content:
        thinking || assistantReasoning !== ''
          ? toMistralChunks(text || null, turnReasoning || null) ?? null
          : text,
      ...(toolRequests.length > 0 ? { tool_calls: toolRequests } : {}),
    });

    if (signal?.aborted) {
      if (meter.hasUsage()) meter.flush(onEvent);
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

    freeze.lastReasoning = reasoningBlocks.lastBlockText;
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
      params.settings.confirmDeletes !== false,
      params.model,
      params.settings.enforcement?.level && params.settings.enforcement.level >= 3
        ? (params.settings.enforcement.level as 3 | 4 | 5)
        : undefined,
      params.settings.enforcement?.message ?? params.settings.lockdown?.message,
      params.settings.webAccess,
      params.capability,
      params.settings.trust?.level,
      freeze,
    );
    for (const event of executed.events) {
      if (event.__streamed) continue;
      onEvent(event as Parameters<StreamHandler>[0]);
    }

    if (frozen) {
      for (const event of executed.events) {
        if (event.type === 'tool_call' && event.toolName === 'harness_choice') {
          try {
            const parsed = JSON.parse(event.args || '{}') as { choice?: string };
            if (parsed.choice === 'apologize') {
              const result = executed.events.find(
                (entry) => entry.type === 'tool_result' && entry.toolCallId === event.toolCallId,
              );
              if (result && result.type === 'tool_result' && result.ok) {
                choiceMade = true;
                if (meter.hasUsage()) meter.flush(onEvent);
                flushUsage();
                onEvent({ type: 'done', finishReason: 'harness_stopped' });
                return;
              }
              continue;
            }
            choiceMade = true;
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
      0,
      executed.followUp.map((output) => ({
        wireName: output.wireName as string,
        errorCode: output.errorCode as string | undefined,
      })),
    );
    meter.addToolChars(
      executed.followUp.reduce((sum, output) => sum + String(output.text ?? '').length, 0),
    );
    forcedStop = guard.stopReason();

    {
      const telemetry = guard.telemetry();
      onEvent({ type: 'context_telemetry', ...telemetry });
      meter.flush(onEvent);
      if (forcedStop === 'compact') {
        onEvent({
          type: 'context_compaction_request',
          liveContextTokens: telemetry.liveContextTokens,
          contextLimit: telemetry.contextLimit,
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
    if (compactRequested) {
      flushUsage();
      meter.flush(onEvent);
      onEvent({ type: 'done', finishReason: 'context_compaction' });
      return;
    }
    } catch (error) {
      if (meter.hasUsage()) meter.flush(onEvent);
      flushUsage();
      throw error;
    } finally {
      streamIdle.clear();
    }
  }
}
