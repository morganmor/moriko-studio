import type { ChatMessage } from '../contracts.js';
import { parseDataUrl } from '../contracts.js';
import { geminiThinkingBudget, createThinkingScrubState, flushThinkingScrub, scrubInlineThinkingFragment, ALL_THINK_TAGS } from '../reasoning.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, UpstreamError, type StreamHandler, type StreamParams } from '../sse.js';
import { idle, STREAM_IDLE_MS } from '../liveness.js';
import { resolveSteerPartRefs } from '../attachmentStore.js';
import { drainSteers, steerTextOf, steersToUserParts } from '../steer.js';
import { drainInjections, injectionText } from '../addons/inject.js';
import { gateToolImages, imageCapableFor, separateImageParts, IMAGE_OMITTED_NOTE } from './visionGate.js';
import {
  createLoopGuard,
  estimateTokensFromChars,
  executeCalls,
  prepareTools,
  toolCallSignature,
  wrapUpInstruction,
  type CatalogueTool,
  type LoopStopReason,
} from '../mcp/loop.js';
import { geminiToolName, toGeminiDeclaration, toGeminiDeclarationLegacy } from './geminiSchema.js';

/** Gemini inline part: plain text or base64 media (image/audio/video/pdf). */
type GeminiRequestPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | {
      functionCall: { name: string; args?: Record<string, unknown>; id?: string };
      /**
       * Opaque reasoning signature. Gemini 3+ REQUIRES it echoed back on the
       * same functionCall part in the next request, or it drops reasoning
       * continuity and answers an empty STOP.
       */
      thoughtSignature?: string;
    }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

/**
 * Gemini 3 and later replaced `thinkingBudget` with `thinkingLevel`; sending
 * a budget to those models is an error, and sending a level to 2.5 is one too.
 */
function usesThinkingLevel(model: string): boolean {
  return /gemini-(?:[3-9]|\d{2})(?:[.-]|$)/i.test(model) || /gemini-4/i.test(model);
}

/** The proto ladder, weakest → strongest, paired with the canonical levels. */
const THINKING_LEVEL_WIRE: ReadonlyArray<
  [StreamParams['settings']['thinkingLevel'], string]
> = [
  ['minimal', 'MINIMAL'],
  ['low', 'LOW'],
  ['medium', 'MEDIUM'],
  ['high', 'HIGH'],
];

/** Canonical order — used to clamp any level onto the proto ladder. */
const CANONICAL: readonly StreamParams['settings']['thinkingLevel'][] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

function thinkingConfigFor(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): Record<string, unknown> {
  if (!usesThinkingLevel(model)) {
    return { thinkingBudget: geminiThinkingBudget(level, model, baseUrl) };
  }
  // `off`/`xhigh`/`max` have no proto equivalent: clamp to the nearest rung.
  const target = CANONICAL.indexOf(level);
  const resolved = THINKING_LEVEL_WIRE.reduce((best, entry) => {
    const distance = Math.abs(CANONICAL.indexOf(entry[0]) - target);
    const bestDistance = Math.abs(CANONICAL.indexOf(best[0]) - target);
    return distance < bestDistance ? entry : best;
  });
  return { thinkingLevel: resolved[1] };
}


/**
 * Maps a generic message content into Gemini parts. Non-image files travel as
 * `inline_data` with the mime from their data URL — Gemini supports inline
 * audio, video, and PDF on models that accept them.
 */
function toGeminiParts(content: ChatMessage['content']): GeminiRequestPart[] {
  if (content === null) return [{ text: '' }];
  if (typeof content === 'string') return [{ text: content }];
  const parts: GeminiRequestPart[] = [];
  const pushMedia = (
    part:
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'file'; file: { filename: string; file_data: string } },
    name: string,
  ): void => {
    const dataUrl = part.type === 'image_url' ? part.image_url.url : part.file.file_data;
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
    } else {
      pushMedia(part, part.file.filename);
    }
  }
  return parts.length > 0 ? parts : [{ text: '' }];
}

/**
 * Google Gemini adapter using the native `streamGenerateContent` stream.
 *
 * Using the native endpoint (rather than Gemini's OpenAI shim) is what makes
 * thinking budgets expressible.
 *
 * Use MCP: `functionDeclarations` carry the aggregated MCP tools; `functionCall`
 * parts trigger execution and a `functionResponse` user turn continues the loop.
 */
export async function streamGemini(params: StreamParams, onEvent: StreamHandler): Promise<void> {
  const { baseUrl, apiKey, model, messages, settings, signal } = params;
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * Tool declarations travel as `parametersJsonSchema` — the lossless JSON
   * Schema field Google documents (its own example carries
   * `additionalProperties`). The legacy `parameters` proto is a CLOSED field
   * set: `additionalProperties`/`oneOf`/`$ref` there make protobuf parsing
   * fail, and Gemini rejects the WHOLE request with HTTP 400 — one addon tool
   * is enough to break every generation. It is kept only as a retry path for
   * API surfaces that predate the JSON Schema field.
   */
  let catalogue: CatalogueTool[] = [];
  let losslessDeclarations = true;
  /** Gemini-safe declaration name → the catalogue's real wire name. */
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
  /**
   * `functionResponse` must carry the SAME name (and, on newer models, id) as
   * the `functionCall` it answers — Google returns an empty STOP on mismatch.
   * The wire's `tool` message only carries `tool_call_id`, so the name is
   * recovered by scanning BACK through the already-mapped history for the
   * assistant message whose `tool_calls` entry owns that id.
   */
  const wireNameById = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) wireNameById.set(call.id, call.function.name);
  }
  const imageCapable = imageCapableFor(params.model);
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

  const guard = createLoopGuard(params.contextLimit);
  let forcedStop: LoopStopReason | null = null;

  if (prepared.count > 0 && prepared.defs) {
    onEvent({ type: 'context_tools', chars: JSON.stringify(prepared.defs).length });
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

  for (;;) {
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
      // A 400 on the JSON Schema field itself: retry once with the proto shape.
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
          const declared = coerceText(part.functionCall.name) ?? part.functionCall.name;
          // Gemini answers the DECLARED name; the catalogue knows the real one.
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
          const clean = textDelta.replace(ALL_THINK_TAGS, '');
          if (clean) onEvent({ type: 'reasoning', delta: clean });
          continue;
        }
        const scrubbed = scrubInlineThinkingFragment(textDelta, contentScrub);
        if (scrubbed.reasoning) onEvent({ type: 'reasoning', delta: scrubbed.reasoning });
        if (scrubbed.text) onEvent({ type: 'text', delta: scrubbed.text });
      }

      if (chunk.usageMetadata) {
        usage = chunk.usageMetadata;
        sawAnyUsage = true;
        if (usage.promptTokenCount !== undefined) sumPromptTokens += usage.promptTokenCount;
        sumCompletionTokens += usage.candidatesTokenCount ?? 0;
        sumBilledTokens +=
          usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0);
        sumCacheReadTokens += usage.cachedContentTokenCount ?? 0;
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }

    const contentTail = flushThinkingScrub(contentScrub);
    if (contentTail) onEvent({ type: 'text', delta: contentTail });

    if (calls.length === 0) {
      flushUsage();
      onEvent({ type: 'done', finishReason: forcedStop ?? (finishReason ?? 'stop') });
      return;
    }

    const modelParts: GeminiRequestPart[] = calls.map((call) => ({
      functionCall: { name: geminiToolName(call.name), args: call.args, id: call.id },
      ...(call.signature ? { thoughtSignature: call.signature } : {}),
    }));
    convo.push({ role: 'model', parts: modelParts });

    if (signal?.aborted) {
      flushUsage();
      onEvent({ type: 'done', finishReason: 'aborted' });
      return;
    }

    const executed = await executeCalls(
      calls.map((call) => ({ id: call.id, wireName: call.name, rawArgs: JSON.stringify(call.args ?? {}) })),
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
      usage ? { promptTokens: usage.promptTokenCount, completionTokens: usage.candidatesTokenCount } : undefined,
      estimateTokensFromChars(
        executed.followUp.reduce((sum, output) => sum + String(output.text ?? '').length, 0),
      ),
      executed.followUp.map((output) => ({
        wireName: output.wireName as string,
        errorCode: output.errorCode as string | undefined,
      })),
    );
    forcedStop = guard.stopReason();

    if (forcedStop) {
      responseParts.push({ text: wrapUpInstruction(forcedStop) });
    }

    const steered = drainSteers(params.sessionId);
    for (const entry of steered) onEvent({ type: 'steer', id: entry.id, text: steerTextOf(entry), parts: entry.parts });
    const steerParts = steersToUserParts(steered);
    resolveSteerPartRefs(steerParts);
    if (steered.length > 0) {
      responseParts.push(...toGeminiParts(steerParts));
    }

    const injections = drainInjections(params.sessionId ?? undefined);
    for (const entry of injections) {
      onEvent({ type: 'steer', id: `addon-inject-${entry.id}`, text: `[${entry.addonId}] ${injectionText(entry)}` });
      responseParts.push({ text: `System notice from the ${entry.addonId} addon:\n${injectionText(entry)}` });
    }

    convo.push({ role: 'user', parts: responseParts });
    } finally {
      streamIdle.clear();
    }
  }
}
