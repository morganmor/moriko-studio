import type { ChatMessage } from '../contracts.js';
import { parseDataUrl } from '../contracts.js';
import { anthropicThinkingBudget, anthropicMaxOutput, createThinkingScrubState, flushThinkingScrub, scrubInlineThinkingFragment, ALL_THINK_TAGS } from '../reasoning.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, type StreamHandler, type StreamParams } from '../sse.js';
import { resolveSteerPartRefs } from '../attachmentStore.js';
import { drainSteers, steerTextOf, steersToUserParts } from '../steer.js';
import { drainInjections, injectionText } from '../addons/inject.js';
import { buildSystemInstruction } from './openai.js';
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

/** Anthropic content blocks this adapter can produce from generic parts. */
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      /** String, or blocks when the result carries inline images (native vision). */
      content: string | Array<AnthropicBlock>;
      is_error?: boolean;
    };

/**
 * Tool-result content blocks: the text is authoritative; image parts from a
 * rebuilt tool message (read_file native vision) ride as base64 image blocks.
 * Unparseable data URLs are skipped — the text still lands.
 */
function toolResultBlocks(parts: Exclude<ChatMessage['content'], string | null>): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const media = parseDataUrl(part.image_url.url);
      if (media) blocks.push({ type: 'image', source: { type: 'base64', media_type: media.mime, data: media.data } });
    }
  }
  return blocks;
}

/**
 * Maps a generic message content into Anthropic blocks: images and PDFs have
 * native blocks; audio/video have none, so they degrade to a text note (the
 * model is told the file existed but cannot read it).
 */
function toAnthropicContent(content: ChatMessage['content']): string | AnthropicBlock[] {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const dataUrl = part.type === 'image_url' ? part.image_url.url : part.file.file_data;
    const name = part.type === 'file' ? part.file.filename : 'image';
    const media = parseDataUrl(dataUrl);
    if (!media) continue;
    if (media.mime.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: media.mime, data: media.data } });
    } else if (media.mime === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: media.mime, data: media.data } });
    } else {
      blocks.push({ type: 'text', text: `[Attachment not readable by this provider: ${name}]` });
    }
  }
  return blocks.length > 0 ? blocks : '';
}

/** Maps the UI thinking level onto Anthropic's `thinking.budget_tokens`. */
function thinkingConfig(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): { type: 'enabled'; budget_tokens: number } | undefined {
  const budget = anthropicThinkingBudget(level, model, baseUrl);
  return budget === undefined ? undefined : { type: 'enabled', budget_tokens: budget };
}

/**
 * Anthropic Messages adapter.
 *
 * Note on temperature: extended thinking requires `temperature` to stay at its
 * default, so the value is omitted whenever thinking is enabled rather than
 * sending something the API will reject.
 *
 * Use MCP: `tools` carry the aggregated MCP defs; `tool_use` blocks trigger
 * execution and a `tool_result` user message continues the loop.
 */
export async function streamAnthropic(params: StreamParams, onEvent: StreamHandler): Promise<void> {
  const { baseUrl, apiKey, model, messages, settings, signal } = params;
  const thinking = thinkingConfig(settings.thinkingLevel, model, baseUrl);

  const prepared = await prepareTools(settings, (tools) =>
    tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    })),
  );

  const convo: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = [];
  const imageCapable = imageCapableFor(params.model);
  for (const message of messages) {
    if (message.role === 'tool') {
      const gated = gateToolImages(
        !imageCapable && Array.isArray(message.content)
          ? (message.content.filter((part) => part.type === 'image_url') as Array<{ type: 'image_url'; image_url: { url: string } }>).map((part) => {
              const media = parseDataUrl(part.image_url.url);
              return { mime: media?.mime ?? 'image/png', dataUrl: part.image_url.url };
            })
          : undefined,
        imageCapable,
      );
      const strippedContent =
        !imageCapable && Array.isArray(message.content) && gated.omitted > 0
          ? [
              ...message.content.filter((part) => part.type !== 'image_url'),
              { type: 'text' as const, text: IMAGE_OMITTED_NOTE.repeat(gated.omitted) },
            ]
          : message.content;
      const toolBlocks: AnthropicBlock[] = [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content:
            typeof strippedContent === 'string'
              ? strippedContent
              : Array.isArray(strippedContent)
                ? toolResultBlocks(strippedContent)
                : '',
          is_error: false,
        },
      ];
      convo.push({ role: 'user', content: toolBlocks });
      continue;
    }
    const content = !imageCapable && Array.isArray(message.content)
      ? (() => {
          const { kept, dropped } = separateImageParts(message.content);
          return dropped === 0
            ? message.content
            : [...kept, { type: 'text' as const, text: IMAGE_OMITTED_NOTE.repeat(dropped) }];
        })()
      : message.content;
    const base = toAnthropicContent(content);
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks: AnthropicBlock[] = [];
      if (typeof base === 'string') {
        if (base.trim()) blocks.push({ type: 'text', text: base });
      } else {
        blocks.push(...base);
      }
      for (const call of message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          input = { _raw: call.function.arguments };
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      convo.push({ role: 'assistant', content: blocks });
      continue;
    }
    convo.push({ role: message.role, content: base });
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

    const body: Record<string, unknown> = {
      model,
      stream: true,
      max_tokens: settings.maxOutputTokens ?? anthropicMaxOutput(model),
      messages: convo,
      ...(prepared.defs && useTools
        ? {
            tools: prepared.defs,
            ...(frozen && !choiceMade
              ? { tool_choice: { type: 'tool', name: 'agent__harness_choice' } }
              : {}),
          }
        : {}),
    };

    const systemInstruction = buildSystemInstruction(params);
    if (systemInstruction) body.system = systemInstruction;

    if (thinking) {
      body.thinking = thinking;
      body.max_tokens = Math.max(
        settings.maxOutputTokens ?? anthropicMaxOutput(model),
        thinking.budget_tokens + 1024,
      );
    } else {
      body.temperature = settings.temperature;
    }

    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(body),
    });

    await assertOk(response, 'Anthropic');
    if (!response.body) throw new Error('Anthropic returned an empty stream.');

    interface AnthropicEvent {
      type: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?:
        | { type?: string; text?: string; thinking?: string; stop_reason?: string; partial_json?: string }
        | undefined;
      message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      error?: { message?: string };
    }

    let text = '';
    let stopReason: string | undefined;
    let usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    const contentScrub = createThinkingScrubState();
    const toolBlocks = new Map<
      number,
      { id: string; name: string; arguments: string; opened: boolean }
    >();

    for await (const payload of iterateSse(response.body)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(payload) as AnthropicEvent;
      } catch {
        continue;
      }

      switch (event.type) {
        case 'message_start': {
          const startUsage = event.message?.usage;
          if (startUsage) usage = { ...usage, ...startUsage };
          break;
        }
        case 'content_block_start': {
          if (event.content_block?.type === 'tool_use' && event.index !== undefined) {
            toolBlocks.set(event.index, {
              id: event.content_block.id ?? `tool_${event.index}`,
              name: event.content_block.name ?? '',
              arguments: '',
              opened: true,
            });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta;
          if (delta?.type === 'thinking_delta') {
            const thinking = coerceText(delta.thinking);
            if (thinking) {
              const clean = thinking.replace(ALL_THINK_TAGS, '');
              if (clean) onEvent({ type: 'reasoning', delta: clean });
            }
          } else if (delta?.type === 'input_json_delta' && event.index !== undefined) {
            const block = toolBlocks.get(event.index);
            if (block) {
              const partial = coerceText(delta.partial_json);
              if (partial) block.arguments += partial;
            }
          } else if (delta?.text !== undefined) {
            const textDelta = coerceText(delta.text);
            if (textDelta) {
              const scrubbed = scrubInlineThinkingFragment(textDelta, contentScrub);
              if (scrubbed.reasoning) onEvent({ type: 'reasoning', delta: scrubbed.reasoning });
              if (scrubbed.text) {
                text += scrubbed.text;
                onEvent({ type: 'text', delta: scrubbed.text });
              }
            }
          }
          break;
        }
        case 'message_delta': {
          if (event.usage) usage = { ...usage, ...event.usage };
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          break;
        }
        case 'error': {
          const errorMessage =
            coerceText(event.error?.message)?.trim() || 'Anthropic stream error.';
          flushUsage();
          onEvent({ type: 'error', message: errorMessage });
          return;
        }
        default:
          break;
      }
    }

    const contentTail = flushThinkingScrub(contentScrub);
    if (contentTail) {
      text += contentTail;
      onEvent({ type: 'text', delta: contentTail });
    }

    if (usage) {
      sawAnyUsage = true;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      // ratio computed against it exceed 100% (the "281% cache" bug).
      if (usage.input_tokens !== undefined) {
        sumPromptTokens += usage.input_tokens + cacheRead + cacheWrite;
      }
      sumCompletionTokens += usage.output_tokens ?? 0;
      sumBilledTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      sumCacheReadTokens += cacheRead;
    }

    const pendingCalls = [...toolBlocks.values()].filter((block) => block.opened && block.name);
    if (stopReason !== 'tool_use' || pendingCalls.length === 0) {
      flushUsage();
      onEvent({ type: 'done', finishReason: forcedStop ?? (stopReason ?? 'end_turn') });
      return;
    }

    const assistantBlocks: AnthropicBlock[] = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    for (const block of pendingCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = block.arguments ? (JSON.parse(block.arguments) as Record<string, unknown>) : {};
      } catch {
        input = { _raw: block.arguments };
      }
      assistantBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input });
    }
    convo.push({ role: 'assistant', content: assistantBlocks });

    if (signal?.aborted) {
      flushUsage();
      onEvent({ type: 'done', finishReason: 'aborted' });
      return;
    }

    const executed = await executeCalls(
      pendingCalls.map((block) => ({ id: block.id, wireName: block.name, rawArgs: block.arguments })),
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

    const resultBlocks: AnthropicBlock[] = executed.followUp.map((output) => {
      const gated = gateToolImages(
        output.images as Array<{ mime: string; dataUrl: string }> | undefined,
        imageCapable,
      );
      const text0 = output.text as string;
      const text = gated.omitted > 0 ? `${text0}\n\n${IMAGE_OMITTED_NOTE.repeat(gated.omitted)}` : text0;
      const content: string | AnthropicBlock[] = gated.images?.length
        ? [
            { type: 'text', text },
            ...gated.images.map((image) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: image.mime, data: image.dataUrl.replace(/^data:[^;,]+;base64,/, '') },
            })),
          ]
        : text;
      return {
        type: 'tool_result' as const,
        tool_use_id: output.id as string,
        content,
        is_error: output.ok === false,
      };
    });

    guard.record(
      pendingCalls.map((block) => toolCallSignature(block.name, block.arguments)),
      usage ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens } : undefined,
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
      resultBlocks.push({ type: 'text', text: wrapUpInstruction(forcedStop) });
    }

    const steered = drainSteers(params.sessionId);
    for (const entry of steered) onEvent({ type: 'steer', id: entry.id, text: steerTextOf(entry), parts: entry.parts });
    const steerParts = steersToUserParts(steered);
    resolveSteerPartRefs(steerParts);
    if (steered.length > 0) {
      const blocks = toAnthropicContent(steerParts);
      if (typeof blocks === 'string') {
        if (blocks) resultBlocks.push({ type: 'text', text: blocks });
      } else {
        resultBlocks.push(...blocks);
      }
    }

    // Addon v2 (A3, Q2): queued addon notices ride the same seam as steers,
    // as one labeled user block so the model AND the user see the notice.
    const injections = drainInjections(params.sessionId ?? undefined);
    for (const entry of injections) {
      onEvent({ type: 'steer', id: `addon-inject-${entry.id}`, text: `[${entry.addonId}] ${injectionText(entry)}` });
      resultBlocks.push({ type: 'text', text: `System notice from the ${entry.addonId} addon:\n${injectionText(entry)}` });
    }

    convo.push({ role: 'user', content: resultBlocks });
  }
}
