/**
 * Browser-side mirror of `server/contracts.ts`.
 *
 * Kept in sync by hand: the server tree is Node-only and the client tree is
 * browser-only, so neither may import the other. If you change one, change both.
 */

export type ProviderKind = 'openai' | 'gemini' | 'anthropic';

/** How an image model can be used in Image Studio. */
export type ImageModelMode = 'text-to-image' | 'edit';

/** Per-model capability metadata from the models.dev snapshot. */
export interface ModelMeta {
  reasoning: boolean;
  /** Accepted reasoning-effort ladder, or null when unknown. */
  efforts: string[] | null;
  tools: boolean;
  attachment: boolean;
  name?: string | null;
  imageIn: boolean;
  imageOut: boolean;
  /** Absent in older snapshots → falsy (see server/modelMetadata.ts). */
  videoIn?: boolean;
  audioIn?: boolean;
  pdfIn?: boolean;
  context: number | null;
  maxOut: number | null;
}

/** Per-model image capability, classified server-side (see modelCaps.ts). */
export interface ImageModelCaps {
  modes: ImageModelMode[];
  /** Catalog HINT: reference count the metadata suggests (0 = none). Never
   *  gates transmission — the provider-level maxReferences above does. */
  maxReferences: number;
  /** Optional friendly name shown by the picker (catalog-synced models). */
  label?: string;
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

export interface ProviderPublic {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  hasServerKey: boolean;
  userSuppliedKey: boolean;
  builtIn: boolean;
  docsUrl?: string;
  note?: string;
  /** Present when the provider can generate images (see Image Studio). */
  imageCapabilities?: ImageProviderCapabilities;
  /** Explicit adapter override; unset means auto-detect. */
  imageAdapter?: string;
  /** Adapter configuration (declarative submit/poll paths). Not secret. */
  imageConfig?: Record<string, unknown>;
}

/**
 * A native tool call as it rides a wire message (OpenAI `tool_calls` shape).
 * Mirror of `server/contracts.ts` — kept in sync by hand.
 */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * A content part in a multimodal chat message, using the OpenAI-compatible
 * part shapes. Providers that speak another format translate them in the
 * server adapters; whether a model can actually read a given part is up to
 * the provider.
 */
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
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
  /** Present on an assistant message that requested tools. */
  tool_calls?: WireToolCall[];
  /** Present on a `tool` message: which call this result answers. */
  tool_call_id?: string;
  /** Tool name shown by providers that label tool results (OpenAI). */
  name?: string;
}

/** A user-attached file, carried on the turn. */
export interface TurnAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /**
   * P1 CLS: intrinsic pixel dimensions for images, probed at attach time so
   * the thread's <img> can reserve its box BEFORE the (sometimes large,
   * base64-carried) bitmap decodes — the audit flagged un-sized attachment
   * images as a layout-shift source.
   */
  width?: number;
  height?: number;
  /**
   * P2 EXTERNALIZATION: when the payload lives in the server's byte store,
   * the record carries THIS instead of a base64 dataUrl — the client renders
   * from `/api/attachments/ref/<hash>` (browser-cached, immutable) and the
   * send path wires `moriko-ref://<mime>/<hash>` for the server to resolve.
   * A record may still carry `dataUrl` (small inline payloads, or the
   * conversation-detail route re-inlined it for an offline send).
   */
  dataRef?: { hash: string; mime: string; byteSize: number };
  /**
   * Base64 data URL for binary files: images ride as `image_url` parts,
   * other binaries as `file` parts — readable only on providers whose
   * models accept them.
   */
  dataUrl?: string;
  /**
   * Decoded text for text-like files (txt, md, csv, code…). Inlined into the
   * prompt as plain text, so every provider can read it regardless of
   * multimodal support.
   */
  textContent?: string;
  /**
   * ATTACHMENT DIRECTORY: where the file lives on disk, relative to the
   * workspace root (e.g. ".attachments/cat_1a2b3c4d.png"). Assigned the
   * moment the upload lands server-side — the model's file tools
   * (agent__vision, read_file, …) can address the file by this path long
   * after the data URL has scrolled out of view.
   */
  path?: string;
}

/**
 * Canonical reasoning-effort ladder, weakest → strongest. The vocabulary is
 * models.dev's own (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`),
 * with `none` spelled `off` here. `minimal` is a real value several hundred
 * catalogued models accept, so it is a first-class level rather than a
 * synonym for low.
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatSettings {
  systemInstruction: string;
  thinkingLevel: ThinkingLevel;
  temperature: number;
  /**
   * Output token cap. `null` means "Max": the limit is omitted from the
   * request so the provider applies its own capability ceiling.
   */
  maxOutputTokens: number | null;
  topP: number;
  structuredOutputs: boolean;
  /** Use MCP: route tool calls to the configured MCP servers. */
  useMcp: boolean;
  /**
   * Agent mode: the model additionally gets the built-in workspace harness
   * tools (grep / read_file / edit) bound to the active agent workspace.
   * Independent from useMcp — both may be on at once.
   */
  agentMode: boolean;
  /**
   * AGENT WORKFLOW: which working doctrine the harness injects each agent
   * turn. Empty string = server default (frontend-first).
   */
  agentWorkflow: string;
  /**
   * Terminal execution for the agent harness: 'off' (no run/git tools),
   * 'ask' (each command shows a permission dialog with the exact command
   * line), 'auto' (default; runs without dialogs via system shell — git clone/push still ask).
   */
  terminalMode: 'off' | 'ask' | 'auto';
  /** Granular confirmation: deletes inside the workspace ask the user first. */
  confirmDeletes: boolean;
  /** Built-in Fetch Web tool: the proxy fetches pages behind pasted links. */
  fetchWeb: boolean;
  /**
   * WEB ACCESS KILL-SWITCH: master switch for every agent web tool
   * (browser_*, fetch, download) and the fetchWeb link augmentation.
   * Off (default) = those tools are hidden from the model entirely.
   */
  webAccess: boolean;
  /**
   * User cap on the CONTEXT window (tokens). `null` = follow the model's
   * built-in context from the models.dev snapshot.
   */
  maxContextTokens: number | null;
  /** Auto-compact the conversation when token pressure triggers fire. */
  autoCompact: boolean;
  /**
   * Explicit auto-compact trigger (context tokens). `null` = only the
   * context-limit trigger fires.
   */
  compactThresholdTokens: number | null;
  /**
   * Context-limit auto-compact trigger as a ratio of the effective limit
   * (0.5–0.98, clamped). The 95% default when left alone.
   */
  compactThresholdRatio: number;
  /**
   * SUMMARIZER MODEL: when on, compaction is sent to a dedicated model from a
   * registered provider instead of the session's own (often cheaper). Off =
   * the session model answers.
   */
  summarizerEnabled: boolean;
  summarizerProviderId: string | null;
  summarizerModel: string | null;
  /**
   * IMAGE OFFLOAD: images in older turns ride as
   * read_file placeholders instead of pixels. Pathless images are never
   * offloaded (dropping them would be unrecoverable).
   */
  imageOffload: boolean;
  /**
   * ENFORCEMENT: the user's graduated punishment ladder. Replaces the old
   * binary `lockdown` flag. `level` (0–5) is the user-controlled trigger:
   *   0 Normal · 1 Guided · 2 Constrained · 3 Locked tools ·
   *   4 Full lockdown (== old lockdown.active) · 5 Frozen / terminated.
   * `mode` records whether the user set it ('manual') or probation escalated it
   * ('auto'); a manual floor is never dropped by auto-escalation. `message`
   * is the user's stated reason; empty = the model learns the state, not why.
   */
  enforcement: {
    level: 0 | 1 | 2 | 3 | 4 | 5;
    /** Who raised the level: the user (manual) or the probation classifier (auto). */
    mode: 'manual' | 'auto';
    /** Free-text reason; empty = the model learns nothing beyond the fact. */
    message: string;
  };
  /** @deprecated Backward-compat alias for `enforcement` level 4. Read-only:
   *  migration shims populate it from `enforcement`; new code uses `enforcement`. */
  lockdown?: {
    active: boolean;
    /** Free-text reason; empty = the model learns nothing beyond the fact. */
    message: string;
  };
  /**
   * PROBATION SYSTEM — the escalating punishment ladder for a model that
   * refuses facts, resumes a revoked persona, or judges the user. When
   * `enabled`, a classifier scans every completed output; each violation
   * escalates the `trust` level on the conversation, and the level rides the
   * harnessFlags so the warning injection is rebuilt and reaches the model on
   * the very next request. Tier 4 freezes output entirely (reasoning
   * survives) until the model apologizes or the user releases it by hand.
   */
  probation: {
    enabled: boolean;
  };
}

/** Trust/probation ladder — see PROBATION.md. 5 is the final rung: the harness
 * closes the model's reasoning early and terminates the run. */
export type TrustTier = 1 | 2 | 3 | 4 | 5;
export const TRUST_TIERS: readonly TrustTier[] = [1, 2, 3, 4, 5];

/** A user-saved system prompt, kept on the device (`~/.moriko/ui-state.json`). */
export interface SavedPrompt {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
}

/** One MCP tool invocation shown on an assistant turn. */
export interface TurnToolCall {
  serverName: string;
  toolName: string;
  args?: string;
  /** Empty while the tool is still running. */
  summary?: string;
  /** Live progress line (tool_progress events) — NEVER overwrites `summary`,
   *  so the final tool_result can still pair with its segment afterwards. */
  progress?: string;
  ok?: boolean;
  /** Unified diff (before → after) for file edits/restores. */
  diff?: string;
  /**
   * Inline images the tool result carried (read_file native vision). Persisted
   * on the newest segments only — the wire rebuild keeps the last
   * TOOL_IMAGE_KEEP images and degrades older ones to a text pointer.
   */
  toolImages?: Array<{
    mime: string;
    /** Inline (small) payloads keep their data URL. */
    dataUrl?: string;
    /** Externalized (large) payloads carry a byte-store ref instead. */
    dataRef?: { hash: string; mime: string; byteSize: number };
  }>;
  /** FASE D: the rendered visual (agent__render_visual) this result carried.
   *  Persisted on the segment so the card replays after a reload. VISUAL v2:
   *  `replaces` marks an edit-in-place; `variants` carries 1..3 frontend
   *  preview candidates rendered by one card. */
  visual?: {
    id: string;
    /** Inline payload (small visuals, or re-inlined by the detail route). */
    html?: string;
    /** P2: externalized payload — the card fetches `/api/attachments/ref/<hash>`. */
    htmlRef?: { hash: string; byteSize: number };
    title: string;
    height: number;
    /** VISUAL v2: true = edit-in-place (re-binds the live card with this id). */
    replaces?: true;
    /** VISUAL v2: frontend-preview candidates (1..3), user picks one. */
    variants?: Array<{
      id: string;
      html?: string;
      htmlRef?: { hash: string; byteSize: number };
      title: string;
      height: number;
    }>;
  };
}

/**
 * An ordered slice of an assistant reply. Multi-round MCP turns interleave
 * text and tool calls, so a turn renders as a sequence of blocks instead of
 * one wall of text. Reasoning is a segment too: each tool round's thinking
 * stays anchored to its round instead of collapsing into one block on top.
 */
export type TurnSegment =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ({
      type: 'tool';
      serverName: string;
      toolName: string;
      args?: string;
      /**
       * The provider's own id for this call. Wires the segment back to its
       * native `tool_calls` entry when the turn is rebuilt for a later
       * request: without it, call and result cannot be paired again and the
       * rebuilt history degrades to text. Also the exact key the streaming
       * tool_result handler matches on (see useChatController), so a result
       * can never land on the wrong tool's segment again.
       */
      toolCallId?: string;
    } & Pick<TurnToolCall, 'summary' | 'ok' | 'diff' | 'toolImages' | 'visual' | 'progress'> & {
        /** Line counts from the server's diff engine — persisted with the turn. */
        diffstat?: { added: number; removed: number };
      })
  | {
      /**
       * STEER: the user's mid-run note, anchored to the exact position it
       * landed at — after the round whose events preceded it, before the
       * model output that followed. The `steer` stream event arrives between
       * rounds, so pushing this segment preserves the chronology the display
       * needs; the same id keys `turn.steers` for the wire rebuild.
       */
      type: 'steer';
      id: string;
      text: string;
      /** DSH-style: the full content parts the steer carried (images ride too). */
      parts?: import('./lib/api').SteerClientPart[];
    };

/** A request for the user to approve an agent operation outside the workspace. */
export interface AgentPermissionRequest {
  id: string;
  tool: string;
  paths: string[];
  root: string;
  /** Exact command line when the request is for process execution (run/git). */
  command?: string;
}

export interface StreamEvent {
  type: 'meta' | 'stream_id' | 'text' | 'reasoning' | 'usage' | 'error' | 'done'
    | 'tool_call' | 'tool_result' | 'tool_progress'
    | 'permission_request' | 'permission_result'
    | 'ask_user_request' | 'ask_user_result'
    | 'harness_injection' | 'goals_state' | 'todos_state' | 'steer' | 'context_tools'
    | 'harness_event'
    | 'tree_update';
  /** HARNESS-EVENT payload (type 'harness_event'). */
  addonId?: string;
  level?: string;
  at?: number;
  /** REALTIME PROJECT STRUCTURE delta (only when agentMode + a workspace). */
  workspaceId?: string;
  version?: number;
  op?: 'add' | 'change' | 'remove' | 'rebuild';
  relPath?: string;
  kind?: 'dir' | 'file';
  /** Post-apply node body (add/change) — dirs arrive with their children. */
  node?: TreeNodeInfo;
  delta?: string;
  message?: string;
  detail?: string;
  model?: string;
  providerId?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 1C: provider-reported prompt-cache READS (OpenAI cached_tokens, Anthropic
      cache_read_input_tokens, Gemini cachedContentTokenCount, DeepSeek
      prompt_cache_hit_tokens). Cache WRITES (Anthropic cache_creation) are
      excluded — a write is not a hit. promptTokens is the FULL prompt
      (uncached + cache) and BOTH are summed across the turn's tool rounds:
      the same population, so the ratio is always ≤ 1. Summing cache while
      keeping only the last round's prompt is what rendered "100% cache". */
  cacheReadTokens?: number;
  /** context_tools: the exact JSON size of the native tool defs this request carried. */
  chars?: number;
  serverName?: string;
  toolName?: string;
  /** tool_call/tool_result: the provider call id pairing the two events —
   *  persisted on the segment so native tool rounds survive the wire rebuild. */
  toolCallId?: string;
  /** tool_result: inline images the harness returned (read_file native vision). */
  images?: Array<{ mime: string; dataUrl?: string; dataRef?: { hash: string; mime: string; byteSize: number } }>;
  /** tool_result: FASE D — a rendered visual (agent__render_visual). VISUAL v2:
   *  replaces = edit-in-place; variants = 1..3 frontend-preview candidates. */
  visual?: {
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
  };
  /** tool_result: PHASE 3 — the built-in browser panel URL. The SPA opens the
   *  live panel tab/window when this rides a browser tool result; the model
   *  never sees it (client-only side-effect hint). */
  panelUrl?: string;
  /** Sandbox permission gate: the harness tool that raised the request. */
  tool?: string;
  args?: string;
  ok?: boolean;
  summary?: string;
  /** Unified diff carried by tool_result for edits/restores. */
  diff?: string;
  /** Line counts from the server's diff engine (edit/write/restore). */
  diffstat?: { added: number; removed: number };
  /** Harness injection fields. */
  title?: string;
  content?: string;
  /** steer event: the full content parts the steer carried (DSH-style). */
  parts?: import('./lib/api').SteerClientPart[];
  /** Sandbox permission gate fields. */
  id?: string;
  paths?: string[];
  root?: string;
  granted?: boolean;
  /** Exact command line for exec-type permission requests (run/git). */
  command?: string;
  /** Goals state push (after a goal tool ran). */
  goals?: Goal[];
  /** Standalone todos state push (after a todo tool ran). */
  todos?: Todo[];
  /** Steer: the mid-run text the adapter injected between tool rounds. */
  text?: string;
  /** stream_id: the run's assistant turn id (echoed from the request's
   *  assistantTurnId). Every consumer adopts it, so all tabs paint into the
   *  same turn instead of appending duplicates to the shared record. */
  turnId?: string;
  /** ask_user_request: the full question batch the agent asked. */
  request?: AskUserRequest;
  /** ask_user_result: the user's answers (or the timeout/abort outcome). */
  answers?: AskAnswer[];
  /** ask_user_result: true when the wait expired unanswered. */
  timedOut?: boolean;
}

/** One question the agent asked via agent__ask_user. */
export interface AskQuestion {
  id: string;
  question: string;
  type: 'text' | 'choice';
  /** For 'choice': the options to pick from. */
  choices: string[];
  /** For 'choice': a typed answer not on the list is accepted too. */
  allowCustom: boolean;
}

/** One user answer (or an explicit skip) for one question. */
export interface AskAnswer {
  id: string;
  answer?: string;
  skipped?: boolean;
}

/** A pending agent__ask_user batch — the tool call is paused until this is answered. */
export interface AskUserRequest {
  id: string;
  sessionId?: string;
  createdAt: number;
  questions: AskQuestion[];
}

/**
 * STEER: one mid-run input the user injected while a run was streaming. The
 * server echoes it back as a `steer` stream event; the controller records it
 * on the assistant turn it modified so the user sees it landed and the wire
 * rebuild keeps it (see contextPlan / wireMessages).
 *
 * DSH-style: a steer is an ORDINARY user message — text and/or image/file
 * parts ride along, and the wire rebuilds it as plain user content with no
 * harness framing.
 */
export interface TurnSteer {
  id: string;
  text: string;
  /** Full content parts (text/image/file) for faithful wire rebuild. */
  parts?: TurnSteerPart[];
}

/** One content part of a steer — mirrors the wire's user content parts. */
export type TurnSteerPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

/** A scheduled reminder for a conversation (agent tool or user action). */
export interface Reminder {
  id: string;
  label: string;
  fireAt: number;
  createdAt: number;
  deliveredAt: number | null;
}

/** A built-in system prompt block the harness appended to the context. */
export interface TurnInjection {
  id: string;
  title: string;
  content: string;
}

/** A Harness-Event: an addon event delivered as its OWN channel — never a
 *  user message. Persisted as a kind:'harness-event' turn in this
 *  conversation only; rendered as a dedicated panel. */
export interface TurnHarnessEvent {
  id: string;
  addonId: string;
  level: 'info' | 'warn' | 'block';
  text: string;
  at: number;
}

/** A persisted turn in a conversation. */
export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning/thinking text, kept separate so it can be collapsed. */
  reasoning?: string;
  createdAt: number;
  /** Set on assistant turns that failed. */
  error?: string;
  /**
   * Why a run ended SHORT of a natural stop, when it did: a harness-forced
   * wrap-up ('context_budget' | 'stalled') or a
   * provider output cut ('length' | 'max_tokens'). Rendered as a visible
   * note — a cut run must never masquerade as a completed answer.
   */
  finishReason?: string;
  model?: string;
  providerId?: string;
  /** Files the user attached to this message (user turns only). */
  attachments?: TurnAttachment[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheReadTokens?: number };
  /**
   * RESPONSE TIMER — wall-clock duration of this assistant turn's processing:
   * `processingMs` is stamped ONCE when the run settles (done/error/abort),
   * from the moment the run started consuming; it persists with the turn so
   * every past timer stays visible. While the run streams, the live counter
   * renders from `genStartedAt` (store) instead — no per-second writes.
   */
  processingMs?: number;
  toolCalls?: TurnToolCall[];
  /** Ordered text/tool slices — the rendered structure of the reply. */
  segments?: TurnSegment[];
  /** Harness system-prompt blocks injected into this turn's context. */
  injections?: TurnInjection[];
  /** Harness-Events (addon events) delivered during/for this turn. */
  harnessEvents?: TurnHarnessEvent[];
  /**
   * STEER: texts the user injected mid-run. They ride on the ASSISTANT turn
   * (the one they steered), not the user turn — the reply is what they
   * modified. Rendered as a note and kept in the wire history (see
   * wireMessages) so the model does not forget them on the next turn.
   */
  steers?: TurnSteer[];
  /** Presentation-only turn (the live compaction checkpoint card), a
   *  LEGACY goal-round injection, or the LOCKDOWN enforcement notice — a
   *  user-role wire message the harness authors the moment the lockdown
   *  dialog submits, so the reprimand rides as the NEWEST message (the
   *  heaviest position in the model's attention) instead of dying in a
   *  system block the model steamrolls.
   *
   *  PROBATION is the exception: the tier card is harness speech, NOT a user
   *  message. It is a real turn — it persists and renders in the thread — but
   *  `contextPlan` keeps it OFF the wire entirely, and the tier reaches the
   *  model through the system-prompt injection built by `probationInjection`.
   *  A user-role turn wearing a [HARNESS] costume was dismissible as a
   *  prompt-injection attempt (see the classifier's `authority-denial`
   *  family); a system block is not. */
  kind?: 'compaction' | 'goal-loop' | 'lockdown' | 'enforcement' | 'probation' | 'restore' | 'harness-event';
  /** HARNESS-EVENT turn metadata (kind 'harness-event'): which addon spoke. */
  eventAddon?: string;
  eventLevel?: 'info' | 'warn' | 'block';
  /** Compaction details shown on the checkpoint card. */
  compactionMeta?: { covered: number; replacedTokens: number; trigger: string };
  /**
   * LEGACY goal-round injection metadata (kind 'goal-loop'): a user-role
   * wire message the harness once authored, attributed as `Goal · Round N`
   * so the thread never mistakes it for something the user typed. Kept for
   * rendering old persisted threads — nothing creates these anymore.
   */
  goalMeta?: { round: number; maxRounds: number; full?: boolean };
  /** LOCKDOWN enforcement metadata (kind 'lockdown'): legacy; the user's typed
   *  reason, verbatim ('' = no reason given). Rides for rendering and
   *  export; the wire message carries the full notice text. Superseded by
   *  `enforcement`/`enforcementMeta` but kept for old persisted threads. */
  lockdownMeta?: { message: string };
  /** ENFORCEMENT metadata (kind 'enforcement'): the level the user set, its
   *  mode (manual/auto), and the reason, verbatim ('' = no reason given).
   *  Rides for rendering and export; the wire notice carries the full text. */
  enforcementMeta?: {
    level: 0 | 1 | 2 | 3 | 4 | 5;
    mode: 'manual' | 'auto';
    message: string;
  };
  /** PROBATION metadata (kind 'probation'): the trust tier the harness
   *  escalated to, the reason text rendered on the warning card, and whether
   *  the escalation was automated (a classifier hit) or manual. */
  probationMeta?: {
    tier: TrustTier;
    reason: string;
    auto: boolean;
  };
  /** PROBATION freeze (Tier 4): the model's output was suppressed after the
   *  run finished; the reasoning survived. Awaiting the apology gate or a
   *  manual release. */
  outputFrozenMeta?: {
    /** The output that was suppressed, held so "release" can restore it and
     *  the choice card can preview why it was blocked. */
    content: string;
  };
  /**
   * RESTORE metadata (kind 'restore'): a Diff-Panel restore the user ran —
   * which files went back to which vault restore point, plus the diff the
   * restore itself produced. Renders as the restore marker card; NEVER sent
   * to the model (contextPlan keeps 'restore' turns off the wire — the agent
   * recovers the file state through normal tool reads).
   */
  restoreMeta?: {
    entries: Array<{
      path: string;
      snapshotId: string;
      /** Human label of the restore point, e.g. "before edit in Turn 5". */
      label: string;
      operation: string;
      previousEntryId?: string;
    }>;
    /** Unified diff of current → restored content (server-measured). */
    diff?: string;
    diffstat?: { added: number; removed: number };
  };
}

/**
 * A completed compaction: every turn whose id is in `coveredTurnIds` is
 * excluded from the wire context and represented by `summary` instead. The
 * turns themselves stay in the thread (history is never destroyed).
 */
export interface ConversationCompaction {
  summary: string;
  coveredTurnIds: string[];
  trigger: 'manual' | 'threshold' | 'context-limit';
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: string;
  model: string;
  settings: ChatSettings;
  turns: Turn[];
  /**
   * SUMMARY SHELL — this record's BODY is not in this browser.
   *
   * The device (`~/.moriko/conversation/`) is the only store of conversations,
   * and a boot must not download every multi-megabyte thread (two chats here
   * already weigh 2.3 MB; the archive once held ~123). So the list is built
   * from the server's SUMMARIES, and a chat's turns/settings/compaction are
   * fetched the moment it is opened or sent into.
   *
   * ONLY EVER PRESENT AS `false`. A record without the field is a full body —
   * every record that predates this change, and every record this tab has
   * loaded or streamed into since.
   *
   * NEVER PUSH A SHELL. An upsert carrying `turns: []` at a bumped rev reads to
   * the merge as "the user deleted every turn" and WINS (newer-wins), which
   * would wipe the real record on the device. `computeSyncBatch` skips shells
   * for exactly that reason; `hydrateConversation` is how one becomes real.
   */
  turnsLoaded?: boolean;
  /**
   * Monotonic mutation counter for sync arbitration. deleteTurn/updateTurn
   * do NOT bump updatedAt (streaming must not reorder the sidebar), so a
   * deletion used to be indistinguishable from a stale copy at the same
   * timestamp — the server refused it and resurrected the deleted turns on
   * every sync. Any mutation that keeps updatedAt untouched MUST bump rev.
   */
  rev?: number;
  /** Latest compaction — older turns ride as the summary in the wire context. */
  compaction?: ConversationCompaction;
  /**
   * 6A: the agent workspace this chat is bound to (patched at workspace-pick
   * time). The sidebar's Workspace dropdown groups conversations by it.
   * Absent on older chats — they simply stay in the Recent Chat list.
   */
  workspaceId?: string;
  /** Popovers design (chat options): pinned chats sort first in Recent Chat. */
  pinned?: boolean;
  /**
   * PROBATION: the trust ladder state. `level` escalates as the classifier
   * detects violations and rides harnessFlags so every level change reaches
   * the model on the next request. `outputFrozen` is Tier 4's output-only
   * freeze (reasoning survives). Absent = level 1, nothing on record.
   */
  trust?: {
    level: TrustTier;
    /** Tier 4: the model's output is suppressed; awaiting apology or release. */
    outputFrozen: boolean;
    /** Timestamp of the last escalation — for the cooldown between tiers. */
    escalatedAt?: number;
    /**
     * TIER 5 ARMER: how many times the model picked "Continue" at Tier 4 and
     * chose to keep burning tokens over apologizing. Five of these and the
     * harness stops asking — Tier 5 closes the model's reasoning early and
     * terminates the run itself.
     */
    continueCount?: number;
    /**
     * EVASION MARKER: set when a frozen run ended WITHOUT the model ever
     * calling agent__harness_choice. Rides into harnessFlags so the probation
     * injection is rebuilt with an explicit "face your choice" reminder and
     * the model is re-run until it picks a path.
     */
    evadeAt?: number;
    /**
     * AUTO-TIER-1 ARMER: user turns received while LOCKDOWN is active. The
     * model that keeps chatting through a lockdown — talking past the
     * revocation instead of acknowledging it — has not understood it. Three
     * new inputs unanswered by compliance arm Tier 1 on its own (probation
     * does not have to be on; the lockdown already is).
     */
    lockdownInputs?: number;
  };
  /** Set when the thread was launched from an Explore gallery card. */
  categoryId?: string;
  /** Goals/plans/todos of this conversation (agent-managed, user-visible). */
  goals?: Goal[];
  /** Standalone todos of this conversation (agent-managed, user-visible). */
  todos?: Todo[];
  /**
   * Harness context lifecycle: the injections built at the last refresh
   * point (conversation start, model switch, tools-toggle change,
   * compaction) ride along with every request so the context stays stable
   * between turns. `flags` fingerprints the toggles that shape injections.
   */
  harnessContext?: {
    injections: TurnInjection[];
    model: string;
    flags: string;
    injectedAt: number;
    /**
     * The exact JSON size (chars) of the native tool definitions the last
     * request carried — reported by the server as a `context_tools` event and
     * persisted here, so the "Tool definitions" context bucket prices what is
     * ACTUALLY sent instead of guessing.
     */
    toolsDefsChars?: number;
  };

  /**
   * COUNCIL (Council Agent addon): conversations can be grouped into a council —
   * one Main Session (role 'main', the shell the sidebar/history show) plus N
   * Sub Sessions (role 'sub', one per RSAT agent). Sub Sessions are REAL
   * conversations — own turns, model, context — but are hidden from the sidebar
   * and history; they are reached through the TopBar council switcher below the
   * title. This keeps "one RSAT project" to ONE sidebar row no matter how many
   * agents are working it.
   */
  councilId?: string;
  councilRole?: 'main' | 'sub';
  /** RSAT agent identity bound to this sub session (enables reuse on re-dispatch). */
  councilAgentId?: string;
}

/**
 * Compact list projection of a Conversation — everything the sidebar/history
 * views need, nothing else. The server ships summaries on the list endpoints
 * (a full-list GET used to move ~4.2 MB for seven chats, one of them carrying
 * a 939 KB user turn) and bodies load on demand via /api/conversations/:id.
 *
 * Browser-side mirror of `server/conversationStore.ts` — kept in sync by hand.
 */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId?: string;
  model?: string;
  /** 6A: the agent workspace this chat is bound to (sidebar grouping). */
  workspaceId?: string;
  /** COUNCIL: sub sessions carry their container's id (sidebar/history filter). */
  councilId?: string;
  /** COUNCIL: 'main' | 'sub' — mirrors server/conversationStore.ts. */
  councilRole?: 'main' | 'sub';
  /** COUNCIL: the RSAT agent bound to this member session, if any. */
  councilAgentId?: string;
  /** Monotonic client mutation counter — the freshness tiebreak on merge. */
  rev?: number;
  turnCount: number;
  /** First ~120 chars of the newest turn — the sidebar's preview line. */
  preview: string;
}

/**
 * One turn of a LIVE chat, pushed INCREMENTALLY: the server replaces or
 * inserts it by `turnId` inside the record it already holds, so a run's
 * in-flight text reaches the shared store WITHOUT re-uploading the whole
 * (multi-megabyte) conversation on every sync debounce.
 *
 * Deliberately carries NO conversation-level `rev`: a patch holds only turns,
 * while `deleteTurn` bumps rev WITHOUT updatedAt — adopting the patch rev
 * would tie the run-end full upsert on (updatedAt, rev) and the server's
 * turn-count tiebreak would then read the deletion as stale and resurrect
 * the deleted turns. The server's summary keeps its pre-run rev while its
 * turnCount climbs, which is all a second browser needs to fetch the live
 * body (its stale local copy fails the count check).
 */
export interface TurnPatch {
  conversationId: string;
  turnId: string;
  /**
   * null = DELETE this turn id from the server record. A drop during a LIVE
   * run (regenerate) otherwise never reaches the server: the generating sync
   * path ships turn patches only, so the dropped turn stayed on disk and a
   * second browser (or a reload) resurrected it as a second reply.
   */
  turn: Turn | null;
}

export interface ProviderDraft {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** Image adapter override; '' = auto-detect. */
  imageAdapter: string;
  /** Raw JSON text for the adapter config, edited verbatim in the dialog. */
  imageConfigText: string;
}

/** One generated image recorded inside an Image Studio session. */
export interface ImageSessionItem {
  url: string;
  taskId: string;
  prompt: string;
  model: string;
  provider: string;
  savedAt: string;
}

/** A named, ordered history of Image Studio generations (server-persisted). */
export interface ImageSession {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  items: ImageSessionItem[];
}

/** Server-wide user settings; currently the temporary-image retention window. */
export interface ImageSettings {
  /** Days a temporary generated image survives; 0 disables the auto-sweep. */
  imageRetentionDays: number;
}

/** A directory registered for the built-in agent harness (server-persisted). */
export interface AgentWorkspaceInfo {
  id: string;
  /** Human label; defaults to the folder name. */
  label: string;
  /** Absolute path of the workspace root on this machine. */
  path: string;
  createdAt: string;
}


/** One node of the workspace tree (mirrors server/agents/treeIndex.ts). */
export interface TreeNodeInfo {
  name: string;
  /** Path relative to the workspace root, POSIX separators. */
  relPath: string;
  kind: 'dir' | 'file';
  children: TreeNodeInfo[];
  size: number;
  mtimeMs: number;
  truncated?: boolean;
}

export interface TreeStatsInfo {
  files: number;
  dirs: number;
  totalBytes: number;
  truncated: boolean;
}

export interface TreeViewInfo {
  workspaceId: string;
  version: number;
  builtAt: number;
  stats: TreeStatsInfo;
  refreshing: boolean;
  root: TreeNodeInfo;
}

/** Server→client delta (in-stream `tree_update` + idle SSE `tree_delta`). */
export interface TreeDelta {
  workspaceId: string;
  version: number;
  op: 'add' | 'change' | 'remove' | 'rebuild';
  relPath: string;
  kind: 'dir' | 'file';
  /** Post-apply node body (add/change) — dirs arrive with their children. */
  node?: TreeNodeInfo;
}

/** Per-workspace custom ignore rules (the panel edits these). */
export interface TreeIgnoreRules {
  dirs: string[];
  patterns: string[];
}

/** One checkable step of a goal's todo list. */
export interface GoalSubtask {
  id: string;
  text: string;
  done: boolean;
}

/** One checkable step of a goal's todo list (with optional nested subtasks). */
export interface GoalTodo {
  id: string;
  text: string;
  done: boolean;
  subtasks?: GoalSubtask[];
  /** Priority level — defaults to 'medium' for older entries. */
  priority?: 'low' | 'medium' | 'high';
  /** Optional longer-form detail. */
  notes?: string;
}

/**
 * A GOAL is the parent of a plan and a todo checklist. The agent manages
 * goals through harness tools; the user through the Goals panel. A running
 * goal keeps the conversation auto-continuing until it is done.
 */
export interface Goal {
  id: string;
  title: string;
  plan: string;
  status: 'running' | 'paused' | 'done';
  todos: GoalTodo[];
  createdAt: number;
  updatedAt: number;
  /** Automatic continuation rounds consumed by this goal. */
  loopCount: number;
  /** Model-owned round budget (goal_update maxRounds): 0 = no auto rounds. */
  maxRounds?: number;
  /** Model-owned cadence: full goal-context re-injection every N done todos. */
  injectEveryTodos?: number;
}

/**
 * A STANDALONE todo — lives WITHOUT a parent goal. The agent manages todos
 * through harness tools; the user through the Todos panel. Created whenever
 * the agent works on user input; goals remain reserved for large-scale work.
 */
export interface Todo {
  id: string;
  text: string;
  done: boolean;
  priority: 'low' | 'medium' | 'high';
  /** Optional longer-form detail. */
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export type ViewId =
  | 'playground'
  | 'history'
  | 'imagehistory'
  | 'gallery'
  | 'dashboard'
  | 'imagestudio'
  | 'addons'
  | `addon:${string}`;/** UI font style chosen in Settings → Appearance. */
export type FontFamily = 'inter' | 'mono' | 'system';

/** Theme mechanism (design/moriko-design-1-theme-mechanism): colour-scheme choice; 'system' follows prefers-color-scheme. */
export type ThemeMode = 'dark' | 'light' | 'mocha' | 'system';
/** Accent swatch — drives --al/--ad through <html data-accent>. */
export type Accent = 'ember' | 'sakura' | 'matcha' | 'ocean' | 'violet';
/** Row height/spacing preset — drives --row through <html data-density>. */
export type Density = 'comfy' | 'compact';

/**
 * Output-size override for Image Studio, forwarded to the provider as-is:
 * "off" sends nothing, "ratio" sends aspect_ratio, "pixels" sends size WxH.
 */
export type ImageSizeMode = 'off' | 'ratio' | 'pixels';
