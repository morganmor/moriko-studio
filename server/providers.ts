import type { ProviderKind, ProviderPublic } from './contracts.js';

/**
 * Built-in provider catalogue.
 *
 * OpenAI is the chat workhorse. The user supplies the API key from the UI —
 * it is stored per built-in id (see `ProviderStore.setBuiltInKey`); an env
 * var override is also honored for headless setups. Anything else the user
 * adds as a custom provider (stored in `.data`): any OpenAI-compatible vendor
 * via `kind: 'openai'`, while `gemini` / `anthropic` keep their own adapters.
 */
export interface ProviderDefinition extends Omit<ProviderPublic, 'hasServerKey' | 'userSuppliedKey' | 'builtIn'> {
  /** Environment variable holding the credential, if any. */
  envKey?: string;
  /** Environment variable overriding the base URL. */
  envBaseUrl?: string;
  /** True when the provider works without a credential (local runtimes). */
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
  return value === 'openai' || value === 'gemini' || value === 'anthropic';
}
