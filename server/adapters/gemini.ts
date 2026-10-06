import type { ChatMessage } from '../contracts.js';
import { parseDataUrl } from '../contracts.js';
import { geminiThinkingBudget, createThinkingScrubState, flushThinkingScrub, scrubInlineThinkingFragment, ALL_THINK_TAGS } from '../reasoning.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, type StreamHandler, type StreamParams } from '../sse.js';
import { resolveSteerPartRefs } from '../attachmentStore.js';
import { drainSteers, steerTextOf, steersToUserParts } from '../steer.js';
import { gateToolImages, imageCapableFor, separateImageParts, IMAGE_OMITTED_NOTE } from './visionGate.js';
import {
  createLoopGuard,
  estimateTokensFromChars,
  executeCalls,
  prepareTools,
  toolCallSignature,
  wrapUpInstruction,
  type LoopStopReason,
} from '../mcp/loop.js';

/** Gemini inline part: plain text or base64 media (image/audio/video/pdf). */
type GeminiRequestPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown>; id?: string } }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

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

  const prepared = await prepareTools(settings, (tools) => ({
    functionDeclarations: tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    })),
  }));

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
    const useTools = prepared.count > 0 && !forcedStop;

    const generationConfig: Record<string, unknown> = {
      temperature: settings.temperature,
      topP: settings.topP,
      ...(settings.maxOutputTokens !== null ? { maxOutputTokens: settings.maxOutputTokens } : {}),
    };

    const budget = geminiThinkingBudget(settings.thinkingLevel, params.model, params.baseUrl);
    if (budget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget: budget };
    }

    if (settings.structuredOutputs && !useTools) {
      generationConfig.responseMimeType = 'application/json';
    }

    const body: Record<string, unknown> = {
      contents: convo,
      generationConfig,
      ...(prepared.defs && useTools
        ? {
            tools: prepared.defs,
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

    const response = await fetch(
      `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
        },
        body: JSON.stringify(body),
      },
    );

    await assertOk(response, 'Gemini');
    if (!response.body) throw new Error('Gemini returned an empty stream.');

    interface GeminiPart {
      text?: string;
      thought?: boolean;
      functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
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
    const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let usage: GeminiChunk['usageMetadata'] | undefined;
    const contentScrub = createThinkingScrubState();

    for await (const payload of iterateSse(response.body)) {
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
          const name = coerceText(part.functionCall.name) ?? part.functionCall.name;
          calls.push({
            id: part.functionCall.id ?? `${name}_${calls.length}`,
            name,
            args: part.functionCall.args ?? {},
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
      functionCall: { name: call.name, args: call.args, id: call.id },
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
          name: output.wireName as string,
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
    // DSH-STYLE STEER: drained steers ride as an ORDINARY user message — the
    // generic parts flow through the same toGeminiParts mapping as user input.
    // Wire refs resolve at this seam — the steer buffer bypasses /api/chat's
    // resolveWireRefs, so the provider would otherwise receive a dead URL.
    const steerParts = steersToUserParts(steered);
    resolveSteerPartRefs(steerParts);
    if (steered.length > 0) {
      responseParts.push(...toGeminiParts(steerParts));
    }

    convo.push({ role: 'user', parts: responseParts });
  }
}
