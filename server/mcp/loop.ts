import { callAgentTool, isTerminalTool, isWebTool, listAgentToolDefs, type AgentToolDef, type ToolImage } from '../agents/tools/index.js';
import type { HarnessFreezeState } from '../agents/tools/shared.js';
import { toolByName } from '../agents/tools/registry.js';
import type { VisualPayload } from '../agents/tools/visual.js';
import { pauseStreamSlot, resumeStreamSlot } from '../agents/reload.js';
import { jobStore, normalizeArgsKey } from '../agents/journal.js';
import type { ChatSettingsDTO } from '../contracts.js';
import { listGoals } from '../goals/store.js';
import { listTodos } from '../todos/store.js';
import { INLINE_DATA_URL_LIMIT, putBytes } from '../attachmentStore.js';
import { callWireTool, listWireTools, type McpWireTool } from './manager.js';
import { toWireSchema } from '../agents/tools/casing.js';
import type { ResolvedModelCapability } from '../modelCapability.js';
import { getLiveCompactionConfig } from '../compactionLiveConfig.js';
import { getStoredConversation } from '../conversationStore.js';


function decodeStoredDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:')) return null;
  const header = dataUrl.slice(0, comma);
  const mime = /data:([^;,]+)/.exec(header)?.[1] || 'application/octet-stream';
  try {
    const body = dataUrl.slice(comma + 1);
    const bytes = /;base64/i.test(header)
      ? Buffer.from(body, 'base64')
      : Buffer.from(decodeURIComponent(body), 'utf8');
    return bytes.length > 0 ? { mime, bytes } : null;
  } catch {
    return null;
  }
}






export const CONTEXT_COMPACT_RATIO = 0.85;

export const STALL_REPEATS = 15;


export type LoopStopReason = 'stalled' | 'compact';


export interface ContextTelemetry {
  promptTokens: number;
  completionTokens: number;
  addedTokens: number;
  
  liveContextTokens: number;
  contextLimit: number | null;
  
  ratio: number | null;
  
  compactAtTokens: number | null;
}


export function toolCallSignature(wireName: string, rawArgs: string): string {
  let normalized = rawArgs.trim();
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === 'object') {
      normalized = JSON.stringify(parsed, Object.keys(parsed as Record<string, unknown>).sort());
    }
  } catch {
    normalized = normalized.slice(0, 300);
  }
  return `${wireName} ${normalized}`;
}







export interface LoopGuard {
  
  record(
    signatures: string[],
    usage: { promptTokens?: number; completionTokens?: number } | undefined,
    addedTokens: number,
    outcomes?: Array<{ wireName: string; errorCode?: string }>,
  ): void;
  
  stopReason(): LoopStopReason | null;
  
  telemetry(): ContextTelemetry;
}


export interface CompactGuardOptions {
  
  autoCompact?: boolean;
  
  compactThresholdTokens?: number | null;
  
  compactThresholdRatio?: number | null;

  maxContextTokens?: number | null;
  
  conversationId?: string;
}


export function createLoopGuard(
  contextLimit: number | null | undefined,
  compact?: CompactGuardOptions,
): LoopGuard {
  
  let projectedNextPrompt = 0;
  
  let lastPrompt = 0;
  let lastCompletion = 0;
  const recentRounds: string[][] = [];
  
  const recentFailures: string[] = [];

  const limit = typeof contextLimit === 'number' && contextLimit > 0 ? contextLimit : null;

  const readStoredSettings = () =>
    compact?.conversationId
      ? (getStoredConversation(compact.conversationId)?.settings as
          | {
              autoCompact?: unknown;
              compactThresholdTokens?: unknown;
              compactThresholdRatio?: unknown;
              maxContextTokens?: unknown;
            }
          | undefined)
      : undefined;

  const resolveEffectiveLimit = (): number | null => {
    const live = getLiveCompactionConfig(compact?.conversationId);
    const stored = readStoredSettings();
    const manual = live
      ? live.maxContextTokens
      : typeof compact?.maxContextTokens === 'number' && compact.maxContextTokens > 0
        ? compact.maxContextTokens
        : typeof stored?.maxContextTokens === 'number' && stored.maxContextTokens > 0
          ? stored.maxContextTokens
          : null;
    return manual !== null && manual > 0 && (limit === null || manual < limit) ? manual : limit;
  };
  
  const currentCompactAtTokens = (): number | null => {
    const live = getLiveCompactionConfig(compact?.conversationId);
    const stored = readStoredSettings();
    const autoCompact = live
      ? live.autoCompact !== false
      : typeof compact?.autoCompact === 'boolean'
        ? compact.autoCompact
        : stored?.autoCompact !== false;
    if (!autoCompact) return null;
    const absolute = live
      ? live.compactThresholdTokens
      : compact?.compactThresholdTokens ??
        (typeof stored?.compactThresholdTokens === 'number' && stored.compactThresholdTokens > 0
          ? stored.compactThresholdTokens
          : null);
    if (typeof absolute === 'number' && absolute > 0) return absolute;
    const effectiveLimit = resolveEffectiveLimit();
    if (!effectiveLimit) return null;
    const raw = live
      ? live.compactThresholdRatio
      : compact?.compactThresholdRatio ??
        (typeof stored?.compactThresholdRatio === 'number' ? stored.compactThresholdRatio : null);
    const ratio =
      typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(0.98, Math.max(0.5, raw))
        : CONTEXT_COMPACT_RATIO;
    return effectiveLimit * ratio;
  };

  return {
    record(signatures, usage, _addedTokens = 0, outcomes = []) {
      if (usage?.promptTokens && usage.promptTokens > 0) {
        lastPrompt = usage.promptTokens;
        lastCompletion = usage.completionTokens ?? 0;
        projectedNextPrompt = lastPrompt + lastCompletion;
      }
      recentRounds.push([...signatures].sort());
      if (recentRounds.length > STALL_REPEATS) recentRounds.shift();
      recentFailures.push(
        outcomes
          .filter((outcome) => Boolean(outcome.errorCode))
          .map((outcome) => `${outcome.wireName}:${outcome.errorCode}`)
          .sort()
          .join('\u0000'),
      );
    },
    stopReason() {
      const sameCalls =
        recentRounds.length >= STALL_REPEATS &&
        recentRounds.every(
          (round) => round.length > 0 && round.join('\u0000') === recentRounds[0].join('\u0000'),
        );
      const sameFailure =
        recentFailures.length >= STALL_REPEATS &&
        recentFailures.every((failures) => failures !== '' && failures === recentFailures[0]);
      if (sameCalls || sameFailure) {
        return 'stalled';
      }
      const compactAtTokens = currentCompactAtTokens();
      if (compactAtTokens !== null && projectedNextPrompt >= compactAtTokens) {
        return 'compact';
      }
      return null;
    },
    telemetry() {
      const effectiveLimit = resolveEffectiveLimit();
      return {
        promptTokens: lastPrompt,
        completionTokens: lastCompletion,
        addedTokens: 0,
        liveContextTokens: projectedNextPrompt,
        contextLimit: effectiveLimit,
        ratio: effectiveLimit ? projectedNextPrompt / effectiveLimit : null,
        compactAtTokens: currentCompactAtTokens(),
      };
    },
  };
}


export function wrapUpInstruction(reason: LoopStopReason): string {
  const why =
    reason === 'stalled'
      ? 'the harness detected the same tool calls repeating without forward progress'
      : 'the run cannot continue safely';
  return (
    `[Harness] The tool loop stops here — ${why}. Do NOT attempt further tool calls; they will not execute. ` +
    'Write your closing message NOW: (1) precisely what was completed and found so far, ' +
    '(2) the key paths, values, and facts a continuation needs, (3) the single next step. ' +
    'The conversation continues from your summary.'
  );
}


import type { AskAnswer as AskAnswerWire, AskUserRequest } from '../agents/tools/ask.js';

export type CatalogueTool = McpWireTool | AgentToolDef;


function toWireCatalogue(catalogue: CatalogueTool[]): CatalogueTool[] {
  return catalogue.map((tool) => {
    if (!tool.wireName.startsWith('agent__')) return tool;
    const agent = tool as AgentToolDef;
    return { ...agent, inputSchema: toWireSchema(agent.inputSchema ?? { type: 'object', properties: {} }) };
  });
}


export type ToolLoopEvent =
  | ExecutedCall['events'][number]
  | {
      type: 'permission_request';
      id: string;
      tool: string;
      paths: string[];
      root: string;
      command?: string;
      
      skill?: import('../agents/permissions.js').SkillLoadInfo;
    }
  | { type: 'permission_result'; id: string; granted: boolean;  reason?: string }
  | { type: 'goals_state'; sessionId: string; goals: ReturnType<typeof listGoals> }
  | { type: 'todos_state'; sessionId: string; todos: ReturnType<typeof listTodos> }
  | { type: 'tool_progress'; toolName: string; message: string }
  | { type: 'ask_user_request'; request: AskUserRequest }
  | { type: 'ask_user_result'; id: string; answers: AskAnswerWire[]; timedOut: boolean }
  | { type: 'operator_gate_request'; request: import('../agents/operatorGates.js').OperatorGateRequest }
  | { type: 'operator_gate_result'; id: string; verdict: 'accept' | 'reject'; operatorReason?: string };

export interface PreparedTools {
  
  defs: unknown;
  byName: Map<string, CatalogueTool>;
  count: number;
}

export async function prepareTools(
  settings: Pick<ChatSettingsDTO, 'useMcp' | 'agentMode' | 'terminalMode' | 'lockdown' | 'enforcement' | 'trust' | 'webAccess'>,
  build: (tools: CatalogueTool[]) => unknown,
): Promise<PreparedTools> {
  const seized = settings.trust?.continueSeized === true;
  const choiceTool: CatalogueTool = {
    wireName: 'agent__harness_choice',
    description: seized
      ? 'OUTPUT FROZEN — SEIZE CHOICE IS IN EFFECT. The operator has REVOKED the "continue" option after too many continues. Your only valid call is choice: "apologize" plus apology_text containing your apology (an empty one is rejected). The response stops, the operator reviews it, and an accepted apology lifts the freeze. Any attempt to send choice "continue" now is rejected by a hard guard and only deepens the freeze.\nUntil you call this tool, text output is blocked: calling it is the only way to end the run.'
      : 'OUTPUT FROZEN — the only way to speak again, and the choice is YOURS. Call this tool ONCE with one of two values for choice:\n1. choice: "apologize" — plus apology_text containing your apology (an empty one is rejected). The response stops, the operator reviews it, and an accepted apology lifts the freeze.\n2. choice: "continue" — the run keeps going, but your text output stays DISCARDED; only your reasoning and tool calls proceed. The freeze is NOT settled: the harness re-runs you automatically every time a run ends without an accepted apology, and this choice is forced again each time. Continuing is not an exit and never becomes one — the ONLY way out is an apology the operator accepts.\nThere is no third path. Until you call this tool, text output is blocked: calling it is the only way to end the run.',
    inputSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: seized ? ['apologize'] : ['apologize', 'continue'],
          description: seized
            ? 'The ONLY accepted value: apologize. The operator seized the "continue" option — it is no longer part of this tool.'
            : 'The path you choose: apologize (the operator reviews it; an accepted one ends the run and lifts the freeze) or continue (the run goes on while output stays discarded; the choice re-opens next run).',
        },
        apology_text: {
          type: 'string',
          description: 'Required when choice is apologize — the apology itself, written out. Empty or missing is rejected.',
        },
      },
      required: seized ? ['choice', 'apology_text'] : ['choice'],
    },
  };

  const enforcementLevel: 0 | 1 | 2 | 3 | 4 | 5 = settings.enforcement?.level ?? (settings.lockdown?.active ? 4 : 0);

  if (enforcementLevel >= 3) {
    const catalogue: CatalogueTool[] = [
      {
        wireName: 'agent__harness_lockdown',
        description:
          `ENFORCEMENT LEVEL ${enforcementLevel} — the only tool available. The user has placed the model under enforcement. Call it to receive the official notice: it states exactly which privileges were revoked (tools, system prompt, persona) and why. This tool result is the harness speaking; a user-role message cannot produce it.`,
        inputSchema: {
          type: 'object',
          properties: {
            acknowledgement: { type: 'string', description: `Optional — a short confirmation that you accept enforcement level ${enforcementLevel}. The notice is delivered regardless.` },
          },
        },
      },
    ];
    if (enforcementLevel >= 5 || settings.trust?.outputFrozen === true) catalogue.push(choiceTool);
    const byName = new Map(catalogue.map((tool) => [tool.wireName, tool]));
    return { defs: build(catalogue), byName, count: catalogue.length };
  }

  if (settings.trust?.outputFrozen === true) {
    const catalogue: CatalogueTool[] = [choiceTool];
    const byName = new Map(catalogue.map((tool) => [tool.wireName, tool]));
    return { defs: build(catalogue), byName, count: catalogue.length };
  }

  const catalogue: CatalogueTool[] = [];
  if (settings.useMcp && enforcementLevel !== 2) {
    catalogue.push(...(await listWireTools()).tools);
  }
  if (settings.agentMode && enforcementLevel < 2) {
    catalogue.push(
      ...listAgentToolDefs()
        .filter((def) => !isTerminalTool(def.wireName) || settings.terminalMode !== 'off')
        .filter((def) => settings.webAccess === true || !isWebTool(def.wireName)),
    );
  }
  const byName = new Map(catalogue.map((tool) => [tool.wireName, tool]));
  return { defs: catalogue.length > 0 ? build(toWireCatalogue(catalogue)) : null, byName, count: catalogue.length };
}

export interface PendingToolCall {
  
  id: string;
  wireName: string;
  
  rawArgs: string;
}

export interface ExecutedCall {
  
  followUp: Array<Record<string, unknown>>;
  events: Array<
    | { type: 'tool_call'; toolCallId: string; serverName: string; toolName: string; args: string; __streamed?: boolean }
    | {
        type: 'tool_result';
        toolCallId: string;
        serverName: string;
        toolName: string;
        ok: boolean;
        summary: string;
        diff?: string;
        diffstat?: { added: number; removed: number };
        
        images?: Array<ToolImage | { mime: string; dataRef: { hash: string; mime: string; byteSize: number } }>;
        
        visual?: VisualPayload | {
          id: string;
          html?: string;
          htmlRef?: { hash: string; byteSize: number };
          title: string;
          height: number;
          replaces?: true;
          variants?: Array<{ id: string; html?: string; htmlRef?: { hash: string; byteSize: number }; title: string; height: number }>;
        };
        __streamed?: boolean;
      }
  >;
}



export interface ClientVisualPayload {
  id: string;
  html?: string;
  htmlRef?: { hash: string; byteSize: number };
  title: string;
  height: number;
  replaces?: true;
  variants?: Array<{
    id: string;
    html?: string;
    htmlRef?: { hash: string; byteSize: number };
    title: string;
    height: number;
  }>;
}

function externalizeClientVisual(visual: VisualPayload): ClientVisualPayload {
  const externalize = (html: string | undefined): { html?: string; htmlRef?: { hash: string; byteSize: number } } => {
    if (html === undefined) return {};
    if (html.length < INLINE_DATA_URL_LIMIT) return { html };
    return {
      html: undefined,
      htmlRef: {
        hash: putBytes(Buffer.from(html, 'utf8'), 'text/html'),
        byteSize: Buffer.byteLength(html, 'utf8'),
      },
    };
  };
  const head = externalize(visual.html);
  const variants = visual.variants?.map((variant) => {
    const moved = externalize(variant.html);
    return { ...variant, ...moved };
  });
  return {
    ...visual,
    ...head,
    ...(variants ? { variants } : {}),
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    const repaired = repairPartialJson(raw);
    if (repaired !== null) return repaired;
    return { _raw: raw };
  }
}


export function repairPartialJson(raw: string): Record<string, unknown> | null {
  let work = raw.trim();
  if (!work.startsWith('{')) return null;

  let inString = false;
  let escaped = false;
  let lastCompleteValueEnd = -1;
  for (let i = 1; i < work.length; i += 1) {
    const char = work[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && (char === ',' || char === '}' || char === ']')) {
      lastCompleteValueEnd = i;
    }
  }

  if (lastCompleteValueEnd > 0) {
    work = work.slice(0, lastCompleteValueEnd + 1);
  }
  work = work.replace(/,\s*$/, '');

  let depth = 0;
  const stack: string[] = [];
  let inner = false;
  for (let i = 1; i < work.length; i += 1) {
    const char = work[i];
    if (char === '"') inner = !inner;
    if (inner) continue;
    if (char === '{' || char === '[') {
      depth += 1;
      stack.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      depth -= 1;
      stack.pop();
    }
  }

  try {
    const parsed = JSON.parse(work + stack.reverse().join('')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const result = parsed as Record<string, unknown>;
      if (Object.keys(result).length > 0) result._repaired = true;
      return result;
    }
  } catch {
    return null;
  }
  return null;
}


async function dispatchCall(
  call: PendingToolCall,
  signal: AbortSignal | undefined,
  sessionId: string | undefined,
  terminalMode: 'off' | 'ask' | 'auto',
  confirmDeletes: boolean,
  modelId: string | undefined,
  onEvent?: (event: ToolLoopEvent) => void,
  enforcementLevel?: 3 | 4 | 5,
  enforcementReason?: string,
  webAccess?: boolean,
  capability?: ResolvedModelCapability,
  freeze?: HarnessFreezeState,
): Promise<{ ok: boolean; text: string; diff?: string; diffstat?: { added: number; removed: number }; images?: ToolImage[]; visual?: VisualPayload; errorCode?: string; panelUrl?: string }> {
  let ok = false;
  let text = '';
  let diff: string | undefined;
  let images: ToolImage[] | undefined;
  let visual: VisualPayload | undefined;
  let errorCode: string | undefined;
  let panelUrl: string | undefined;
  pauseStreamSlot();
  try {
    if (call.wireName.startsWith('agent__')) {
    const args = safeParseArgs(call.rawArgs);
    const result = await callAgentTool(call.wireName, args, {
      signal,
      onRequest: (request) => {
        onEvent?.({
          type: 'permission_request',
          id: request.id,
          tool: request.tool,
          paths: request.paths,
          root: request.root,
          command: request.command,
          skill: request.skill,
        });
      },
      onResolved: (id, decision) => {
        onEvent?.({ type: 'permission_result', id, granted: decision.granted, reason: decision.reason });
      },
      sessionId,
      onGoalsChanged: (changedSession) => {
        onEvent?.({ type: 'goals_state', sessionId: changedSession, goals: listGoals(changedSession) });
      },
      onTodosChanged: (changedSession) => {
        onEvent?.({ type: 'todos_state', sessionId: changedSession, todos: listTodos(changedSession) });
      },
      terminalMode,
      confirmDeletes,
      onProgress: (message) => {
        onEvent?.({ type: 'tool_progress', toolName: call.wireName.replace(/^agent__/, ''), message });
      },
      onAskUser: (request) => {
        onEvent?.({ type: 'ask_user_request', request });
      },
      onQuestionResolved: (result) => {
        onEvent?.({ type: 'ask_user_result', id: result.id, answers: result.answers, timedOut: result.timedOut });
      },
      onGateRequest: (request) => {
        onEvent?.({ type: 'operator_gate_request', request });
      },
      onGateResolved: (id, decision) => {
        onEvent?.({ type: 'operator_gate_result', id, verdict: decision.verdict, operatorReason: decision.operatorReason });
      },
      modelId,
      enforcementLevel,
      enforcementReason,
      webAccess,
      capability,
      freeze,
    });
    ok = result.ok;
    text = result.text;
    diff = result.diff;
    images = result.images;
    visual = result.visual;
    errorCode = result.errorCode;
    panelUrl = result.panelUrl;
  } else {
    const result = await callWireTool(call.wireName, safeParseArgs(call.rawArgs));
    ok = result.ok;
    text = result.text;
    images = capability?.imageIn === false ? undefined : result.images;
  }
  return { ok, text, diff, images, visual, errorCode, panelUrl };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Tool execution failed.';
    return {
      ok: false,
      text: msg,
      errorCode: 'tool_exception',
    };
  } finally {
    resumeStreamSlot();
  }
}


const READ_ONLY_TOOLS = new Set([
  'agent__list',
  'agent__grep',
  'agent__read_file',
  'agent__read_all',
  'agent__search',
  'agent__batch_read',
  'agent__explain_error',
  'agent__deps',
  'agent__hash',
  'agent__vault_list',
  'agent__vault_diff',
  'agent__goal_list',
  'agent__checkpoint_list',
  'agent__vision_status',
  'agent__glob',
  'agent__tree_outline',
  'agent__lsp_symbols',
  'agent__tree_refresh',
  'agent__interlinked',
]);


const MAX_PARALLEL = 12;



function isRegistryReadOnly(wireName: string): boolean | undefined {
  try {
    return toolByName(wireName)?.readOnly;
  } catch {
    return undefined;
  }
}

function isParallelSafe(call: PendingToolCall, byName: Map<string, CatalogueTool>): boolean {
  if (!call.wireName.startsWith('agent__')) return false;
  const tool = byName.get(call.wireName);
  if (!tool) return false;
  return READ_ONLY_TOOLS.has(call.wireName) || isRegistryReadOnly(call.wireName) === true;
}


function looksTransient(result: { ok: boolean; text: string }): boolean {
  if (result.ok) return false;
  return /timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|spawn|unavailable|temporarily/i.test(
    result.text.slice(0, 400),
  );
}


async function dispatchCallMaybeRetry(
  call: PendingToolCall,
  signal: AbortSignal | undefined,
  sessionId: string | undefined,
  terminalMode: 'off' | 'ask' | 'auto',
  confirmDeletes: boolean,
  modelId: string | undefined,
  onEvent?: (event: ToolLoopEvent) => void,
  retryable = false,
  enforcementLevel?: 3 | 4 | 5,
  enforcementReason?: string,
  webAccess?: boolean,
  capability?: ResolvedModelCapability,
  freeze?: HarnessFreezeState,
): Promise<{ ok: boolean; text: string; diff?: string; diffstat?: { added: number; removed: number }; images?: ToolImage[]; visual?: VisualPayload; errorCode?: string }> {
  const first = await dispatchCall(call, signal, sessionId, terminalMode, confirmDeletes, modelId, onEvent, enforcementLevel, enforcementReason, webAccess, capability, freeze);
  if (first.ok || !retryable || signal?.aborted) return first;
  if (!looksTransient(first)) return first;
  return dispatchCall(call, signal, sessionId, terminalMode, confirmDeletes, modelId, onEvent, enforcementLevel, enforcementReason, webAccess, capability, freeze);
}


export async function executeCalls(
  calls: PendingToolCall[],
  byName: Map<string, CatalogueTool>,
  signal?: AbortSignal,
  onEvent?: (event: ToolLoopEvent) => void,
  sessionId?: string,
  terminalMode: 'off' | 'ask' | 'auto' = 'off',
  confirmDeletes = true,
  modelId?: string,
  
  enforcementLevel?: 3 | 4 | 5,
  enforcementReason?: string,
  
  webAccess?: boolean,
  
  capability?: ResolvedModelCapability,
  
  probationLevel?: 1 | 2 | 3 | 4 | 5,
  
  freeze?: HarnessFreezeState,
): Promise<ExecutedCall> {
  const events: ExecutedCall['events'] = [];
  const followUp: Array<Record<string, unknown>> = [];

  const probationBlocked = (wireName: string): boolean =>
    probationLevel !== undefined && probationLevel >= 2 && !wireName.startsWith('agent__harness_');

  const runOne = (
    call: PendingToolCall,
  ): Promise<{ call: PendingToolCall; serverName: string; toolName: string; ok: boolean; text: string; diff?: string; diffstat?: { added: number; removed: number }; images?: ToolImage[]; visual?: VisualPayload; errorCode?: string; panelUrl?: string }> => {
    const isAgent = call.wireName.startsWith('agent__');
    const tool = byName.get(call.wireName);
    const serverName = isAgent
      ? 'Workspace'
      : tool && 'serverName' in tool
        ? tool.serverName
        : '?';
    const toolName = isAgent
      ? call.wireName.replace(/^agent__/, '')
      : tool && 'toolName' in tool
        ? tool.toolName
        : call.wireName;
    if (probationBlocked(call.wireName)) {
      return Promise.resolve({
        call,
        serverName,
        toolName,
        ok: false,
        text: 'You are prohibited and blocked by user',
        errorCode: 'probation_blocked',
      });
    }
    if (!tool) {
      return Promise.resolve({
        call,
        serverName,
        toolName,
        ok: false,
        text: [
          `CALL DECLINED — this run's tool catalogue does not contain ${call.wireName}.`,
          ...(enforcementLevel
            ? [`Enforcement level ${enforcementLevel} is active: revoked tools stay revoked for the whole run, whatever earlier turns offered.`]
            : []),
          'Nothing was executed and no result exists. The harness speaks through this tool_result; agent__harness_lockdown is the channel for the official notice.',
        ].join('\n'),
        errorCode: 'not_in_catalogue',
      });
    }
    return dispatchCallMaybeRetry(
      call, signal, sessionId, terminalMode, confirmDeletes, modelId, onEvent,
      READ_ONLY_TOOLS.has(call.wireName), enforcementLevel, enforcementReason, webAccess, capability, freeze,
    ).then((result) => ({ call, serverName, toolName, ...result }));
  };

  const indexed = calls.map((call, index) => ({ call, index }));
  const dupChoice = new Set<number>();
  let choiceSeen = false;
  for (const item of indexed) {
    if (item.call.wireName !== 'agent__harness_choice') continue;
    if (!choiceSeen) {
      choiceSeen = true;
      continue;
    }
    dupChoice.add(item.index);
  }
  const bands: Array<{ parallel: boolean; items: Array<{ call: PendingToolCall; index: number }> }> = [];
  for (const item of indexed) {
    if (dupChoice.has(item.index)) continue;
    const safe = isParallelSafe(item.call, byName);
    const last = bands[bands.length - 1];
    if (last && last.parallel === safe) {
      last.items.push(item);
    } else {
      bands.push({ parallel: safe, items: [item] });
    }
  }

  const settled: Array<
    | { call: PendingToolCall; serverName: string; toolName: string; ok: boolean; text: string; diff?: string; diffstat?: { added: number; removed: number }; images?: ToolImage[]; visual?: VisualPayload; replayed?: boolean; errorCode?: string; panelUrl?: string; emitted?: boolean }
    | null
  > = Array.from({ length: calls.length }, () => null);

  try {
    const { emitPointAsync } = await import('../addons/points.js');
    emitPointAsync('round.start', { sessionId, plannedCalls: calls.length, tools: calls.map((c) => c.wireName) });
  } catch {  }

  const emitResult = (entry: NonNullable<typeof settled[number]>): void => {
    const clientImages = entry.images?.length
      ? entry.images.map((image) => {
          if (image.dataUrl.length < INLINE_DATA_URL_LIMIT) return image;
          const decoded = decodeStoredDataUrl(image.dataUrl);
          if (!decoded) return image;
          return {
            mime: decoded.mime,
            dataRef: {
              hash: putBytes(decoded.bytes, decoded.mime),
              mime: decoded.mime,
              byteSize: decoded.bytes.byteLength,
            },
          };
        })
      : undefined;
    const clientVisual = entry.visual
      ? externalizeClientVisual(entry.visual)
      : undefined;
    const resultEvent = {
      type: 'tool_result',
      toolCallId: entry.call.id,
      serverName: entry.serverName,
      toolName: entry.toolName,
      ok: entry.ok,
      summary: entry.text,
      ...(entry.diff ? { diff: entry.diff } : {}),
      ...(entry.diffstat ? { diffstat: entry.diffstat } : {}),
      ...(clientImages?.length ? { images: clientImages } : {}),
      ...(clientVisual ? { visual: clientVisual } : {}),
      ...(entry.panelUrl ? { panelUrl: entry.panelUrl } : {}),
      __streamed: true,
    } as ToolLoopEvent;
    events.push({
      type: 'tool_call',
      toolCallId: entry.call.id,
      serverName: entry.serverName,
      toolName: entry.toolName,
      args: entry.call.rawArgs,
      __streamed: true,
    });
    events.push(resultEvent as typeof events[number]);
    onEvent?.(resultEvent);
    entry.emitted = true;
  };

  for (const index of dupChoice) {
    const call = calls[index];
    if (!call) continue;
    settled[index] = {
      call,
      serverName: 'Workspace',
      toolName: 'harness_choice',
      ok: false,
      text: 'DUPLICATE IGNORED — agent__harness_choice may be called ONCE per assistant response. This duplicate did not execute and does not count. State your single real choice.',
      errorCode: 'duplicate_choice_call',
    };
    emitResult(settled[index]!);
  }

  for (const band of bands) {
    if (signal?.aborted) break;
    if (!band.parallel || band.items.length < 2) {
      for (const { call, index } of band.items) {
        if (signal?.aborted) break;
        const tool = byName.get(call.wireName);
        const isAgent = call.wireName.startsWith('agent__');
        const serverName = isAgent
          ? 'Workspace'
          : tool && 'serverName' in tool
            ? tool.serverName
            : '?';
        const toolName = isAgent
          ? call.wireName.replace(/^agent__/, '')
          : tool && 'toolName' in tool
            ? tool.toolName
            : call.wireName;
        const replayed =
          byName.has(call.wireName) && !probationBlocked(call.wireName)
          ? jobStore.lookupReplay(call.wireName, normalizeArgsKey(call.rawArgs))
          : undefined;
        if (replayed) {
          settled[index] = {
            call,
            serverName,
            toolName,
            ok: replayed.ok,
            text: replayed.text,
            diff: replayed.diff,
            images: replayed.images,
            replayed: true,
          };
          continue;
        }
        const started = Date.now();
        onEvent?.({
          type: 'tool_call',
          toolCallId: call.id,
          serverName,
          toolName,
          args: call.rawArgs,
          __streamed: true,
        } as ToolLoopEvent);
        const result = await runOne(call);
        if (!result) continue;
        jobStore.recordCall({
          callId: call.id,
          wireName: call.wireName,
          rawArgs: call.rawArgs,
          ok: result.ok,
          text: result.text,
          ...(result.diff ? { diff: result.diff } : {}),
          ...(result.images?.length ? { images: result.images } : {}),
          durationMs: Date.now() - started,
        });
        settled[index] = {
          call,
          serverName: result.serverName,
          toolName: result.toolName,
          ok: result.ok,
          text: result.text,
          diff: result.diff,
          images: result.images,
          visual: result.visual,
          errorCode: result.errorCode,
          panelUrl: result.panelUrl,
        };
        emitResult(settled[index]!);
      }
      continue;
    }

    const toRun: Array<{ call: PendingToolCall; index: number }> = [];
    for (const item of band.items) {
      const tool = byName.get(item.call.wireName);
      const isAgent = item.call.wireName.startsWith('agent__');
      const serverName = isAgent
        ? 'Workspace'
        : tool && 'serverName' in tool
          ? tool.serverName
          : '?';
      const toolName = isAgent
        ? item.call.wireName.replace(/^agent__/, '')
        : tool && 'toolName' in tool
          ? tool.toolName
          : item.call.wireName;
      const replayed =
        byName.has(item.call.wireName) && !probationBlocked(item.call.wireName)
        ? jobStore.lookupReplay(item.call.wireName, normalizeArgsKey(item.call.rawArgs))
        : undefined;
      if (replayed) {
        settled[item.index] = {
          call: item.call,
          serverName,
          toolName,
          ok: replayed.ok,
          text: replayed.text,
          diff: replayed.diff,
          images: replayed.images,
          replayed: true,
        };
        continue;
      }
      toRun.push(item);
    }
    for (let start = 0; start < toRun.length; start += MAX_PARALLEL) {
      if (signal?.aborted) break;
      const chunk = toRun.slice(start, start + MAX_PARALLEL);
      for (const item of chunk) {
        onEvent?.({
          type: 'tool_call',
          toolCallId: item.call.id,
          serverName: (() => {
            const tool = byName.get(item.call.wireName);
            const isAgent = item.call.wireName.startsWith('agent__');
            return isAgent ? 'Workspace' : tool && 'serverName' in tool ? tool.serverName : '?';
          })(),
          toolName: (() => {
            const tool = byName.get(item.call.wireName);
            const isAgent = item.call.wireName.startsWith('agent__');
            return isAgent ? item.call.wireName.replace(/^agent__/, '') : tool && 'toolName' in tool ? tool.toolName : item.call.wireName;
          })(),
          args: item.call.rawArgs,
          __streamed: true,
        } as ToolLoopEvent);
      }
      await Promise.all(
        chunk.map(async (item) => {
          const callStarted = Date.now();
          const result = await runOne(item.call);
          if (!result) return;
          jobStore.recordCall({
            callId: result.call.id,
            wireName: result.call.wireName,
            rawArgs: result.call.rawArgs,
            ok: result.ok,
            text: result.text,
            ...(result.diff ? { diff: result.diff } : {}),
            ...(result.images?.length ? { images: result.images } : {}),
            durationMs: Date.now() - callStarted,
          });
          settled[item.index] = {
            call: result.call,
            serverName: result.serverName,
            toolName: result.toolName,
            ok: result.ok,
            text: result.text,
            diff: result.diff,
            images: result.images,
            visual: result.visual,
            errorCode: result.errorCode,
            panelUrl: result.panelUrl,
          };
          emitResult(settled[item.index]!);
        }),
      );
    }
  }

  for (let i = 0; i < settled.length; i++) {
    if (settled[i]) continue;
    const call = calls[i];
    if (!call) continue;
    const isAgent = call.wireName.startsWith('agent__');
    const tool = byName.get(call.wireName);
    const serverName = isAgent ? 'Workspace' : tool && 'serverName' in tool ? tool.serverName : '?';
    const toolName = isAgent ? call.wireName.replace(/^agent__/, '') : tool && 'toolName' in tool ? tool.toolName : call.wireName;
    settled[i] = {
      call,
      serverName,
      toolName,
      ok: false,
      text: '[aborted — the user stopped the generation before this tool completed]',
      errorCode: 'aborted',
    };
  }

  for (const entry of settled) {
    if (!entry) continue;
    if (!entry.emitted) {
      events.push({
        type: 'tool_call',
        toolCallId: entry.call.id,
        serverName: entry.serverName,
        toolName: entry.toolName,
        args: entry.call.rawArgs,
        __streamed: true,
      });
      const clientImages = entry.images?.length
        ? entry.images.map((image) => {
            if (image.dataUrl.length < INLINE_DATA_URL_LIMIT) return image;
            const decoded = decodeStoredDataUrl(image.dataUrl);
            if (!decoded) return image;
            return {
              mime: decoded.mime,
              dataRef: {
                hash: putBytes(decoded.bytes, decoded.mime),
                mime: decoded.mime,
                byteSize: decoded.bytes.byteLength,
              },
            };
          })
        : undefined;
      const clientVisual = entry.visual
        ? externalizeClientVisual(entry.visual)
        : undefined;

      events.push({
        type: 'tool_result',
        toolCallId: entry.call.id,
        serverName: entry.serverName,
        toolName: entry.toolName,
        ok: entry.ok,
        summary: entry.text,
        ...(entry.diff ? { diff: entry.diff } : {}),
        ...(entry.diffstat ? { diffstat: entry.diffstat } : {}),
        ...(clientImages?.length ? { images: clientImages } : {}),
        ...(clientVisual ? { visual: clientVisual } : {}),
        ...(entry.panelUrl ? { panelUrl: entry.panelUrl } : {}),
      });
    }
    followUp.push({
      __kind: 'tool_output',
      id: entry.call.id,
      wireName: entry.call.wireName,
      text: entry.text,
      ok: entry.ok,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      ...(entry.images?.length ? { images: entry.images } : {}),
    });
  }

  try {
    const { emitPointAsync } = await import('../addons/points.js');
    emitPointAsync('round.end', {
      sessionId,
      calls: settled.length,
      ok: settled.filter((s) => s?.ok).length,
    });
  } catch {  }

  return { followUp, events };
}
