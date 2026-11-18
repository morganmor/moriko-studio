import type { ChatMessage } from '../contracts.js';
import { parseDataUrl } from '../contracts.js';
import {
  createReasoningBlockEmitter,
  createThinkingScrubState,
  flushNativeReasoning,
  flushThinkingScrub,
  geminiThinkingBudget,
  scrubThinkingFragment,
} from '../reasoning.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, UpstreamError, type StreamHandler, type StreamParams } from '../sse.js';
import { idle, STREAM_IDLE_MS } from '../liveness.js';
import { resolveSteerPartRefs } from '../attachmentStore.js';
import { drainSteers, steerTextOf, steersToUserParts } from '../steer.js';
import { drainInjections, injectionText } from '../addons/inject.js';
import { gateToolImages, imageCapableFor, separateImageParts, IMAGE_OMITTED_NOTE } from './visionGate.js';
import {
  createLoopGuard,
  executeCalls,
  prepareTools,
  toolCallSignature,
  wrapUpInstruction,
  type CatalogueTool,
  type LoopStopReason,
} from '../mcp/loop.js';
import { createContextMeter, createTurnUsageAccumulator, type ContextMeter, type RoundUsageInput } from '../mcp/contextMeter.js';
import { geminiToolName, toGeminiDeclaration, toGeminiDeclarationLegacy } from './geminiSchema.js';


type GeminiRequestPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | {
      functionCall: { name: string; args?: Record<string, unknown>; id?: string };
      
      thoughtSignature?: string;
    }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };


function usesThinkingLevel(model: string): boolean {
  return /gemini-(?:[3-9]|\d{2})(?:[.-]|$)/i.test(model) || /gemini-4/i.test(model);
}


const THINKING_LEVEL_WIRE: ReadonlyArray<
  [StreamParams['settings']['thinkingLevel'], string]
> = [
  ['minimal', 'MINIMAL'],
  ['low', 'LOW'],
  ['medium', 'MEDIUM'],
  ['high', 'HIGH'],
];


const CANONICAL: readonly StreamParams['settings']['thinkingLevel'][] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];


function thinkingConfigFor(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): Record<string, unknown> {
  if (!usesThinkingLevel(model)) {
    const budget = geminiThinkingBudget(level, model, baseUrl);
    return budget === 0
      ? { thinkingBudget: 0 }
      : { thinkingBudget: budget, includeThoughts: true };
  }
  const target = CANONICAL.indexOf(level);
  const resolved = THINKING_LEVEL_WIRE.reduce((best, entry) => {
    const distance = Math.abs(CANONICAL.indexOf(entry[0]) - target);
    const bestDistance = Math.abs(CANONICAL.indexOf(best[0]) - target);
    return distance < bestDistance ? entry : best;
  });
  return level === 'off'
    ? { thinkingLevel: resolved[1] }
    : { thinkingLevel: resolved[1], includeThoughts: true };
}



function toGeminiParts(content: ChatMessage['content']): GeminiRequestPart[] {
  if (content === null) return [{ text: '' }];
  if (typeof content === 'string') return [{ text: content }];
  const parts: GeminiRequestPart[] = [];
  const pushMedia = (
    part:
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'video_url'; video_url: { url: string } }
      | { type: 'file'; file: { filename: string; file_data: string } },
    name: string,
  ): void => {
    const dataUrl = part.type === 'image_url'
      ? part.image_url.url
      : part.type === 'video_url'
        ? part.video_url.url
        : part.file.file_data;
    const media = parseDataUrl(dataUrl);
    if (media) {
      parts.push({ inline_data: { mime_type: media.mime, data: media.data } });
    } else {
      parts.push({ text: `[Attachment could not be decoded: ${name}]` });
    }
  };
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ text: part.text });
    } else if (part.type === 'image_url') {
      pushMedia(part, 'image');
    } else if (part.type === 'video_url') {
      pushMedia(part, 'video');
    } else {
      pushMedia(part, part.file.filename);
    }
  }
  return parts.length > 0 ? parts : [{ text: '' }];
}


export async function streamGemini(params: StreamParams, onEvent: StreamHandler): Promise<void> {
  const { baseUrl, apiKey, model, messages, settings, signal } = params;
  const base = baseUrl.replace(/\/+$/, '');
  
  const meter: ContextMeter = createContextMeter({
    systemInstruction: settings.systemInstruction ?? '',
    systemSegments: params.harnessInjections.map((injection) => injection.content),
    toolDefsChars: 0,
    messages,
  });

  
  let catalogue: CatalogueTool[] = [];
  let losslessDeclarations = true;
  
  const declToWire = new Map<string, string>();
  const prepared = await prepareTools(settings, (tools) => {
    catalogue = tools;
    declToWire.clear();
    for (const tool of tools) declToWire.set(geminiToolName(tool.wireName), tool.wireName);
    return { functionDeclarations: tools.map(toGeminiDeclaration) };
  });
  const legacyDefs = (): unknown => ({
    functionDeclarations: catalogue.map(toGeminiDeclarationLegacy),
  });

  const convo: Array<{ role: 'user' | 'model'; parts: GeminiRequestPart[] }> = [];
  
  const wireNameById = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) wireNameById.set(call.id, call.function.name);
  }
  const imageCapable = await imageCapableFor(params.model, params.providerId, params.capability);
  const stripImages = (content: ChatMessage['content']): ChatMessage['content'] => {
    if (imageCapable || !Array.isArray(content)) return content;
    const { kept, dropped } = separateImageParts(content);
    return dropped === 0 ? content : [...kept, { type: 'text' as const, text: IMAGE_OMITTED_NOTE.repeat(dropped) }];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      const raw = typeof message.content === 'string' ? message.content : '';
      const droppedImages = !raw && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'image_url').length
        : 0;
      const text = droppedImages > 0
        ? `${raw}\n\n[image part dropped: ${droppedImages} inline image(s) — the Gemini functionResponse transport cannot carry images.]`.trim()
        : raw;
      const name = message.name ?? wireNameById.get(message.tool_call_id ?? '') ?? 'tool';
      convo.push({
        role: 'user',
        parts: [
          { functionResponse: { name, response: { result: text }, id: message.tool_call_id } },
        ],
      });
      continue;
    }
    const parts = toGeminiParts(stripImages(message.content));
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const all = [...parts];
      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = { _raw: call.function.arguments };
        }
        all.push({ functionCall: { name: call.function.name, args, id: call.id } });
      }
      convo.push({ role: 'model', parts: all });
      continue;
    }
    convo.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  const guard = createLoopGuard(params.contextLimit, params.compactGuard);
  let forcedStop: LoopStopReason | null = null;
  
  let compactRequested = false;
  
  const reasoningBlocks = createReasoningBlockEmitter(onEvent);

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

  for (;;) {
    if (signal?.aborted) {
      if (meter.hasUsage()) meter.flush(onEvent);
      flushUsage();
      onEvent({ type: 'done', finishReason: 'aborted' });
      return;
    }
    const streamIdle = idle(signal, STREAM_IDLE_MS, 'STREAM_IDLE');
    try {
    const useTools = prepared.count > 0 && !forcedStop;

    const generationConfig: Record<string, unknown> = {
      temperature: settings.temperature,
      topP: settings.topP,
      ...(settings.maxOutputTokens !== null ? { maxOutputTokens: settings.maxOutputTokens } : {}),
    };

    generationConfig.thinkingConfig = thinkingConfigFor(settings.thinkingLevel, params.model, params.baseUrl);

    if (settings.structuredOutputs && !useTools) {
      generationConfig.responseMimeType = 'application/json';
    }

    const body: Record<string, unknown> = {
      contents: convo,
      generationConfig,
      ...(prepared.defs && useTools
        ? {
            tools: losslessDeclarations ? prepared.defs : legacyDefs(),
            ...(frozen && !choiceMade
              ? { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['agent__harness_choice'] } } }
              : {}),
          }
        : {}),
    };

    const systemText = [
      settings.systemInstruction?.trim() ?? '',
      ...params.harnessInjections.map((injection) => injection.content),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

    let response: Response;
    try {
      response = await fetch(
        `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          signal: streamIdle.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      await assertOk(response, 'Gemini');
    } catch (error) {
      const schemaRejection =
        error instanceof UpstreamError &&
        error.status === 400 &&
        /parametersJsonSchema|Unknown name|Invalid JSON payload/i.test(error.message);
      if (schemaRejection && losslessDeclarations && catalogue.length > 0) {
        losslessDeclarations = false;
        continue;
      }
      throw error;
    }
    if (!response.body) throw new Error('Gemini returned an empty stream.');

    interface GeminiPart {
      text?: string;
      thought?: boolean;
      functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
      thoughtSignature?: string;
    }
    interface GeminiChunk {
      candidates?: Array<{
        content?: { parts?: GeminiPart[] };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        cachedContentTokenCount?: number;
        thoughtsTokenCount?: number;
      };
      promptFeedback?: { blockReason?: string };
    }

    let finishReason: string | undefined;
    const calls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      signature?: string;
    }> = [];
    let usage: GeminiChunk['usageMetadata'] | undefined;
    const contentScrub = createThinkingScrubState();
    
    const nativeScrub = createThinkingScrubState('native');

    for await (const payload of iterateSse(response.body, () => streamIdle.reset())) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(payload) as GeminiChunk;
      } catch {
        continue;
      }

      if (chunk.promptFeedback?.blockReason !== undefined) {
        const reason = coerceText(chunk.promptFeedback.blockReason) ?? 'unknown reason';
        flushUsage();
        onEvent({
          type: 'error',
          message: `Gemini blocked the prompt (${reason}).`,
        });
        return;
      }

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall) {
          reasoningBlocks.end();
          const declared = coerceText(part.functionCall.name) ?? part.functionCall.name;
          const name = declToWire.get(declared) ?? declared;
          calls.push({
            id: part.functionCall.id ?? `${name}_${calls.length}`,
            name,
            args: part.functionCall.args ?? {},
            ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
          });
          continue;
        }
        if (part.text === undefined) continue;
        const textDelta = coerceText(part.text);
        if (textDelta === null || textDelta === '') continue;
        if (part.thought) {
          meter.addReasoningChars(textDelta.length);
          meter.maybeEmit(onEvent);
          const routed = scrubThinkingFragment(textDelta, nativeScrub);
          if (routed.reasoning) reasoningBlocks.push(routed.reasoning);
          continue;
        }
        reasoningBlocks.end();
        const scrubbed = scrubThinkingFragment(textDelta, contentScrub);
        if (scrubbed.reasoning) {
          reasoningBlocks.push(scrubbed.reasoning);
          meter.addReasoningChars(scrubbed.reasoning.length);
          meter.maybeEmit(onEvent);
        }
        if (scrubbed.text) {
          meter.addOutputChars(scrubbed.text.length);
          meter.maybeEmit(onEvent);
          onEvent({ type: 'text', delta: scrubbed.text });
        }
      }

      if (chunk.usageMetadata) {
        usage = chunk.usageMetadata;
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }

    const nativeTail = flushNativeReasoning(nativeScrub);
    if (nativeTail) {
      meter.addReasoningChars(nativeTail.length);
      reasoningBlocks.push(nativeTail);
    }
    reasoningBlocks.end();
    const contentTail = flushThinkingScrub(contentScrub);
    if (contentTail) {
      meter.addOutputChars(contentTail.length);
      onEvent({ type: 'text', delta: contentTail });
    }

    const roundUsage: RoundUsageInput | undefined = usage
      ? (() => {
          const promptTokens = usage.promptTokenCount;
          const thoughts = usage.thoughtsTokenCount ?? 0;
          const candidates = usage.candidatesTokenCount ?? 0;
          const total = usage.totalTokenCount;
          // On Gemini thinking models, totalTokenCount = prompt + candidates + thoughts when thoughts are billed separately.
          const separateThoughts =
            thoughts > 0 &&
            typeof total === 'number' &&
            typeof promptTokens === 'number' &&
            total >= promptTokens + candidates + thoughts;
          return {
            promptTokens,
            completionTokens: separateThoughts ? candidates + thoughts : candidates,
            totalTokens: total,
            cacheReadTokens: usage.cachedContentTokenCount,
            reasoningTokens: thoughts > 0 ? thoughts : undefined,
          };
        })()
      : undefined;

    if (calls.length === 0) {
      if (roundUsage) {
        guard.record([], roundUsage, 0);
        meter.recordUsage(roundUsage);
        usageAcc.record(roundUsage);
        onEvent({ type: 'context_telemetry', ...guard.telemetry() });
        meter.flush(onEvent);
      }
      flushUsage();
      onEvent({ type: 'done', finishReason: forcedStop ?? (finishReason ?? 'stop') });
      return;
    }

    const modelParts: GeminiRequestPart[] = calls.map((call) => ({
      functionCall: { name: geminiToolName(call.name), args: call.args, id: call.id },
      ...(call.signature ? { thoughtSignature: call.signature } : {}),
    }));
    meter.addCompletionToolChars(
      calls.reduce((sum, call) => sum + call.name.length + JSON.stringify(call.args ?? {}).length, 0),
    );
    if (roundUsage) {
      meter.recordUsage(roundUsage);
      usageAcc.record(roundUsage);
    }
    meter.advanceRound({ keepReasoning: false });
    convo.push({ role: 'model', parts: modelParts });

    if (signal?.aborted) {
      if (meter.hasUsage()) meter.flush(onEvent);
      flushUsage();
      onEvent({ type: 'done', finishReason: 'aborted' });
      return;
    }

    freeze.lastReasoning = reasoningBlocks.lastBlockText;
    const executed = await executeCalls(
      calls.map((call) => ({ id: call.id, wireName: call.name, rawArgs: JSON.stringify(call.args ?? {}) })),
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

    const responseParts: GeminiRequestPart[] = executed.followUp.map((output) => {
      const gated = gateToolImages(
        output.images as Array<{ mime: string }> | undefined,
        imageCapable,
      );
      const text = gated.omitted > 0
        ? `${output.text as string}\n\n[image part dropped: ${gated.omitted} inline image(s) — the Gemini functionResponse transport cannot carry images. The image lives in the conversation record; text-only fallback applies.]`
        : (output.text as string);
      return {
        functionResponse: {
          name: geminiToolName(output.wireName as string),
          response: { result: text },
          id: output.id as string,
        },
      };
    });

    guard.record(
      calls.map((call) => toolCallSignature(call.name, JSON.stringify(call.args ?? {}))),
      roundUsage,
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

    if (forcedStop) {
      responseParts.push({ text: wrapUpInstruction(forcedStop) });
    }

    const steered = drainSteers(params.sessionId);
    for (const entry of steered) onEvent({ type: 'steer', id: entry.id, text: steerTextOf(entry), parts: entry.parts });
    const steerParts = steersToUserParts(steered);
    resolveSteerPartRefs(steerParts);
    if (steered.length > 0) {
      const steerGeminiParts = toGeminiParts(steerParts);
      meter.addInputChars(JSON.stringify(steerGeminiParts).length);
      responseParts.push(...steerGeminiParts);
    }

    const injections = drainInjections(params.sessionId ?? undefined);
    for (const entry of injections) {
      onEvent({ type: 'steer', id: `addon-inject-${entry.id}`, text: `[${entry.addonId}] ${injectionText(entry)}` });
      const notice = `System notice from the ${entry.addonId} addon:\n${injectionText(entry)}`;
      meter.addInputChars(notice.length);
      responseParts.push({ text: notice });
    }

    convo.push({ role: 'user', parts: responseParts });
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
