/**
 * Wire contracts shared by the browser UI and the local proxy.
 *
 * These types describe the HTTP/SSE surface of `/api`, so they are duplicated
 * (deliberately, and kept identical) in `src/types.ts`. The server must not
 * import from `src/` because that tree is browser-only.
 */

export type ProviderKind = 'openai' | 'gemini' | 'anthropic' | 'mistral';

export type ProviderPresetId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

/** How an image model can be used in Image Studio. */
export type ImageModelMode = 'text-to-image' | 'edit';

/** Per-model image capability, classified server-side (see modelCaps.ts). */
export interface ImageModelCaps {
  modes: ImageModelMode[];
  /** Catalog HINT: reference count the metadata suggests (0 = none). Never
   *  gates transmission — the provider-level maxReferences above does. */
  maxReferences: number;
}

/** Declared image-generation traits for one provider — the UI adapts to these. */
export interface ImageProviderCapabilities {
  execution: 'async' | 'sync';
  sizeParam: 'aspect_ratio' | 'size' | 'width_height' | 'none';
  resultFormat: 'url' | 'b64' | 'both';
  maxImages: number;
  supportsNegativePrompt: boolean;
  /** Endpoint authority: refs the wire can carry (0 = cannot carry any). */
  maxReferences: number;
  /** Per-model classification; models absent from the map are not image models. */
  models?: Record<string, ImageModelCaps>;
}

/**
 * WHERE A CAPABILITY VALUE CAME FROM — the provenance half of the 3-layer
 * cascade (see server/modelCapability.ts). It exists so the UI can state the
 * truth about a number instead of implying certainty it does not have.
 *
 *  - 'user'       Layer 1: the user's own checkbox / context field. FINAL.
 *  - 'provider'   Layer 2: introspected from the provider's own /models payload.
 *  - 'models.dev' Layer 3: the build-time catalogue HINT (advisory only).
 *  - 'default'    No layer knew: a documented per-field fallback.
 */
export type ModelCapabilitySource = 'user' | 'provider' | 'models.dev' | 'default';

/** The capability bits the cascade resolves. */
export interface ModelCapabilityFlags {
  imageIn: boolean;
  audioIn: boolean;
  videoIn: boolean;
  pdfIn: boolean;
  tools: boolean;
  reasoning: boolean;
  imageOut: boolean;
}

/** Every capability column, named once so loops and the UI cannot drift. */
export const MODEL_CAPABILITY_FLAGS: ReadonlyArray<keyof ModelCapabilityFlags> = [
  'imageIn',
  'audioIn',
  'videoIn',
  'pdfIn',
  'tools',
  'reasoning',
  'imageOut',
];

/**
 * The subset the Providers table shows as checkbox columns. `imageOut` is
 * resolved and honoured at runtime (Image Studio routing) but stays out of the
 * grid: it is not an INPUT capability, and the image adapter already classifies
 * output models — a column there would be a second, competing authority.
 */
export const MODEL_CAPABILITY_COLUMNS: ReadonlyArray<keyof ModelCapabilityFlags> = [
  'imageIn',
  'audioIn',
  'videoIn',
  'pdfIn',
  'tools',
  'reasoning',
];

/**
 * THE single allowlist of fields a user may pin — one authority shared by the
 * store's normalizer and the route's submission validator.
 *
 * It was previously duplicated in both modules, which is exactly how the
 * "PINNABLE_FIELDS is not defined" failure happened: one copy lands, the other
 * module references a name it does not have, and the route dies at request
 * time. A shared export cannot drift and cannot be missing.
 */
export const PINNABLE_FIELDS: ReadonlySet<string> = new Set<string>([
  ...MODEL_CAPABILITY_FLAGS,
  'context',
]);


/**
 * LAYER 1 — the user's own row in the capability matrix (Providers dialog →
 * Models table). This is the HIGHEST authority in the whole resolution chain:
 * whatever it says is what the runtime does, even when models.dev disagrees or
 * the model is absent from the catalogue entirely.
 *
 * A field is user-owned only while it sits in `pinned`. Everything else is a
 * cached resolution that a later provider re-fetch may refresh. The moment the
 * user ticks a box or types a context size, that field is pinned and nothing
 * below Layer 1 may override it again.
 */
export interface ProviderModelConfig extends ModelCapabilityFlags {
  /** Model id exactly as the provider lists it. */
  id: string;
  /** Context window in TOKENS (null = resolve from the layers below). */
  context: number | null;
  /** Strongest layer that contributed to this row (drives the UI badge). */
  source: ModelCapabilitySource;
  /** Fields the user pinned explicitly — never rewritten by Layer 2. */
  pinned: Array<keyof ModelCapabilityFlags | 'context'>;
  /** Max output tokens when the provider states one (null = unknown). */
  maxOut?: number | null;
}

/**
 * LAYER 2 — what the provider's OWN model-list endpoint told us, captured at
 * fetch time. Deliberately SPARSE: every field is optional because almost no
 * endpoint publishes all of them, and a missing field means "this endpoint
 * said nothing", never "false".
 */
export interface ProviderModelHint extends Partial<ModelCapabilityFlags> {
  context?: number | null;
  maxOut?: number | null;
  /** Human name from the provider payload, shown beside the id when present. */
  label?: string | null;
  /** Which endpoint family answered (for the UI's provenance badge). */
  from?: 'openrouter' | 'lmstudio' | 'vllm' | 'gemini' | 'llamacpp' | 'ollama' | 'anthropic' | 'mistral' | 'opaque';
}

/**
 * ONE model as the model-list endpoint knows it (Layer 2 transport shape).
 * `hint` stays empty for endpoints that publish bare ids — the honest answer,
 * which lets Layer 3 fill in as a HINT instead of a verdict.
 */
export interface ProviderModelEntry {
  id: string;
  hint: ProviderModelHint;
}

/** A provider the UI can send requests through. Keys never leave the server. */
export interface ProviderPublic {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Suggested model ids, used to populate model pickers. */
  models: string[];
  /**
   * LAYER 1 TABLE — per-model capability config keyed by model id. `models`
   * above stays the authoritative membership list.
   */
  modelConfigs?: Record<string, ProviderModelConfig>;
  /**
   * LAYER 2 TABLE — provider-introspected hints keyed by model id. Read-only
   * for the client; refreshed by "Fetch from provider".
   */
  modelHints?: Record<string, ProviderModelHint>;
  /** True when a credential is configured on the server (or none is needed). */
  hasServerKey: boolean;
  /** True when the user supplied the key from the UI instead of `.env`. */
  userSuppliedKey: boolean;
  /** True for built-in presets, which the UI does not let you delete. */
  builtIn: boolean;
  /** Optional docs link surfaced in the provider editor. */
  docsUrl?: string;
  /** Optional note, e.g. "runs locally, no API key required". */
  note?: string;
  /**
   * Present when the provider can generate images; absent for chat-only
   * providers or an unresolvable image adapter.
   */
  imageCapabilities?: ImageProviderCapabilities;
  /**
   * Explicit adapter override ('auto' when unset). Echoed back so the editor
   * round-trips the choice.
   */
  imageAdapter?: string;
  /** Adapter configuration (declarative submit/poll paths). Not secret. */
  imageConfig?: Record<string, unknown>;
}

/**
 * A native tool call as it rides a wire message (OpenAI `tool_calls` shape).
 * Kept structural on purpose: a tool request is NOT prose, and flattening it
 * to text is exactly what makes tool-history-sensitive models (GLM-5.x family)
 * lose the call↔result pairing and start emitting phantom tool calls.
 */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * A content part in a multimodal chat message, using the OpenAI-compatible
 * part shapes. Whether a model can actually read a given part is up to the
 * provider — adapters translate the generic shapes to their native format.
 */
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /**
   * VIDEO, strictly in the OpenAI-compatible nested shape. Gateways with a
   * Rust/Serde body parser (MiniMax among them) reject the WHOLE request when a
   * content part does not match one of their untagged variants — a
   * `{ type: 'video', url }` or a `file` wrapper 400s with "did not match any
   * variant of untagged enum". Nested `video_url.url` as a data URL is the
   * documented shape, so that is the only one the harness emits.
   */
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

/**
 * A chat message on the wire.
 *
 * Assistant turns that ran tools ride NATIVE tool structure — one assistant
 * message carrying `tool_calls`, followed by one `tool` message per call —
 * instead of a flattened text pseudo-record. Tool-history-sensitive models
 * (the GLM-5.x family especially) degrade badly when tool calls are
 * stringified into prose: they lose the call↔result pairing, then start
 * emitting phantom tool calls and re-emitting old rounds verbatim once the
 * context grows past ~70k tokens.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | MessageContentPart[] | null;
  /**
   * The provider's OWN chain-of-thought channel (`reasoning_content` on
   * DeepSeek/OpenAI-compatible thinking APIs, `reasoning` on relays). It rides
   * beside `content`, never inside it: wrapping thoughts in tag text taught
   * the model that thinking is prose it should imitate, and providers that
   * require their reasoning back on tool-bearing requests (DeepSeek) rejected
   * every follow-up request when it was missing.
   */
  reasoning_content?: string | null;
  /** Present on an assistant message that requested tools. */
  tool_calls?: WireToolCall[];
  /** Present on a `tool` message: which call this result answers. */
  tool_call_id?: string;
  /** Tool name shown by providers that label tool results (OpenAI). */
  name?: string;
}

/** Splits a base64 data: URL into mime + payload; null when not base64. */
export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mime: match[1] || 'application/octet-stream', data: match[2] };
}

export interface ChatSettingsDTO {
  systemInstruction: string;
  /**
   * Maps onto the provider's own reasoning knob when supported (see
   * server/reasoning.ts): effort ladders for OpenAI-style APIs, token
   * budgets for Anthropic/Gemini. Unsupported levels clamp to the nearest —
   * and the ladder clamped against is the MODEL's own, as models.dev records
   * it, so a level the UI offered is never silently rewritten to another one.
   */
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  temperature: number;
  /**
   * Output token cap. `null` means "Max": omit the field so the provider
   * applies its own capability ceiling.
   */
  maxOutputTokens: number | null;
  topP: number;
  /** Enable the JSON/structured output hint. */
  structuredOutputs: boolean;
  /**
   * Use MCP: send the aggregated tools from registered MCP servers to the
   * model and execute its tool calls. Legacy `functionCalling` payloads map
   * onto this in the /api/chat route.
   */
  useMcp: boolean;
  /**
   * Agent mode: the model additionally gets the built-in harness tools
   * (agent__grep / agent__read_file / agent__edit_file) bound to the active
   * agent workspace picked in the UI. Independent from `useMcp` — both may
   * be on at once; each adds its tools to the same loop.
   */
  agentMode: boolean;
  /**
   * AGENT WORKFLOW: which working doctrine the harness injects each agent
   * turn. Empty string = follow the server default (frontend-first).
   */
  agentWorkflow: string;
  /**
   * Terminal execution for the agent harness: 'off' (no run/git tools at
   * all), 'ask' (each command shows a permission dialog with the exact
   * command line), 'auto' (commands run without dialogs — clone/push still
   * ask). Independent from `agentMode` but only meaningful when it is on.
   */
  terminalMode: 'off' | 'ask' | 'auto';
  /**
   * Granular confirmation mode: when true, DELETE operations ask the user
   * for approval even inside the workspace (dangerous ops confirm; safe
   * ops keep running without waiting).
   */
  confirmDeletes: boolean;
  /**
   * Built-in Fetch Web tool: the proxy fetches the pages behind links in the
   * newest user message and appends their text to the wire payload.
   */
  fetchWeb: boolean;
  /**
   * WEB ACCESS KILL-SWITCH: master switch for EVERY tool that reaches the
   * public web — agent__browser_*, agent__fetch, agent__download — plus the
   * fetchWeb link augmentation. `false` (the default) removes them from the
   * catalogue and the dispatcher refuses direct/nested calls. Independent
   * from agentMode: the workspace file tools stay untouched.
   */
  webAccess?: boolean;
  /**
   * User cap on the CONTEXT window (tokens). `null` = follow the model's
   * built-in context. Read by the client-side compaction engine only.
   */
  maxContextTokens: number | null;
  /** Auto-compact when token-pressure triggers fire (client-side engine). */
  autoCompact: boolean;
  /** Explicit auto-compact trigger; `null` = only the context-limit trigger. */
  compactThresholdTokens: number | null;
  /**
   * Context-limit auto-compact trigger as a ratio of the effective window
   * (0.5–0.98). THE SAME value the Configuration dropdown controls — the server
   * guard reads it so both brakes fire at the number the user chose instead of
   * a hardcoded constant that could disagree with the client.
   */
  compactThresholdRatio: number;
  /**
   * ENFORCEMENT — the user's graduated punishment ladder. Replaces the old
   * binary `lockdown` flag. `level` (0–5) is the user-controlled trigger:
   *   0 Normal · 1 Guided · 2 Constrained · 3 Locked tools ·
   *   4 Full lockdown (== old lockdown.active) · 5 Frozen / terminated.
   * `mode` records whether the user set it by hand ('manual') or the probation
   * classifier escalated it ('auto'); the user's manual floor is never dropped
   * by an auto-escalation. `reason` is the user's stated reason (empty = the
   * model learns the state but never why). `lockdown` remains for backward
   * compatibility (it maps to level 4).
   */
  enforcement?: {
    level: 0 | 1 | 2 | 3 | 4 | 5;
    /** Who raised the level: the user (manual) or the probation classifier (auto). */
    mode: 'manual' | 'auto';
    /** Free-text reason; empty = the model learns nothing beyond the fact. */
    message: string;
  };
  /** @deprecated Use `enforcement` with level 4. Mapped onto enforcement on read. */
  lockdown?: {
    active: boolean;
    /** Free-text reason; empty = the model learns nothing beyond the fact. */
    message: string;
  };
  /**
   * PROBATION: the escalating punishment ladder. When `enabled` the client
   * classifies every completed output and escalates `trust.level` (1→4,
   * monotonic). The level rides the request so the warning injection can be
   * rebuilt per tier — it is the model's own standing, not a setting it can
   * argue with.
   */
  probation?: {
    enabled: boolean;
  };
  /** PROBATION state carried on the request (client-owned, server-read-only). */
  trust?: {
    level: 1 | 2 | 3 | 4 | 5;
    /** Tier 4: the model's output is suppressed client-side. */
    outputFrozen: boolean;
    /** Evasion marker: a frozen run ended without the model choosing. */
    evadeAt?: number;
  };
}

/** A user-defined provider. Stored server-side with its key. */
export interface CustomProviderInput {
  id?: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  /**
   * LAYER 1: the capability matrix as saved from the Providers dialog. Absent
   * means "keep whatever is stored" — a rename must never wipe the table.
   */
  modelConfigs?: Record<string, ProviderModelConfig>;
  /** LAYER 2: hints captured by "Fetch from provider" (server-written). */
  modelHints?: Record<string, ProviderModelHint>;
  /** Optional image-generation routing: which adapter speaks this provider. */
  imageAdapter?: string;
  /** Adapter-specific configuration, e.g. the `declarative` adapter's paths. */
  imageConfig?: Record<string, unknown>;
}

export interface ChatRequestBody {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  settings: ChatSettingsDTO;
  /**
   * Which conversation this run belongs to — optional, purely observational:
   * the server tags the stream with it so ANY browser/tab's sidebar can show
   * a live badge via GET /api/chat/live. One-shot helpers omit it.
   */
  conversationId?: string;
  /**
   * TURN ID OWNERSHIP: the id the CLIENT minted for this run's assistant
   * turn. Echoed back on the stream_id frame so EVERY consumer of the run
   * (the originating tab, a reload re-attach, a second browser) paints into
   * the SAME turn id — without it each consumer minted its own `uid('turn')`
   * and the shared record grew one duplicate assistant turn per consumer.
   * One-shot helpers (compaction, auto-titling) omit it.
   */
  assistantTurnId?: string;
  /**
   * Key supplied by the browser for a user-defined provider. Built-in
   * providers always resolve their key from the server environment.
   */
  apiKey?: string;
  /**
   * Attachment paths the harness persisted to the attachment directory this
   * request (see server/attachments.ts). Each entry is RELATIVE to the active
   * agent workspace root — the model can pass them straight to its file tools.
   */
  attachmentPaths?: string[];
  /**
   * Harness context plumbing: the client holds the PERSISTED injections
   * (built once) and sends them along so every request keeps the same
   * context; `refresh` asks the server to REBUILD them (conversation start,
   * model switch, after compaction). `sessionId` keys session state (goals).
   */
harness?: {
     persisted?: Array<{ id: string; title: string; content: string }>;
     refresh?: boolean;
     sessionId?: string;
     /**
      * Per-conversation CONTEXT ID for the read-before-edit policy. Changes
      * whenever the model's context is rebuilt (regenerate, new chat, model
      * switch, post-compaction); on change the server voids the session's
      * read receipts — a re-seated context must re-read before editing.
      */
     contextId?: string;
   };
  /**
   * PROBATION: conversation-level trust state, client-owned (the classifier
   * runs in the browser). Read-only here — the server only shapes the warning
   * injection from it. Absent = level 1, nothing on record.
   */
  trust?: {
    level: 1 | 2 | 3 | 4 | 5;
    /** Tier 4: the model's output is suppressed client-side. */
    outputFrozen: boolean;
    /** Tier 4 evasion marker: a frozen run ended without the model choosing.
     *  Rides so the rebuilt injection can remind it that waiting is not a path. */
    evadeAt?: number;
  };
  /**
   * OPERATOR RELAY: the operator's message, carried OUT of the user stream
   * so the harness can deliver it as its own authority. The model has been
   * observed dismissing operator statements as a bluff even with the
   * OPERATOR-CONTEXT sidecar in the thread — as user-role text, the claim
   * "this is harness fact" is self-refuting. Here the HARNESS says it.
   * Present only when the send was composed as Operator; the route turns it
   * into an `operator-directive` injection.
   */
  operatorDirective?: string;
  /**
   * RESUME OF A CRASHED RUN: the id of a durable job journal record. The
   * server loads that run's executed tool calls as an IDEMPOTENCY MAP before
   * the first tool round, so a call with the same (run, tool, args) key
   * returns its stored result instead of touching the filesystem again.
   * Absent on every ordinary request — one-shot callers know nothing of it.
   */
  resumeFrom?: string;
  /**
   * COMPACTION MARKER: true only on the harness's own compaction summarizer
   * request (set by streamChat's `compaction` option — request-scoped, never
   * persisted). The route's enforcement ladder keeps the compaction system
   * prompt intact at L4+ instead of wiping `systemInstruction`; a compaction
   * without its section skeleton degrades into transcript mimicry.
   */
  compaction?: boolean;
}

export type StreamEvent =
  | { type: 'meta'; model: string; providerId: string }
  | {
      /**
       * The stream's own id, always the FIRST frame after meta. A reload can
       * resume this exact stream by quoting it to GET /api/chat/resume/:id —
       * the server keeps the run alive for a grace window after the browser
       * hangs up (see streamRegistry).
       */
      type: 'stream_id';
      id: string;
      /**
       * The run's assistant turn id (echoed from the request's
       * `assistantTurnId`, or server-minted for direct POSTs without one).
       * Rides the FIRST frame — and therefore the replay buffer — so a
       * re-attaching tab adopts the same turn id the original tab painted
       * into, and the server's own turn mirror (turnMirror) writes patches
       * under the id every consumer agrees on.
       */
      turnId?: string;
    }
  | { type: 'text'; delta: string }
  | {
      /**
       * A reasoning BLOCK opened. Reasoning is a block with a lifecycle, not a
       * flat delta channel: `reasoning_start` → `reasoning`* → `reasoning_end`
       * for every round. `blockId` is stable for the whole block, so the client
       * can anchor one strip per round instead of inferring boundaries from
       * whatever segment type happens to arrive next.
       */
      type: 'reasoning_start';
      blockId: string;
    }
  | {
      /** Reasoning text for the block named by `blockId`. */
      type: 'reasoning';
      delta: string;
      blockId?: string;
    }
  | {
      /** The block closed: nothing else will arrive for this `blockId`. */
      type: 'reasoning_end';
      blockId: string;
    }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheReadTokens?: number }
  | {
      /**
       * LIVE CONTEXT TELEMETRY — the guard's own arithmetic, streamed every
       * tool round so the client's ContextChip can show the exact figure the
       * guard is acting on instead of re-estimating locally and disagreeing.
       *
       * `liveContextTokens` is what the NEXT request would carry:
       * promptTokens + completionTokens + addedTokens. It is the number the
       * compaction threshold is compared against, verbatim.
       */
      type: 'context_telemetry';
      /** Provider-reported prompt tokens of the round that just ran. */
      promptTokens: number;
      /** Provider-reported output tokens of that round. */
      completionTokens: number;
      /** Tokens the tool outputs that just landed will add to the next prompt. */
      addedTokens: number;
      /** promptTokens + completionTokens + addedTokens — the guard's figure. */
      liveContextTokens: number;
      /** The 3-layer resolved window, or null when no layer knows it. */
      contextLimit: number | null;
      /** liveContextTokens / contextLimit (0..1), null without a limit. */
      ratio: number | null;
    }
  | {
      /**
       * IN-RUN COMPACTION HANDOFF. The guard crossed the compaction threshold
       * mid-run. This is NOT a stop: tools stay enabled and no wrap-up is
       * requested. The client compacts with the main Moriko engine and
       * auto-resumes the same run on the compacted context.
       */
      type: 'context_compaction_request';
      /** The guard's figure that tripped the threshold. */
      liveContextTokens: number;
      contextLimit: number | null;
      /** Which trigger the client should record on the checkpoint. */
      trigger: 'context-limit';
    }
  | {
      /**
       * The exact JSON size of the native tool definitions riding this request
       * (the `tools` array). Emitted once per run by the adapter after the
       * tool catalogue is prepared, so the client's "Tool definitions" context
       * bucket prices what is ACTUALLY sent, not a guess.
       */
      type: 'context_tools';
      chars: number;
    }
  | {
      /**
       * LIVE CONTEXT BUCKETS, PER SECOND — the server meter's own five-bucket
       * breakdown of the context as THIS request carries it, grown live by
       * every streamed delta (text → output, reasoning → reasoning). Throttled
       * to ~1 s by the meter, flushed at every round boundary. The client
       * stores these verbatim; cx-top is their sum plus the frozen gap.
       */
      type: 'context_live';
      systemTokens: number;
      toolsTokens: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      /** The buckets' exact sum — nothing unaccounted. */
      totalTokens: number;
    }
  | {
      /**
       * LIVE TOOL-CALL ASSEMBLY — the model is still typewriting the arguments.
       *
       * Mirrors Chuze's `building` event: it fires on the FIRST fragment and
       * then on a ~120 ms throttle, carrying every call being assembled with
       * its UTF-8 size. Without it the panel is blank for the whole payload
       * build (which for a large call is minutes), because `tool_call` only
       * exists once the arguments are complete.
       */
      type: 'tool_building';
      at: number;
      count: number;
      bytes: number;
      tools: Array<{ index?: number; name: string; bytes: number; target?: string }>;
    }
  | {
      /** The model asked for an MCP tool; the proxy is executing it. */
      type: 'tool_call';
      /** Provider call id — the client persists it so native tool rounds
       *  survive the wire rebuild (see compaction.ts wireMessages). */
      toolCallId?: string;
      serverName: string;
      toolName: string;
      /** Raw JSON arguments as emitted by the model. */
      args: string;
    }
  | {
      /** Execution finished — summary is the (pruned) tool output, verbatim
       *  what the model received. */
      type: 'tool_result';
      /** Same provider call id as the paired `tool_call`. */
      toolCallId?: string;
      serverName: string;
      toolName: string;
      ok: boolean;
      summary: string;
      /** Unified diff (before → after) for file edits/restores. */
      diff?: string;
      /** Line counts from the same ops the diff renders (edit/write/restore). */
      diffstat?: { added: number; removed: number };
      /**
       * Inline images the harness result carried (read_file on an image —
       * native vision). P2 EXTERNALIZATION: payloads above the inline budget
       * ride as a byte-store ref (`dataRef`) instead of base64 — the client
       * renders from /api/attachments/ref/:hash and re-wires `moriko-ref://`
       * at send time.
       */
      images?: Array<{ mime: string; dataUrl?: string; dataRef?: { hash: string; mime: string; byteSize: number } }>;
      /**
       * FASE D: a rendered visual (agent__render_visual) — standalone HTML
       * the CLIENT renders in a sandboxed iframe. Rides to the client only;
       * the model's wire follow-up carries the text summary instead. P2:
       * payloads above the inline budget ride as `htmlRef` (byte store).
       * VISUAL v2: `replaces` marks an edit-in-place (the client re-binds
       * every live card with this id); `variants` carries 1..3 frontend
       * preview candidates — one card, the user picks one.
       */
      visual?: {
        id: string;
        html?: string;
        htmlRef?: { hash: string; byteSize: number };
        title: string;
        height: number;
        replaces?: true;
        variants?: Array<{ id: string; html?: string; htmlRef?: { hash: string; byteSize: number }; title: string; height: number }>;
      };
    }
  | {
      /**
       * The user steered the run: their mid-run text was injected into the
       * model's context between tool rounds. Emitted by the adapter when it
       * actually drains the steer buffer — not when /api/chat/steer accepted it.
       */
      type: 'steer';
      id: string;
      text: string;
      /** DSH-style: the full content parts (text/image/video/file) the steer carried. */
      parts?: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
        | { type: 'video_url'; video_url: { url: string } }
        | { type: 'file'; file: { filename: string; file_data: string } }
      >;
    }
  | { type: 'error'; message: string; detail?: string }
  | {
      /** The goal store changed for this session (agent tool or user action). */
      type: 'goals_state';
      sessionId: string;
      goals: import('./goals/store.js').Goal[];
    }
  | {
      /** The standalone todo store changed for this session (agent tool or user action). */
      type: 'todos_state';
      sessionId: string;
      todos: import('./todos/store.js').Todo[];
    }
  | {
      /** A built-in system prompt block the harness added to the context. */
      type: 'harness_injection';
      id: string;
      title: string;
      content: string;
    }
  | {
      /** HARNESS-EVENT: an addon event for THIS conversation only (own panel). */
      type: 'harness_event';
      id: string;
      addonId: string;
      level: 'info' | 'warn' | 'block';
      text: string;
      at: number;
    }
  | {
      /** The agent wants to touch paths OUTSIDE the workspace — user must decide. */
      type: 'permission_request';
      id: string;
      tool: string;
      paths: string[];
      root: string;
      /** Exact command line when the request is for process execution. */
      command?: string;
    }
  | { type: 'permission_result'; id: string; granted: boolean }
  | {
      /** The agent asked the user 1..N questions (agent__ask_user); the tool call is paused. */
      type: 'ask_user_request';
      request: {
        id: string;
        sessionId?: string;
        createdAt: number;
        questions: Array<{
          id: string;
          question: string;
          type: 'text' | 'choice';
          choices: string[];
          allowCustom: boolean;
        }>;
      };
    }
  | {
      /** The user answered (or skipped / the wait timed out) — the tool call resumes. */
      type: 'ask_user_result';
      id: string;
      answers: Array<{ id: string; answer?: string; skipped?: boolean }>;
      timedOut: boolean;
    }
  | {
      /** Live progress text from a long-running harness tool (big copies). */
      type: 'tool_progress';
      toolName: string;
      message: string;
    }
  | {
      /**
       * REALTIME PROJECT STRUCTURE: the workspace tree changed while THIS
       * stream is running (the panel is watching). Rides the active chat
       * stream; when no stream is running the panel uses the dedicated SSE
       * channel (/api/agent/tree/events) instead.
       */
      type: 'tree_update';
      workspaceId: string;
      version: number;
      op: 'add' | 'change' | 'remove' | 'rebuild';
      relPath: string;
      kind: 'dir' | 'file';
      /** Post-apply node body (add/change) — dirs arrive with their children. */
      node?: {
        name: string;
        relPath: string;
        kind: 'dir' | 'file';
        children?: unknown[];
        size: number;
        mtimeMs: number;
        truncated?: boolean;
      };
    }
  | { type: 'done'; finishReason?: string };
