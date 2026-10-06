import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProviderKind, ProviderPublic } from './contracts.js';

/**
 * Built-in provider catalogue.
 *
 * OpenAI is the chat workhorse; Civitai ships as an image-only built-in
 * built-ins (their base URLs do not speak `/chat/completions`, so they appear
 * in Image Studio only). The user supplies the API key from the UI — it is
 * stored per built-in id (see `ProviderStore.setBuiltInKey`); an env var
 * override is also honored for headless setups. Anything else the user adds
 * as a custom provider (stored in `.data`): any OpenAI-compatible vendor via
 * `kind: 'openai'`, while `gemini` / `anthropic` keep their own adapters.
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
    id: 'civitai',
    label: 'Civitai',
    kind: 'openai',
    baseUrl: 'https://orchestration.civitai.com',
    envKey: 'CIVITAI_API_KEY',
    envBaseUrl: 'CIVITAI_BASE_URL',
    models: ['flux2-klein-4b', 'flux2-klein-9b', 'flux2-dev'],
    imageAdapter: 'civitai-orchestration',
    docsUrl: 'https://developer.civitai.com/orchestration/guide/getting-started',
    note:
      'Image generation via the Orchestration API (Buzz billing). ' +
      'Get a key: civitai.com → Account settings → API Keys → Add API key. ' +
      'civitai.red users: the same key works.',
  },
];

export function findBuiltIn(id: string): ProviderDefinition | undefined {
  return BUILT_IN_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Community checkpoints synced from the PUBLIC Civitai Site API
 * (`sync:civitai-models` → server/civitaiModels.snapshot.json). Each id is
 * an AIR URN the `civitai-orchestration` adapter sends as the imageGen
 * `model`; the label is what the model picker displays. A stale or missing
 * snapshot degrades silently to the curated flux2 engines.
 */
interface CivitaiSnapshotModel {
  id: string;
  label: string;
}

let civitaiSnapshot: CivitaiSnapshotModel[] = [];
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(path.join(here, 'civitaiModels.snapshot.json'), 'utf8');
  const parsed = JSON.parse(raw) as { models?: CivitaiSnapshotModel[] };
  civitaiSnapshot = Array.isArray(parsed.models) ? parsed.models : [];
} catch {
  civitaiSnapshot = [];
}

/** AIR-URN model ids surfaced in the picker (curated flux2 engines come first). */
export const CIVITAI_MODEL_IDS: string[] = [
  ...BUILT_IN_PROVIDERS.find((p) => p.id === 'civitai')?.models ?? [],
  ...civitaiSnapshot.map((entry) => entry.id),
];

/** Friendly picker labels for the synced checkpoints. */
export const CIVITAI_MODEL_LABELS: Record<string, string> = Object.fromEntries(
  civitaiSnapshot.map((entry) => [entry.id, entry.label]),
);

const civitaiDefinition = BUILT_IN_PROVIDERS.find((provider) => provider.id === 'civitai');
if (civitaiDefinition) civitaiDefinition.models = CIVITAI_MODEL_IDS;

export function isProviderKind(value: unknown): value is ProviderKind {
  return value === 'openai' || value === 'gemini' || value === 'anthropic';
}
