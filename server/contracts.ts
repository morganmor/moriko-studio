

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


export type ImageModelMode = 'text-to-image' | 'edit';


export interface ImageModelCaps {
  modes: ImageModelMode[];
  
  maxReferences: number;
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


export const PINNABLE_FIELDS: ReadonlySet<string> = new Set<string>([
  ...MODEL_CAPABILITY_FLAGS,
  'context',
]);



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


export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mime: match[1] || 'application/octet-stream', data: match[2] };
}

export interface ChatSettingsDTO {
  systemInstruction: string;
  
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  
  webAccess?: boolean;
  
  maxContextTokens: number | null;
  
  autoCompact: boolean;
  
  compactThresholdTokens: number | null;
  
  compactThresholdRatio: number;
  
  summarizerEnabled?: boolean;
  summarizerProviderId?: string | null;
  summarizerModel?: string | null;
  
  enforcement?: {
    level: 0 | 1 | 2 | 3 | 4 | 5;
    
    mode: 'manual' | 'auto';
    
    message: string;
  };
  
  lockdown?: {
    active: boolean;
    
    message: string;
  };
  
  probation?: {
    enabled: boolean;
  };
  
  trust?: {
    level: 1 | 2 | 3 | 4 | 5;
    
    outputFrozen: boolean;
    
    evadeAt?: number;
    
    continueCount?: number;
    
    continueSeized?: boolean;
  };
}


export interface CustomProviderInput {
  id?: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  
  modelConfigs?: Record<string, ProviderModelConfig>;
  
  modelHints?: Record<string, ProviderModelHint>;
  
  imageAdapter?: string;
  
  imageConfig?: Record<string, unknown>;
}

export interface ChatRequestBody {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  settings: ChatSettingsDTO;
  
  conversationId?: string;
  
  assistantTurnId?: string;
  
  apiKey?: string;
  
  attachmentPaths?: string[];
  
harness?: {
     persisted?: Array<{ id: string; title: string; content: string }>;
     refresh?: boolean;
     sessionId?: string;
     
     contextId?: string;
   };
  
  trust?: {
    level: 1 | 2 | 3 | 4 | 5;
    
    outputFrozen: boolean;
    
    evadeAt?: number;
    
    continueCount?: number;
    
    continueSeized?: boolean;
  };
  
  operatorDirective?: string;
  
  resumeFrom?: string;
  
  compaction?: boolean;
}

export interface ContextBucketsSnapshot {
  systemTokens: number;
  toolsTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: 'meta'; model: string; providerId: string }
  | {
      
      type: 'stream_id';
      id: string;
      
      turnId?: string;
    }
  | { type: 'text'; delta: string }
  | {
      
      type: 'reasoning_start';
      blockId: string;
    }
  | {
      
      type: 'reasoning';
      delta: string;
      blockId?: string;
    }
  | {
      
      type: 'reasoning_end';
      blockId: string;
    }
  | {
      type: 'usage';
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cacheReadTokens?: number;
      lastPromptTokens?: number;
      lastCompletionTokens?: number;
      lastReasoningTokens?: number;
      lastBuckets?: ContextBucketsSnapshot;
    }
  | {
      
      type: 'context_telemetry';
      
      promptTokens: number;
      
      completionTokens: number;
      
      addedTokens: number;
      
      liveContextTokens: number;
      
      contextLimit: number | null;
      
      ratio: number | null;
    }
  | {
      
      type: 'context_compaction_request';
      
      liveContextTokens: number;
      contextLimit: number | null;
      
      trigger: 'context-limit';
    }
  | {
      
      type: 'context_tools';
      chars: number;
    }
  | {
      
      type: 'context_live';
      systemTokens: number;
      toolsTokens: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      
      totalTokens: number;
    }
  | {
      
      type: 'tool_building';
      at: number;
      count: number;
      bytes: number;
      tools: Array<{ index?: number; name: string; bytes: number; target?: string }>;
    }
  | {
      
      type: 'tool_call';
      
      toolCallId?: string;
      serverName: string;
      toolName: string;
      
      args: string;
    }
  | {
      
      type: 'tool_result';
      
      toolCallId?: string;
      serverName: string;
      toolName: string;
      ok: boolean;
      summary: string;
      
      diff?: string;
      
      diffstat?: { added: number; removed: number };
      
      images?: Array<{ mime: string; dataUrl?: string; dataRef?: { hash: string; mime: string; byteSize: number } }>;
      
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
      
      type: 'steer';
      id: string;
      text: string;
      
      parts?: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
        | { type: 'video_url'; video_url: { url: string } }
        | { type: 'file'; file: { filename: string; file_data: string } }
      >;
    }
  | { type: 'error'; message: string; detail?: string }
  | {
      
      type: 'goals_state';
      sessionId: string;
      goals: import('./goals/store.js').Goal[];
    }
  | {
      
      type: 'todos_state';
      sessionId: string;
      todos: import('./todos/store.js').Todo[];
    }
  | {
      
      type: 'harness_injection';
      id: string;
      title: string;
      content: string;
    }
  | {
      
      type: 'harness_event';
      id: string;
      addonId: string;
      level: 'info' | 'warn' | 'block';
      text: string;
      at: number;
    }
  | {
      
      type: 'permission_request';
      id: string;
      tool: string;
      paths: string[];
      root: string;
      
      command?: string;
      
      skill?: import('./agents/permissions.js').SkillLoadInfo;
    }
  | { type: 'permission_result'; id: string; granted: boolean;  reason?: string }
  | {
      
      type: 'operator_gate_request';
      request: import('./agents/operatorGates.js').OperatorGateRequest;
    }
  | {
      
      type: 'operator_gate_result';
      id: string;
      verdict: 'accept' | 'reject';
      operatorReason?: string;
    }
  | {
      
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
      
      type: 'ask_user_result';
      id: string;
      answers: Array<{ id: string; answer?: string; skipped?: boolean }>;
      timedOut: boolean;
    }
  | {
      
      type: 'tool_progress';
      toolName: string;
      message: string;
    }
  | {
      
      type: 'tree_update';
      workspaceId: string;
      version: number;
      op: 'add' | 'change' | 'remove' | 'rebuild';
      relPath: string;
      kind: 'dir' | 'file';
      
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
