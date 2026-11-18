import type { ChatMessage } from '../contracts.js';
import { parseDataUrl } from '../contracts.js';
import {
  anthropicThinkingBudget,
  anthropicMaxOutput,
  createReasoningBlockEmitter,
  createThinkingScrubState,
  flushNativeReasoning,
  flushThinkingScrub,
  scrubThinkingFragment,
} from '../reasoning.js';
import { coerceText } from '../textUtil.js';
import { assertOk, iterateSse, type StreamHandler, type StreamParams } from '../sse.js';
import { idle, STREAM_IDLE_MS } from '../liveness.js';
import { resolveSteerPartRefs } from '../attachmentStore.js';
import { drainSteers, steerTextOf, steersToUserParts } from '../steer.js';
import { drainInjections, injectionText } from '../addons/inject.js';
import { buildSystemSegments } from './openai.js';
import { gateToolImages, imageCapableFor, separateImageParts, IMAGE_OMITTED_NOTE } from './visionGate.js';
import { ToolBuildTracker } from './toolCallProgress.js';
import {
  createLoopGuard,
  executeCalls,
  prepareTools,
  toolCallSignature,
  wrapUpInstruction,
  type LoopStopReason,
} from '../mcp/loop.js';
import { createContextMeter, createTurnUsageAccumulator, type ContextMeter, type RoundUsageInput } from '../mcp/contextMeter.js';


type CacheControl = { type: 'ephemeral' };


type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: CacheControl }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: CacheControl }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      
      content: string | Array<AnthropicBlock>;
      is_error?: boolean;
      cache_control?: CacheControl;
    };


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


function toAnthropicContent(content: ChatMessage['content']): string | AnthropicBlock[] {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'video_url') {
      blocks.push({ type: 'text', text: '[Attachment not readable by this provider: video]' });
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


let cacheControlSupported = process.env.MORIKO_DISABLE_PROMPT_CACHE !== '1';


const MESSAGE_CACHE_BREAKPOINTS = 2;

function systemBlocks(
  params: StreamParams,
  cache: boolean,
): string | AnthropicBlock[] | undefined {
  const { stable, volatile } = buildSystemSegments(params);
  if (!stable && !volatile) return undefined;
  if (!cache || !stable) return [stable, volatile].filter(Boolean).join('\n\n');
  const blocks: AnthropicBlock[] = [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
  ];
  if (volatile) blocks.push({ type: 'text', text: volatile });
  return blocks;
}


function clearMessageCache(
  convo: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }>,
): void {
  for (const message of convo) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if ('cache_control' in block) delete block.cache_control;
    }
  }
}


function markMessageCache(
  convo: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }>,
): void {
  let marked = 0;
  for (let index = convo.length - 1; index >= 0 && marked < MESSAGE_CACHE_BREAKPOINTS; index -= 1) {
    const message = convo[index];
    if (typeof message.content === 'string') {
      if (!message.content.trim()) continue;
      message.content = [
        { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } },
      ];
      marked += 1;
      continue;
    }
    const last = message.content[message.content.length - 1];
    if (!last || last.type === 'tool_use') continue;
    last.cache_control = { type: 'ephemeral' };
    marked += 1;
  }
}


function thinkingConfig(
  level: StreamParams['settings']['thinkingLevel'],
  model: string,
  baseUrl: string,
): { type: 'enabled'; budget_tokens: number } | undefined {
  const budget = anthropicThinkingBudget(level, model, baseUrl);
  return budget === undefined ? undefined : { type: 'enabled', budget_tokens: budget };
}


export async function streamAnthropic(params: StreamParams, onEvent: StreamHandler): Promise<void> {
  const { baseUrl, apiKey, model, messages, settings, signal } = params;
  const thinking = thinkingConfig(settings.thinkingLevel, model, baseUrl);
  
  const meter: ContextMeter = createContextMeter({
    systemInstruction: '',
    systemSegments: [],
    toolDefsChars: 0,
    messages,
  });
  {
    const { stable, volatile } = buildSystemSegments(params);
    meter.addSystemSegments([stable, volatile].filter(Boolean).join('\n\n'));
  }
  meter.repriceToolMessages(messages.filter((message) => message.role === 'tool').length);

  const prepared = await prepareTools(settings, (tools) =>
    tools.map((tool) => ({
      name: tool.wireName,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    })),
  );

  const convo: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = [];
  const imageCapable = await imageCapableFor(params.model, params.providerId, params.capability);
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

  
  const post = (payload: Record<string, unknown>, fetchSignal: AbortSignal): Promise<Response> =>
    fetch(`${baseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      signal: fetchSignal,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(payload),
    });

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

    const buildBody = (cache: boolean): Record<string, unknown> => {
      clearMessageCache(convo);
      if (cache) markMessageCache(convo);
      const system = systemBlocks(params, cache);
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
        ...(system ? { system } : {}),
      };
      if (thinking) {
        body.thinking = thinking;
        body.max_tokens = Math.max(
          settings.maxOutputTokens ?? anthropicMaxOutput(model),
          thinking.budget_tokens + 1024,
        );
      } else {
        body.temperature = settings.temperature;
      }
      return body;
    };

    const cache = cacheControlSupported;
    let response = await post(buildBody(cache), streamIdle.signal);
    if (!response.ok && cache) {
      const detail = await response.text().catch(() => '');
      if (/cache_control/i.test(detail)) {
        cacheControlSupported = false;
        response = await post(buildBody(false), streamIdle.signal);
      } else {
        await assertOk(new Response(detail, { status: response.status }), 'Anthropic');
      }
    }

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
    const nativeScrub = createThinkingScrubState('native');
    let stopReason: string | undefined;
    let usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    const contentScrub = createThinkingScrubState();
    const toolBlocks = new Map<
      number,
      { id: string; name: string; arguments: string; opened: boolean }
    >();
    
    const buildTracker = new ToolBuildTracker();

    for await (const payload of iterateSse(response.body, () => streamIdle.reset())) {
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
              meter.addReasoningChars(thinking.length);
              meter.maybeEmit(onEvent);
              const routed = scrubThinkingFragment(thinking, nativeScrub);
              if (routed.reasoning) reasoningBlocks.push(routed.reasoning);
            }
          } else if (delta?.type === 'input_json_delta' && event.index !== undefined) {
            reasoningBlocks.end();
            const block = toolBlocks.get(event.index);
            if (block) {
              const partial = coerceText(delta.partial_json);
              if (partial) block.arguments += partial;
              const isFirst = !buildTracker.sawAnyFragment;
              buildTracker.ingest(event.index, isFirst ? block.name : '', partial ?? '');
              buildTracker.maybeEmit(onEvent, isFirst);
            }
          } else if (delta?.text !== undefined) {
            const textDelta = coerceText(delta.text);
            if (textDelta) {
              reasoningBlocks.end();
              const scrubbed = scrubThinkingFragment(textDelta, contentScrub);
              if (scrubbed.reasoning) {
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

    const nativeTail = flushNativeReasoning(nativeScrub);
    if (nativeTail) {
      meter.addReasoningChars(nativeTail.length);
      reasoningBlocks.push(nativeTail);
    }
    reasoningBlocks.end();
    const contentTail = flushThinkingScrub(contentScrub);
    if (contentTail) {
      text += contentTail;
      meter.addOutputChars(contentTail.length);
      onEvent({ type: 'text', delta: contentTail });
    }

    const roundUsage: RoundUsageInput | undefined = usage
      ? {
          promptTokens:
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
          completionTokens: usage.output_tokens ?? 0,
          totalTokens:
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.output_tokens ?? 0),
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        }
      : undefined;

    const anthropicBilled = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined;

    const pendingCalls = [...toolBlocks.values()].filter((block) => block.opened && block.name);
    if (stopReason !== 'tool_use' || pendingCalls.length === 0) {
      if (roundUsage) {
        guard.record([], roundUsage, 0);
        meter.recordUsage(roundUsage);
        usageAcc.record(roundUsage, anthropicBilled);
        onEvent({ type: 'context_telemetry', ...guard.telemetry() });
        meter.flush(onEvent);
      }
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
    meter.addCompletionToolChars(
      assistantBlocks.reduce((sum, block) => (block.type === 'tool_use' ? sum + block.name.length + JSON.stringify(block.input).length : sum), 0),
    );
    if (roundUsage) {
      meter.recordUsage(roundUsage);
      usageAcc.record(roundUsage, anthropicBilled);
    }
    meter.advanceRound({ keepReasoning: false });
    convo.push({ role: 'assistant', content: assistantBlocks });

    if (signal?.aborted) {
      if (meter.hasUsage()) meter.flush(onEvent);
      flushUsage();
      onEvent({ type: 'done', finishReason: 'aborted' });
      return;
    }

    freeze.lastReasoning = reasoningBlocks.lastBlockText;
    const executed = await executeCalls(
      pendingCalls.map((block) => ({ id: block.id, wireName: block.name, rawArgs: block.arguments })),
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
      resultBlocks.push({ type: 'text', text: wrapUpInstruction(forcedStop) });
    }

    const steered = drainSteers(params.sessionId);
    for (const entry of steered) onEvent({ type: 'steer', id: entry.id, text: steerTextOf(entry), parts: entry.parts });
    const steerParts = steersToUserParts(steered);
    resolveSteerPartRefs(steerParts);
    if (steered.length > 0) {
      const blocks = toAnthropicContent(steerParts);
      if (typeof blocks === 'string') {
        if (blocks) {
          meter.addInputChars(blocks.length);
          resultBlocks.push({ type: 'text', text: blocks });
        }
      } else {
        meter.addInputChars(JSON.stringify(blocks).length);
        resultBlocks.push(...blocks);
      }
    }

    const injections = drainInjections(params.sessionId ?? undefined);
    for (const entry of injections) {
      onEvent({ type: 'steer', id: `addon-inject-${entry.id}`, text: `[${entry.addonId}] ${injectionText(entry)}` });
      const notice = `System notice from the ${entry.addonId} addon:\n${injectionText(entry)}`;
      meter.addInputChars(notice.length);
      resultBlocks.push({ type: 'text', text: notice });
    }

    convo.push({ role: 'user', content: resultBlocks });
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
