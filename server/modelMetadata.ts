

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

type MetadataMap = Record<string, ModelMeta>;

let cache: MetadataMap | null = null;

function load(): MetadataMap {
  if (cache) return cache;
  cache = {};
  try {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'modelMetadata.snapshot.json',
    );
    cache = JSON.parse(readFileSync(file, 'utf8')) as MetadataMap;
  } catch {
  }
  return cache ?? {};
}

const memo = new Map<string, ModelMeta | undefined>();


export function lookupModelMetadata(modelId: string): ModelMeta | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  if (memo.has(wanted)) return memo.get(wanted);

  const map = load();
  let result: ModelMeta | undefined = map[wanted] ?? matchCatalogEntry(Object.entries(map), wanted);

  if (!result) {
    const bare = bareModelPart(wanted);
    const index = bareNameIndex();
    const core = coreModelName(bare, (name) => index.has(name));
    if (core !== bare) result = index.get(core);
  }

  if (!result) {
    for (const [key, meta] of Object.entries(LOCAL_OVERRIDES)) {
      if (wanted === key || wanted.endsWith(`/${key}`)) {
        result = meta;
        break;
      }
    }
  }

  memo.set(wanted, result);
  return result;
}


export function lookupExactProviderModel(
  providerId: string,
  modelId: string,
): ModelMeta | undefined {
  const map = load();
  const wanted = `${providerId.trim()}/${modelId.trim()}`.toLowerCase();
  if (!wanted || wanted === '/') return undefined;
  const direct = map[wanted];
  if (direct) return direct;
  const wantExact = stripVariantSuffix(wanted);
  for (const [key, meta] of Object.entries(map)) {
    if (stripVariantSuffix(key.toLowerCase()) === wantExact) return meta;
  }
  return undefined;
}


let cataloguedProviders: Set<string> | null = null;

export function isCataloguedProvider(providerId: string): boolean {
  const wanted = providerId.trim().toLowerCase();
  if (!wanted) return false;
  if (!cataloguedProviders) {
    cataloguedProviders = new Set<string>();
    for (const key of Object.keys(load())) {
      const slash = key.indexOf('/');
      if (slash > 0) cataloguedProviders.add(key.slice(0, slash).toLowerCase());
    }
  }
  return cataloguedProviders.has(wanted);
}


const wideEfforts = new Map<string, string[] | null>();


const CAPABILITY_TOKENS = new Set([
  'vl', 'vision', 'image', 'omni', 'multimodal',
  'audio', 'video', 'pdf', 'tts', 'transcribe',
  'base', 'it', 'latest',
]);


const MIN_CORE_TOKENS = 2;


function modelTokens(id: string): string[] {
  return id
    .split(/[^a-z0-9.]+/i)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}


function coreModelName(bare: string, known: (name: string) => boolean): string {
  if (known(bare)) return bare;
  const tokens = modelTokens(bare);
  for (let size = tokens.length - 1; size >= MIN_CORE_TOKENS; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const dropped = tokens.filter((_, index) => index < start || index >= start + size);
      if (dropped.some((token) => CAPABILITY_TOKENS.has(token))) continue;
      const candidate = tokens.slice(start, start + size).join('-');
      if (known(candidate)) return candidate;
    }
  }
  return bare;
}


let bareIndex: Map<string, ModelMeta> | null = null;

function bareNameIndex(): Map<string, ModelMeta> {
  if (bareIndex) return bareIndex;
  bareIndex = new Map();
  for (const [key, meta] of Object.entries(load())) {
    const bare = bareModelPart(key.toLowerCase());
    if (!bareIndex.has(bare)) bareIndex.set(bare, meta);
  }
  return bareIndex;
}

export function modelWideEfforts(modelId: string): string[] | null {
  const wanted = bareModelPart(modelId.trim().toLowerCase());
  if (!wanted) return null;
  const cached = wideEfforts.get(wanted);
  if (cached !== undefined) return cached;

  const core = coreModelName(wanted, (name) => bareNameIndex().has(name));
  const union = new Set<string>();
  for (const [key, meta] of Object.entries(load())) {
    if (bareModelPart(key.toLowerCase()) !== core) continue;
    if (meta.reasoning !== true) continue;
    for (const value of meta.efforts ?? []) union.add(String(value).trim().toLowerCase());
  }
  const result = union.size > 0 ? [...union] : null;
  wideEfforts.set(wanted, result);
  return result;
}


export function matchCatalogEntry(
  entries: Array<[string, ModelMeta]>,
  wanted: string,
): ModelMeta | undefined {
  const wantExact = stripVariantSuffix(wanted);
  const wantBare = bareModelPart(wanted);
  let bareResult: ModelMeta | undefined;

  for (const [key, meta] of entries) {
    const lowerKey = key.toLowerCase();
    if (stripVariantSuffix(lowerKey) === wantExact) return meta;
    if (!bareResult && bareModelPart(lowerKey) === wantBare) bareResult = meta;
  }

  return bareResult;
}


function stripVariantSuffix(id: string): string {
  const slash = id.lastIndexOf('/');
  if (slash < 0) return id;
  const colon = id.indexOf(':', slash);
  return colon >= 0 ? id.slice(0, colon) : id;
}


function bareModelPart(id: string): string {
  const model = id.slice(id.lastIndexOf('/') + 1);
  const colon = model.indexOf(':');
  return colon >= 0 ? model.slice(0, colon) : model;
}


const LOCAL_OVERRIDES: MetadataMap = {
  // Atria Dawn Preview: research/coding/agent model, 256K context, 65,536
  'atria-dawn-preview': {
    reasoning: true,
    efforts: ['low', 'medium', 'high'],
    tools: true,
    attachment: true,
    imageIn: false,
    imageOut: false,
    videoIn: false,
    audioIn: false,
    pdfIn: false,
    context: 256_000,
    maxOut: 65_536,
  },
};

export function allModelMetadata(): MetadataMap {
  return load();
}


export function minLimit(
  modelContext: number | null,
  manualCap: number | null,
): number | null {
  if (modelContext && manualCap) return Math.min(modelContext, manualCap);
  return modelContext ?? manualCap;
}
