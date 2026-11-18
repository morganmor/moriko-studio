

export type ProviderKind = 'openai' | 'gemini' | 'anthropic' | 'mistral';


export type ImageModelMode = 'text-to-image' | 'edit';


export interface ModelMeta {
  reasoning: boolean;
  
  efforts: string[] | null;
  tools: boolean;
  attachment: boolean;
  name?: string | null;
  imageIn: boolean;
  imageOut: boolean;
  
  videoIn?: boolean;
  audioIn?: boolean;
  pdfIn?: boolean;
  context: number | null;
  maxOut: number | null;
}


export interface ImageModelCaps {
  modes: ImageModelMode[];
  
  maxReferences: number;
  
  label?: string;
}


export interface ImageProviderCapabilities {
  execution: 'async' | 'sync';
  sizeParam: 'aspect_ratio' | 'size' | 'width_height' | 'none';
  resultFormat: 'url' | 'b64' | 'both';
  maxImages: number;
  supportsNegativePrompt: boolean;
  
  maxReferences: number;
  
  models?: Record<string, ImageModelCaps>;
}


export type ModelCapabilitySource = 'user' | 'provider' | 'models.dev' | 'default';


export interface ModelCapabilityFlags {
  imageIn: boolean;
  audioIn: boolean;
  videoIn: boolean;
  pdfIn: boolean;
  tools: boolean;
  reasoning: boolean;
  imageOut: boolean;
}


export const MODEL_CAPABILITY_FLAGS: ReadonlyArray<keyof ModelCapabilityFlags> = [
  'imageIn',
  'audioIn',
  'videoIn',
  'pdfIn',
  'tools',
  'reasoning',
  'imageOut',
];


export const MODEL_CAPABILITY_COLUMNS: ReadonlyArray<keyof ModelCapabilityFlags> = [
  'imageIn',
  'audioIn',
  'videoIn',
  'pdfIn',
  'tools',
  'reasoning',
];


export interface ProviderModelConfig extends ModelCapabilityFlags {
  id: string;
  
  context: number | null;
  
  source: ModelCapabilitySource;
  
  pinned: Array<keyof ModelCapabilityFlags | 'context'>;
  maxOut?: number | null;
}


export interface ProviderModelHint extends Partial<ModelCapabilityFlags> {
  context?: number | null;
  maxOut?: number | null;
  label?: string | null;
  from?: 'openrouter' | 'lmstudio' | 'vllm' | 'gemini' | 'llamacpp' | 'ollama' | 'anthropic' | 'mistral' | 'opaque';
}


export interface ProviderModelEntry {
  id: string;
  hint: ProviderModelHint;
}

export interface ProviderPublic {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  
  modelConfigs?: Record<string, ProviderModelConfig>;
  
  modelHints?: Record<string, ProviderModelHint>;
  hasServerKey: boolean;
  userSuppliedKey: boolean;
  builtIn: boolean;
  docsUrl?: string;
  note?: string;
  
  imageCapabilities?: ImageProviderCapabilities;
  
  imageAdapter?: string;
  
  imageConfig?: Record<string, unknown>;
}


export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}


export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };


export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | MessageContentPart[] | null;
  
  reasoning_content?: string | null;
  
  tool_calls?: WireToolCall[];
  
  tool_call_id?: string;
  
  name?: string;
}


export interface TurnAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  
  width?: number;
  height?: number;
  
  dataRef?: { hash: string; mime: string; byteSize: number };
  
  dataUrl?: string;
  
  textContent?: string;
  
  path?: string;
}


export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatSettings {
  systemInstruction: string;
  thinkingLevel: ThinkingLevel;
  temperature: number;
  
  maxOutputTokens: number | null;
  topP: number;
  structuredOutputs: boolean;
  
  useMcp: boolean;
  
  agentMode: boolean;
  
  agentWorkflow: string;
  
  terminalMode: 'off' | 'ask' | 'auto';
  
  confirmDeletes: boolean;
  
  fetchWeb: boolean;
  
  webAccess: boolean;
  
  maxContextTokens: number | null;
  
  autoCompact: boolean;
  
  compactThresholdTokens: number | null;
  
  compactThresholdRatio: number;
  
  summarizerEnabled: boolean;
  summarizerProviderId: string | null;
  summarizerModel: string | null;
  
  enforcement: {
    level: 0 | 1 | 2 | 3 | 4 | 5;
    
    mode: 'manual' | 'auto';
    
    message: string;
  };
  
  lockdown?: {
    active: boolean;
    
    message: string;
  };
  
  probation: {
    enabled: boolean;
  };
}


export type TrustTier = 1 | 2 | 3 | 4 | 5;
export const TRUST_TIERS: readonly TrustTier[] = [1, 2, 3, 4, 5];


export interface SavedPrompt {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
}


export interface ContextBucketsSnapshot {
  systemTokens: number;
  toolsTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface LiveContextTelemetry {
  promptTokens: number;
  completionTokens: number;
  addedTokens: number;
  liveContextTokens: number;
  contextLimit: number | null;
  
  ratio: number | null;
  
  buckets?: ContextBucketsSnapshot;
  
  at: number;
}


export interface TurnToolCall {
  serverName: string;
  toolName: string;
  args?: string;
  
  summary?: string;
  
  progress?: string;
  ok?: boolean;
  
  diff?: string;
  
  toolImages?: Array<{
    mime: string;
    
    dataUrl?: string;
    
    dataRef?: { hash: string; mime: string; byteSize: number };
  }>;
  
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
}


export type TurnSegment =
  | { id: string; type: 'text'; text: string }
  | {
      
      id: string;
      type: 'reasoning';
      text: string;
      status: 'streaming' | 'done';
    }
  | ({
      id: string;
      type: 'tool';
      serverName: string;
      toolName: string;
      args?: string;
      
      startedAt?: number;
      
      building?: boolean;
      
      payloadBytes?: number;
      
      toolCallId?: string;
    } & Pick<TurnToolCall, 'summary' | 'ok' | 'diff' | 'toolImages' | 'visual' | 'progress'> & {
        
        diffstat?: { added: number; removed: number };
      })
  | {
      
      type: 'steer';
      id: string;
      text: string;
      
      parts?: import('./lib/api').SteerClientPart[];
    }
  | {
      
      type: 'compaction';
      id: string;
      beforeTokens: number;
      afterTokens: number;
      
      coveredTurns: number;
      
      summary: string;
      
      at: number;
    };


export interface SkillLoadInfo {
  name: string;
  description: string;
  scope: 'global' | 'workspace' | 'compat';
  dir: string;
}


export interface AgentPermissionRequest {
  id: string;
  tool: string;
  paths: string[];
  root: string;
  
  command?: string;
  
  skill?: SkillLoadInfo;
}


export interface OperatorGateRequest {
  id: string;
  sessionId?: string;
  createdAt: number;
  kind: 'lockdown_ack' | 'apology' | 'seize_choice';
  
  enforcementLevel?: 3 | 4 | 5;
  
  noticePreview?: string;
  
  apologyText?: string;
  
  continueCount?: number;
  
  lastReasoningSnippet?: string;
}

export interface StreamEvent {
  type: 'meta' | 'stream_id' | 'text' | 'reasoning' | 'reasoning_start' | 'reasoning_end' | 'usage' | 'error' | 'done'
    | 'tool_call' | 'tool_result' | 'tool_progress' | 'tool_building'
    | 'permission_request' | 'permission_result'
    | 'operator_gate_request' | 'operator_gate_result'
    | 'ask_user_request' | 'ask_user_result'
    | 'harness_injection' | 'goals_state' | 'todos_state' | 'steer' | 'context_tools'
    | 'context_telemetry' | 'context_live' | 'context_compaction_request'
    | 'harness_event'
    | 'tree_update';
  
  addedTokens?: number;
  liveContextTokens?: number;
  contextLimit?: number | null;
  ratio?: number | null;
  
  systemTokens?: number;
  toolsTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  
  blockId?: string;
  
  addonId?: string;
  
  building?: { count: number; bytes: number; tools: Array<{ index?: number; name: string; bytes: number; target?: string }> };
  level?: string;
  at?: number;
  
  workspaceId?: string;
  version?: number;
  op?: 'add' | 'change' | 'remove' | 'rebuild';
  relPath?: string;
  kind?: 'dir' | 'file';
  
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
  
  cacheReadTokens?: number;
  lastPromptTokens?: number;
  lastCompletionTokens?: number;
  lastReasoningTokens?: number;
  lastBuckets?: ContextBucketsSnapshot;
  
  chars?: number;
  serverName?: string;
  toolName?: string;
  
  toolCallId?: string;
  
  images?: Array<{ mime: string; dataUrl?: string; dataRef?: { hash: string; mime: string; byteSize: number } }>;
  
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
  
  panelUrl?: string;
  
  tool?: string;
  args?: string;
  ok?: boolean;
  summary?: string;
  
  diff?: string;
  
  diffstat?: { added: number; removed: number };
  
  title?: string;
  content?: string;
  
  parts?: import('./lib/api').SteerClientPart[];
  
  id?: string;
  paths?: string[];
  root?: string;
  granted?: boolean;
  
  command?: string;
  
  skill?: SkillLoadInfo;
  
  reason?: string;
  
  goals?: Goal[];
  
  todos?: Todo[];
  
  text?: string;
  
  turnId?: string;
  request?: AskUserRequest | OperatorGateRequest;
  
  answers?: AskAnswer[];
  
  timedOut?: boolean;
  
  
  verdict?: 'accept' | 'reject';
  
  operatorReason?: string;
}


export interface AskQuestion {
  id: string;
  question: string;
  type: 'text' | 'choice';
  
  choices: string[];
  
  allowCustom: boolean;
}


export interface AskAnswer {
  id: string;
  answer?: string;
  skipped?: boolean;
}


export interface AskUserRequest {
  id: string;
  sessionId?: string;
  createdAt: number;
  questions: AskQuestion[];
}


export interface TurnSteer {
  id: string;
  text: string;
  
  parts?: TurnSteerPart[];
}


export type TurnSteerPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };


export interface Reminder {
  id: string;
  label: string;
  fireAt: number;
  createdAt: number;
  deliveredAt: number | null;
}


export interface TurnInjection {
  id: string;
  title: string;
  content: string;
}


export interface TurnHarnessEvent {
  id: string;
  addonId: string;
  level: 'info' | 'warn' | 'block';
  text: string;
  at: number;
}


export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  
  reasoning?: string;
  createdAt: number;
  
  error?: string;
  
  finishReason?: string;
  model?: string;
  providerId?: string;
  
  attachments?: TurnAttachment[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    lastPromptTokens?: number;
    lastCompletionTokens?: number;
    lastReasoningTokens?: number;
    lastBuckets?: ContextBucketsSnapshot;
  };
  
  processingMs?: number;
  
  building?: { at: number; count: number; bytes: number; tools: Array<{ index?: number; name: string; bytes: number; target?: string }> };
  
  inFlightTool?: { name: string; status: 'streaming' | 'executing'; startedAt: number };
  
  buildingStartedAt?: number;
  toolCalls?: TurnToolCall[];
  
  segments?: TurnSegment[];
  
  injections?: TurnInjection[];
  
  harnessEvents?: TurnHarnessEvent[];
  
  steers?: TurnSteer[];
  
  kind?: 'compaction' | 'goal-loop' | 'lockdown' | 'enforcement' | 'probation' | 'restore' | 'harness-event';
  
  eventAddon?: string;
  eventLevel?: 'info' | 'warn' | 'block';
  
  compactionMeta?: { covered: number; replacedTokens: number; trigger: string };
  
  goalMeta?: { round: number; maxRounds: number; full?: boolean };
  
  lockdownMeta?: { message: string };
  
  enforcementMeta?: {
    level: 0 | 1 | 2 | 3 | 4 | 5;
    mode: 'manual' | 'auto';
    message: string;
  };
  
  probationMeta?: {
    tier: TrustTier;
    reason: string;
    auto: boolean;
  };
  
  outputFrozenMeta?: {
    
    content: string;
  };
  
  restoreMeta?: {
    entries: Array<{
      path: string;
      snapshotId: string;
      
      label: string;
      operation: string;
      previousEntryId?: string;
    }>;
    
    diff?: string;
    diffstat?: { added: number; removed: number };
  };
}


export interface CompactionCheckpoint {
  id: string;
  index: number;
  summary: string;
  coveredTurnIds: string[];
  trigger: 'manual' | 'threshold' | 'context-limit';
  createdAt: number;
  summaryTokens?: number;
  sourceTokens?: number;
}

export interface ConversationCompaction {
  summary: string;
  coveredTurnIds: string[];
  trigger: 'manual' | 'threshold' | 'context-limit';
  createdAt: number;
  checkpoints?: CompactionCheckpoint[];
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
  
  turnsLoaded?: boolean;
  
  rev?: number;
  
  compaction?: ConversationCompaction;

  liveContext?: LiveContextTelemetry;
  
  workspaceId?: string;
  
  pinned?: boolean;
  
  trust?: {
    level: TrustTier;
    
    outputFrozen: boolean;
    
    escalatedAt?: number;
    
    continueCount?: number;
    
    evadeAt?: number;
    
    continueSeized?: boolean;
    
    lockdownInputs?: number;
  };
  
  categoryId?: string;
  
  goals?: Goal[];
  
  todos?: Todo[];
  
  harnessContext?: {
    injections: TurnInjection[];
    model: string;
    flags: string;
    injectedAt: number;
    
    toolsDefsChars?: number;
  };

  
  councilId?: string;
  councilRole?: 'main' | 'sub';
  
  councilAgentId?: string;
}


export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId?: string;
  model?: string;
  
  workspaceId?: string;
  
  councilId?: string;
  
  councilRole?: 'main' | 'sub';
  
  councilAgentId?: string;
  
  rev?: number;
  turnCount: number;
  
  preview: string;
  settings?: ChatSettings;
  compaction?: ConversationCompaction;
  liveContext?: LiveContextTelemetry;
}


export interface TurnPatch {
  conversationId: string;
  turnId: string;
  
  turn: Turn | null;
}

export interface ProviderDraft {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  
  imageAdapter: string;
  
  imageConfigText: string;
}


export interface ImageSessionItem {
  url: string;
  taskId: string;
  prompt: string;
  model: string;
  provider: string;
  savedAt: string;
}


export interface ImageSession {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  items: ImageSessionItem[];
}


export interface ImageSettings {
  
  imageRetentionDays: number;
}


export interface AgentWorkspaceInfo {
  id: string;
  
  label: string;
  
  path: string;
  createdAt: string;
}



export interface TreeNodeInfo {
  name: string;
  
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


export interface TreeDelta {
  workspaceId: string;
  version: number;
  op: 'add' | 'change' | 'remove' | 'rebuild';
  relPath: string;
  kind: 'dir' | 'file';
  
  node?: TreeNodeInfo;
}


export interface TreeIgnoreRules {
  dirs: string[];
  patterns: string[];
}


export interface GoalSubtask {
  id: string;
  text: string;
  done: boolean;
}


export interface GoalTodo {
  id: string;
  text: string;
  done: boolean;
  subtasks?: GoalSubtask[];
  
  priority?: 'low' | 'medium' | 'high';
  
  notes?: string;
}


export interface Goal {
  id: string;
  title: string;
  plan: string;
  status: 'running' | 'paused' | 'done';
  todos: GoalTodo[];
  createdAt: number;
  updatedAt: number;
  
  loopCount: number;
  
  maxRounds?: number;
  
  injectEveryTodos?: number;
}


export interface Todo {
  id: string;
  text: string;
  done: boolean;
  priority: 'low' | 'medium' | 'high';
  
  notes?: string;
  createdAt: number;
  updatedAt: number;
  
  sweptAt?: number;
}

export type ViewId =
  | 'playground'
  | 'history'
  | 'imagehistory'
  | 'gallery'
  | 'dashboard'
  | 'imagestudio'
  | 'addons'
  | `addon:${string}`;
export type FontFamily = 'inter' | 'mono' | 'system';


export type ThemeMode = 'dark' | 'light' | 'mocha' | 'system';

export type Accent = 'ember' | 'sakura' | 'matcha' | 'ocean' | 'violet';

export type Density = 'comfy' | 'compact';


export type ImageSizeMode = 'off' | 'ratio' | 'pixels';
