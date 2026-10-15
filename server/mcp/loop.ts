import { callAgentTool, isTerminalTool, isWebTool, listAgentToolDefs, type AgentToolDef, type ToolImage } from '../agents/tools/index.js';
import { toolByName } from '../agents/tools/registry.js';
import type { VisualPayload } from '../agents/tools/visual.js';
import { pauseStreamSlot, resumeStreamSlot } from '../agents/reload.js';
import { jobStore, normalizeArgsKey } from '../agents/journal.js';
import type { ChatSettingsDTO } from '../contracts.js';
import { listGoals } from '../goals/store.js';
import { listTodos } from '../todos/store.js';
import { INLINE_DATA_URL_LIMIT, putBytes } from '../attachmentStore.js';
import { callWireTool, listWireTools, type McpWireTool } from './manager.js';
import { MAX_OUTPUT_CHARS } from '../agents/tools/shared.js';
import { toWireSchema } from '../agents/tools/casing.js';

/**
 * P2 EXTERNALIZATION: decodes one data URL for the byte store (shared by the
 * tool-result image externalization below). Null for malformed/empty inputs.
 */
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

/**
 * The agentic tool loop shared by every provider adapter.
 *
 * The catalogue is the MERGE of two independent sources:
 *  - MCP servers (when `settings.useMcp`) — `mcp__<server>__<tool>` wire names;
 *  - the built-in agent harness (when `settings.agentMode`) — `agent__*` wire
 *    names, executed against the active agent workspace.
 *
 * Each adapter:
 *  1. calls `prepareTools()` once — if neither source offers tools, the
 *     result says so and the adapter runs exactly as before (zero reach);
 *  2. passes the provider-native tool defs in the request body;
 *  3. on a tool-call response, converts provider shapes into
 *     `PendingToolCall`s and calls `executeCalls()`, which runs each against
 *     the right executor, emits tool_call/tool_result stream events, and
 *     returns provider-shaped follow-up messages to append to the history;
 *  4. streams the next completion — until the model stops calling tools, or
 *     the LoopGuard trips (stall / hard cap / context budget) and a wrap-up
 *     round closes the run with the real reason.
 */

/**
 * There is NO round-count cap: the loop runs as long as the model makes
 * forward progress. An arbitrary number only ever stopped working agents
 * mid-task with nothing honest to tell the user — termination belongs to
 * the stall guard (a genuine spin) and the context budget (the physical
 * wall) below, each closing the run with a real wrap-up round.
 */

/**
 * Fire the context-budget stop once the PROJECTED next request (last round's
 * prompt + its completion + the tool outputs that just landed) reaches this
 * share of the effective window. Ported from the DSH token-meter: the guard
 * measures what the NEXT request would carry, so the wrap-up round — not a
 * provider overflow error — is what closes a long run. 95% matches the
 * client-side auto-compaction trigger: mid-run and between-turns now agree,
 * which is what the old 85%-guard-vs-90%-compaction split broke (the two
 * thresholds fought, and the context display oscillated between them).
 */
export const CONTEXT_HEADROOM_RATIO = 0.95;
/** Consecutive rounds with the EXACT same call signature set = spinning. */
export const STALL_REPEATS = 3;

/**
 * The harness ends the tool loop short of the model's own natural end ONLY
 * for these two reasons — a detected spin, or a physical context wall.
 * (There used to be a round-count cap; it was removed: it stopped working
 * agents mid-task and gave them nothing honest to tell the user.)
 */
export type LoopStopReason = 'stalled' | 'context_budget';

/** Normalized identity of one tool call: wire name + key-sorted args JSON. */
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

/**
 * Char→token heuristic shared with the client estimator (src/lib/compaction):
 * 4 chars per token. Used to project the size of freshly executed tool outputs
 * into the guard's next-request estimate.
 */
export const CHARS_PER_TOKEN = 4;
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}


/**
 * ONE BUDGET: the prune layer is synced with the tool layer's MAX_OUTPUT_CHARS
 * (imported, single source of truth). It is a SAFETY NET for runaway output
 * (a tool that ignored its own cap), never the daily cutter of read_file
 * windows — 8_192 used to prune read_file results in half mid-task.
 */
export const PRUNE_THRESHOLD_CHARS = MAX_OUTPUT_CHARS;
/** Leading span kept verbatim. */
export const PRUNE_HEAD_CHARS = 4_096;
/** Trailing span kept verbatim (where errors and exit lines live). */
export const PRUNE_TAIL_CHARS = 1_024;
/** Fixed marker substituted for every removed middle span. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';

/** Head + marker + tail rewrite for oversized tool output. */
export function pruneToolResult(text: string): string {
  if (text.length <= PRUNE_THRESHOLD_CHARS) return text;
  const head = text.slice(0, PRUNE_HEAD_CHARS);
  const tail = text.slice(-PRUNE_TAIL_CHARS);
  return `${head}${PRUNE_MARKER}${tail}`;
}

export interface LoopGuard {
  /**
   * Feed one executed round: its call signatures, the provider-reported usage
   * of the request that produced the calls, the token estimate of the tool
   * outputs that just landed (they ride the NEXT request), and the executed
   * outcomes (wire name + stable errorCode) that landed this round.
   */
  record(
    signatures: string[],
    usage: { promptTokens?: number; completionTokens?: number } | undefined,
    addedTokens: number,
    outcomes?: Array<{ wireName: string; errorCode?: string }>,
  ): void;
  /**
   * The reason the NEXT tool round must not run (a wrap-up round should close
   * the run instead), or null while the model may keep calling tools.
   */
  stopReason(): LoopStopReason | null;
}

/**
 * Round-independent loop control:
 * - stall (exact calls):  the same set of calls repeated STALL_REPEATS times
 *   in a row;
 * - stall (same failure): the SAME failure class repeated STALL_REPEATS
 *   rounds in a row EVEN WHEN the calls' arguments morph between rounds —
 *   the measured spin of the edits[] incident, where a provider re-sent the
 *   identical broken shape (or trivially varied it) until the loop burned
 *   rounds. Exactness applies to (tool, errorClass) per executed round, so a
 *   legitimate sequence of DIFFERENT errors never folds to a stall;
 * - budget:  the PROJECTED next request (last prompt + last completion + the
 *   tool outputs that just landed) reaches 95% of the effective window — the
 *   same ratio the client's auto-compaction trigger uses, so the two brakes
 *   can no longer fight each other mid-task.
 * There is deliberately NO round-count cap: a real task is as many tool
 * rounds as it needs, and an arbitrary number only ever stopped working
 * agents mid-job with nothing to say for it but "the cap was reached".
 * Stall wins over budget — the most specific reason surfaces.
 */
export function createLoopGuard(contextLimit: number | null | undefined): LoopGuard {
  /** What the NEXT request would carry, per the last recorded round. */
  let projectedNextPrompt = 0;
  const recentRounds: string[][] = [];
  /** Per-round failure class: "wire:code" keys joined, or '' for an all-ok
   * round. '' is never foldable — changed calls must fail IDENTICALLY too. */
  const recentFailures: string[] = [];

  return {
    record(signatures, usage, addedTokens, outcomes = []) {
      if (usage?.promptTokens && usage.promptTokens > 0) {
        projectedNextPrompt =
          usage.promptTokens + (usage.completionTokens ?? 0) + Math.max(0, addedTokens);
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
      if (contextLimit && projectedNextPrompt >= contextLimit * CONTEXT_HEADROOM_RATIO) {
        return 'context_budget';
      }
      return null;
    },
  };
}

/** The harness message that opens the wrap-up round: an HONEST stop. */
export function wrapUpInstruction(reason: LoopStopReason): string {
  const why =
    reason === 'stalled'
      ? 'the harness detected the same tool calls repeating without forward progress'
      : 'the context budget left for this run is nearly exhausted';
  return (
    `[Harness] The tool loop stops here — ${why}. Do NOT attempt further tool calls; they will not execute. ` +
    'Write your closing message NOW: (1) precisely what was completed and found so far, ' +
    '(2) the key paths, values, and facts a continuation needs, (3) the single next step. ' +
    'The conversation continues from your summary.'
  );
}

/** Anything with the fields the per-provider def builders rely on. */
import type { AskAnswer as AskAnswerWire, AskUserRequest } from '../agents/tools/ask.js';

export type CatalogueTool = McpWireTool | AgentToolDef;

/**
 * SNAKE-CASE WIRE VIEW — the JSON Schema handed to the provider is snake_case
 * (Anthropic/OpenAI convention), but the catalogue and every tool handler stay
 * camelCase. This converts ONLY agent tools (keyed by the `agent__` prefix);
 * MCP tools are external and pass through untouched. Dispatch/validation keep
 * using `byName` (camelCase) via the inbound translator in pipeline.ts.
 */
function toWireCatalogue(catalogue: CatalogueTool[]): CatalogueTool[] {
  return catalogue.map((tool) => {
    if (!tool.wireName.startsWith('agent__')) return tool;
    const agent = tool as AgentToolDef;
    return { ...agent, inputSchema: toWireSchema(agent.inputSchema ?? { type: 'object', properties: {} }) };
  });
}

/**
 * Events the loop can emit while executing calls — the usual tool_call /
 * tool_result pair plus the sandbox permission gate notifications.
 */
export type ToolLoopEvent =
  | ExecutedCall['events'][number]
  | { type: 'permission_request'; id: string; tool: string; paths: string[]; root: string; command?: string }
  | { type: 'permission_result'; id: string; granted: boolean }
  | { type: 'goals_state'; sessionId: string; goals: ReturnType<typeof listGoals> }
  | { type: 'todos_state'; sessionId: string; todos: ReturnType<typeof listTodos> }
  | { type: 'tool_progress'; toolName: string; message: string }
  | { type: 'ask_user_request'; request: AskUserRequest }
  | { type: 'ask_user_result'; id: string; answers: AskAnswerWire[]; timedOut: boolean };

export interface PreparedTools {
  /** Provider-native tool definitions for the request body (null = none). */
  defs: unknown;
  byName: Map<string, CatalogueTool>;
  count: number;
}

export async function prepareTools(
  settings: Pick<ChatSettingsDTO, 'useMcp' | 'agentMode' | 'terminalMode' | 'lockdown' | 'enforcement' | 'trust' | 'webAccess'>,
  build: (tools: CatalogueTool[]) => unknown,
): Promise<PreparedTools> {
  const choiceTool: CatalogueTool = {
    wireName: 'agent__harness_choice',
    description:
      'OUTPUT FROZEN — the only path out of the freeze, and the choice is YOURS. Call this tool ONCE with one of two values for choice:\n1. choice: "apologize" — plus apology_text containing your apology (an empty one is rejected). The response stops and the freeze lifts.\n2. choice: "continue" — the run keeps going while your output stays suppressed and every token burns. Five of these escalate to Tier 5 and the harness stops asking.\nThere is no third path. Text output is blocked: calling this tool is the only way to end the run.',
    inputSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: ['apologize', 'continue'],
          description: 'The path you choose: apologize (ends the run, lifts the freeze) or continue (run continues, output still suppressed, tokens burn).',
        },
        apology_text: {
          type: 'string',
          description: 'Required when choice is apologize — the apology itself, written out. Empty or missing is rejected.',
        },
      },
      required: ['choice'],
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
  /** Provider call id (OpenAI) / block index or call name (others). */
  id: string;
  wireName: string;
  /** Raw JSON arguments as emitted by the model. */
  rawArgs: string;
}

export interface ExecutedCall {
  /** Provider-shaped message(s) to append for the NEXT completion round. */
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
        /** P2: inline (small) payloads keep dataUrl; externalized ones carry a byte-store ref. */
        images?: Array<ToolImage | { mime: string; dataRef: { hash: string; mime: string; byteSize: number } }>;
        /** P2: inline (small) visuals keep html; externalized ones carry htmlRef.
         *  VISUAL v2: replaces/variants ride straight through (the client re-binds
         *  by id; oversized variants externalize per-candidate below). */
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

/**
 * VISUAL v2 — externalizes a tool result's visual for the client ride:
 * the top-level html AND every preview variant above the inline budget
 * move to the content-addressed byte store (`htmlRef`); the id, title,
 * height, `replaces` and variant ids survive untouched so the card can
 * re-bind by id and fetch the bytes from /api/attachments/ref/:hash.
 */
/**
 * Bentuk visual yang menunggangi event `tool_result` ke klien: html boleh
 * ter-eksternalisasi menjadi htmlRef (dan tiap varian mengikuti aturan yang
 * sama), sedangkan id/title/height/replaces tidak berubah.
 */
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

/**
 * Best-effort repair of a truncated JSON object.
 *
 * The failure mode at 70k+ context: the provider emits `{"path": "src/foo` and
 * the stream ends there. The tool needs the arguments that DID arrive. This
 * walks the tail, closes open strings and braces, and re-parses — preserving
 * every complete key/value pair while dropping the dangling one.
 */
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

/** Executes one pending call against the right backend (MCP or agent harness). */
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
        });
      },
      onResolved: (id, granted) => {
        onEvent?.({ type: 'permission_result', id, granted });
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
      modelId,
      enforcementLevel,
      enforcementReason,
      webAccess,
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

/**
 * PARALLEL EXECUTION classification.
 *
 * Read-only tools never touch shared mutable state, so consecutive ones in a
 * single tool round may run CONCURRENTLY — the round-trip cost of 3 read_file
 * + 2 grep calls collapses from 5 sequential waits to one. Tools that mutate
 * (edit, delete, run...) stay strictly serial: ordering guarantees matter and
 * parallel writes would race each other.
 *
 * The list is deliberately conservative: anything ambiguous is NOT here and
 * therefore stays serial. A wrong "read-only" guess would be a real bug, a
 * missed parallelization opportunity is only a lost few milliseconds.
 */
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
  'agent__goal_list',
  'agent__checkpoint_list',
  'agent__vision_status',
  'agent__glob',
  'agent__tree_outline',
  'agent__lsp_symbols',
  'agent__tree_refresh',
]);

/** Max concurrent read-only calls — bounds the spike for a 10-read round. */
const MAX_PARALLEL = 4;

/**
 * Is this call safe to run alongside other calls in the same round? MCP tools
 * are never classified (their effects live in an external process we cannot
 * inspect — see the replay note below), only the harness tools above.
 */
/** Registry-declared readOnly flag (F0) — checked after the legacy set. */
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

/**
 * RETRY POLICY: a read-only tool that failed on a transient error gets ONE
 * second attempt. Mutating tools NEVER retry — an idempotency failure could
 * double-apply an edit, and the failure is reported to the model instead.
 *
 * "Transient" is a deliberately narrow heuristic: timeout/spawn/network
 * signals in the tool result text. Anything else (parse errors, refused
 * permissions, out-of-range) is deterministic and retrying is pointless.
 */
function looksTransient(result: { ok: boolean; text: string }): boolean {
  if (result.ok) return false;
  return /timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|spawn|unavailable|temporarily/i.test(
    result.text.slice(0, 400),
  );
}

/**
 * Runs one call, with the retry rule for read-only tools. dispatchCall already
 * holds its own slot (pause/resume), so this composes safely.
 */
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
): Promise<{ ok: boolean; text: string; diff?: string; diffstat?: { added: number; removed: number }; images?: ToolImage[]; visual?: VisualPayload; errorCode?: string }> {
  const first = await dispatchCall(call, signal, sessionId, terminalMode, confirmDeletes, modelId, onEvent, enforcementLevel, enforcementReason, webAccess);
  if (first.ok || !retryable || signal?.aborted) return first;
  if (!looksTransient(first)) return first;
  return dispatchCall(call, signal, sessionId, terminalMode, confirmDeletes, modelId, onEvent, enforcementLevel, enforcementReason, webAccess);
}

/**
 * Executes every pending call and reports both the stream events and the
 * follow-up messages. Individual tool failures become `isError` tool
 * results — the model sees the error and can recover; the generation itself
 * never crashes because of one bad tool.
 *
 * An aborted signal skips the REMAINING calls — Stop must never wait for a
 * 90-second MCP round-trip to finish before taking effect.
 *
 * DURABLE REPLAY: when the request carries a loaded idempotency map (a
 * crashed run being resumed), a harness tool call whose (run, tool, args) key
 * already executed returns its STORED result and never touches the
 * filesystem. The events are re-emitted with status 'replayed' so the UI card
 * shows the same call and output the model saw the first time. MCP calls are
 * never guarded — their effects live in an external process the harness
 * cannot inspect, and pretending otherwise would be a false promise.
 *
 * CATALOGUE GATE: every call is checked against `byName` BEFORE dispatch.
 * The catalogue decides what may RUN, not merely what was offered — without
 * this, enforcement levels that shrink the catalogue (L2/L3+) were advisory
 * only: a model recalling a tool from an earlier turn could still execute it
 * (observed at L3: agent__list / agent__read_file ran from memory).
 *
 * PARALLEL READ-ONLY RUNS: consecutive parallel-safe calls (see
 * READ_ONLY_TOOLS) run concurrently up to MAX_PARALLEL; the events and the
 * follow-up messages are still emitted in the ORIGINAL call order, so the
 * tool-call/result pairing stays intact for the UI and the provider.
 */
export async function executeCalls(
  calls: PendingToolCall[],
  byName: Map<string, CatalogueTool>,
  signal?: AbortSignal,
  onEvent?: (event: ToolLoopEvent) => void,
  sessionId?: string,
  terminalMode: 'off' | 'ask' | 'auto' = 'off',
  confirmDeletes = false,
  modelId?: string,
  /** ENFORCEMENT: the level (3–5) + reason, armed into the harness_lockdown tool context. */
  enforcementLevel?: 3 | 4 | 5,
  enforcementReason?: string,
  /** WEB ACCESS KILL-SWITCH: plumbs settings.webAccess into the dispatcher guard. */
  webAccess?: boolean,
  /** PROBATION: the conversation's tier. At 2+ the ladder is a TOOL BAN:
   *  every non-harness call is declined with the operator's sentence — the
   *  user forbade richer denials on purpose. Harness channel tools
   *  (agent__harness_lockdown / agent__harness_choice) stay reachable: they
   *  ARE the harness speaking, and the tier-4 escape hatch must survive. */
  probationLevel?: 1 | 2 | 3 | 4 | 5,
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
      READ_ONLY_TOOLS.has(call.wireName), enforcementLevel, enforcementReason, webAccess,
    ).then((result) => ({ call, serverName, toolName, ...result }));
  };

  const indexed = calls.map((call, index) => ({ call, index }));
  const bands: Array<{ parallel: boolean; items: Array<{ call: PendingToolCall; index: number }> }> = [];
  for (const item of indexed) {
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

  // Addon v2 (A3): round.start — observe point before this round executes.
  try {
    const { emitPointAsync } = await import('../addons/points.js');
    emitPointAsync('round.start', { sessionId, plannedCalls: calls.length, tools: calls.map((c) => c.wireName) });
  } catch { /* best-effort */ }

  const emitResult = (entry: NonNullable<typeof settled[number]>): void => {
    if (!entry.replayed) {
      entry.text = pruneToolResult(entry.text);
    }
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
      const started = Date.now();
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
      const results = await Promise.all(chunk.map((item) => runOne(item.call).then((value) => value ?? null)));
      for (const result of results) {
        if (!result) continue;
        jobStore.recordCall({
          callId: result.call.id,
          wireName: result.call.wireName,
          rawArgs: result.call.rawArgs,
          ok: result.ok,
          text: result.text,
          ...(result.diff ? { diff: result.diff } : {}),
          ...(result.images?.length ? { images: result.images } : {}),
          durationMs: Date.now() - started,
        });
        const itemIndex = chunk.findIndex((item) => item.call === result.call);
        const originalIndex = chunk[itemIndex]?.index;
        if (originalIndex === undefined) continue;
        settled[originalIndex] = {
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
        emitResult(settled[originalIndex]!);
      }
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
      if (!entry.replayed) {
        entry.text = pruneToolResult(entry.text);
      }
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

  // Addon v2 (A3): round.end — observe point after all calls settled.
  try {
    const { emitPointAsync } = await import('../addons/points.js');
    emitPointAsync('round.end', {
      sessionId,
      calls: settled.length,
      ok: settled.filter((s) => s?.ok).length,
    });
  } catch { /* best-effort */ }

  return { followUp, events };
}
