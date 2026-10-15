import { ALL_THINK_TAGS, applyReasoningEffort, createThinkingScrubState, flushThinkingScrub, scrubInlineThinkingFragment, type ThinkingScrubState } from '../reasoning.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, type StreamHandler, type StreamParams } from '../sse.js';
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
import { gateToolImages, imageCapableFor, separateImageParts, IMAGE_OMITTED_NOTE } from './visionGate.js';

/**
 * Composes the system message: the user's own System Prompt first, then the
 * harness's built-in injections (agent tools, MCP tools, structured outputs)
 * in order. The injections are built once per request by the chat route and
 * also streamed to the UI, so what the model sees is exactly inspectable.
 */
export function buildSystemInstruction(params: StreamParams): string {
  const base = params.settings.systemInstruction?.trim() ?? '';
  const extras = params.harnessInjections.map((injection) => injection.content);
  if (extras.length === 0) return base;
  return [base, ...extras].filter(Boolean).join('\n\n');
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
function splitContentBlocks(content: unknown): ContentBlockSplit {
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

  const imageCapable = imageCapableFor(params.model);
  const convo: Array<Record<string, unknown>> = [
    ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
    ...messages.map((message) => {
      if (imageCapable || !Array.isArray(message.content)) return { ...message };
      const { kept, dropped } = separateImageParts(message.content);
      if (dropped === 0) return { ...message };
      return {
        ...message,
        content: [...kept, { type: 'text', text: IMAGE_OMITTED_NOTE.repeat(dropped) }],
      };
    }),
  ];

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

  for (let iteration = 0; ; iteration += 1) {
    const useTools = prepared.count > 0 && !forcedStop;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: convo,
      temperature: settings.temperature,
      top_p: settings.topP,
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

    applyReasoningEffort(body, settings.thinkingLevel, model, params.providerId);

    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
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
    const contentScrub = createThinkingScrubState();
    const argsScrub = new Map<number, ThinkingScrubState>();
    let sawUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheReadTokens?: number } | undefined;
    let finishReason: string | undefined;
    const callsByIndex = new Map<number, PendingOpenAiCall>();

    for await (const payload of iterateSse(response.body)) {
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
        const clean = reasoning.replace(ALL_THINK_TAGS, '');
        if (clean) onEvent({ type: 'reasoning', delta: clean });
      }

      const contentDelta = blocks.text ?? coerceText(delta?.content);
      if (contentDelta) {
        const scrubbed = scrubInlineThinkingFragment(contentDelta, contentScrub);
        if (scrubbed.reasoning) onEvent({ type: 'reasoning', delta: scrubbed.reasoning });
        if (scrubbed.text) {
          text += scrubbed.text;
          onEvent({ type: 'text', delta: scrubbed.text });
        }
      }

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
            argScrub = createThinkingScrubState();
            argsScrub.set(index, argScrub);
          }
          const scrubbed = scrubInlineThinkingFragment(argsFragment, argScrub);
          if (scrubbed.text) pending.arguments += scrubbed.text;
        }
        callsByIndex.set(index, pending);
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

    const contentTail = flushThinkingScrub(contentScrub);
    if (contentTail) {
      text += contentTail;
      onEvent({ type: 'text', delta: contentTail });
    }
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
    convo.push({
      role: 'assistant',
      ...(text ? { content: text } : { content: null }),
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
    if (steerParts.length > 0) convo.push({ role: 'user', content: steerParts });

    // Addon v2 (A3, Q2): queued addon notices ride the steer seam.
    const injections = drainInjections(params.sessionId ?? undefined);
    if (injections.length > 0) {
      const injectParts: Array<{ type: 'text'; text: string }> = injections.map((entry) => {
        onEvent({ type: 'steer', id: `addon-inject-${entry.id}`, text: `[${entry.addonId}] ${injectionText(entry)}` });
        return { type: 'text', text: `System notice from the ${entry.addonId} addon:\n${injectionText(entry)}` };
      });
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
    forcedStop = guard.stopReason();

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
  }
}
