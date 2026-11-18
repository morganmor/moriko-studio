import type { ProviderKind, ProviderPublic } from './contracts.js';


export interface ProviderDefinition extends Omit<ProviderPublic, 'hasServerKey' | 'userSuppliedKey' | 'builtIn'> {
  
  envKey?: string;
  
  envBaseUrl?: string;
  
  keyOptional?: boolean;
}

export const BUILT_IN_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    envBaseUrl: 'OPENAI_BASE_URL',
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'],
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    note: 'Chat Completions API. Reasoning models accept a reasoning_effort hint.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GEMINI_API_KEY',
    envBaseUrl: 'GEMINI_BASE_URL',
    models: [
      'gemini-4-argon',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3.1-flash-image',
      'gemini-2.5-flash-image',
    ],
    imageAdapter: 'gemini-native',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    note:
      'Native generateContent API. Tools are declared with parametersJsonSchema (full JSON ' +
      'Schema); Gemini 3+ takes thinkingLevel, 2.5 takes thinkingBudget. ' +
      'Image models (Nano Banana) generate and edit images here too.',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    kind: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    envBaseUrl: 'MISTRAL_BASE_URL',
    models: [],
    docsUrl: 'https://docs.mistral.ai/',
    note:
      'Own adapter. Reasoning replays inside content chunk lists (ThinkChunk/TextChunk) — ' +
      'Mistral rejects `reasoning_content` with HTTP 422. reasoning_effort is a root-level parameter. ' +
      'Use “Fetch from provider” to load your model list.',
  },
  {
    id: 'comfyui',
    label: 'ComfyUI (Local)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:8188',
    keyOptional: true,
    models: [],
    imageAdapter: 'comfyui-local',
    docsUrl: 'https://docs.comfy.org/development/comfyui-server/comms_routes',
    note:
      'Local image generation via ComfyUI workflow API. No API key needed — ' +
      'just install ComfyUI and start the server (default: http://127.0.0.1:8188). ' +
      'Models are auto-discovered from your checkpoints, diffusion_models, and unet folders. ' +
      'Supports text-to-image and image-to-image for both checkpoint and diffusion models.',
  },
];

export function findBuiltIn(id: string): ProviderDefinition | undefined {
  return BUILT_IN_PROVIDERS.find((provider) => provider.id === id);
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return (
    value === 'openai' ||
    value === 'gemini' ||
    value === 'anthropic' ||
    value === 'mistral'
  );
}
