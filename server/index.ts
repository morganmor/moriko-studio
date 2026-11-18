import 'dotenv/config';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteJson } from './atomicWrite.js';
import compression from 'compression';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';

import { streamAnthropic } from './adapters/anthropic.js';
import { streamGemini } from './adapters/gemini.js';
import { streamMistral } from './adapters/mistral.js';
import { streamOpenAiCompatible } from './adapters/openai.js';
import { agentRouter } from './agents/routes.js';
import { attachBrowserPanelWs } from './agents/browser/ws.js';
import { beginStream, endStream } from './agents/reload.js';
import { syncSessionContext } from './agents/read-policy.js';
import { goalsRouter } from './goals/routes.js';
import { todosRouter } from './todos/routes.js';
import { remindersRouter } from './reminders/routes.js';
import { workflowsRouter } from './workflows/routes.js';
import { skillsRouter } from './skills/routes.js';
import { planModeRouter } from './agents/planModeRoutes.js';
import { addonRouter } from './addons/routes.js';
import { watchRouter } from './watch/routes.js';
import { uiExportRouter } from './uiExport.js';
import { loadAllAddons, startAddonWatcher } from './addons/loader.js';
import { publishBusEvent } from './addons/bus.js';
import { aggregateUsage, dailyUsage, USAGE_WINDOWS } from './usageLedger.js';
import { listReminders, renderReminder, takeDueReminders } from './reminders/store.js';
import { getLiveCompactionConfig, setLiveCompactionConfig } from './compactionLiveConfig.js';
import { asyncRoute, HttpError } from './http.js';
import { guardedJsonParser } from './bodyParsers.js';
import { subscribeTree } from './agents/treeIndex.js';
import { buildHarnessInjections, ladderReminderInjection, operatorDirectiveInjection, agentHarnessInjection, agentsMdInjection, skillCommandFromText } from './agents/systemPrompt.js';
import { attachmentsInjection } from './agents/systemPrompt.js';
import { jobStore, withRun } from './agents/journal.js';
import {
  imageCapabilitiesOrNull,
  loadImageTasksFromDisk,
  localImageExists,
  localImageName,
  logImageTask,
  pollImageTaskOnce,
  readGallery,
  submitImageTask,
  writeGallery,
} from './images/runtime.js';
import { ImageAdapterError } from './adapters/images/types.js';
import type {
  ChatRequestBody,
  CustomProviderInput,
  ProviderKind,
  ChatSettingsDTO,
  ProviderPublic,
  StreamEvent,
} from './contracts.js';
import { augmentWithWebContent } from './webFetch.js';
import { appendDeviceContext } from './deviceContext.js';
import { collectAttachmentInputs, persistAttachments } from './attachments.js';
import {
  capWireImages,
  putBytes,
  readStoredWithMime,
  resolveWireRefs,
} from './attachmentStore.js';
import { getUiState, patchUiState } from './uiState.js';
import { getStorageLocation, setStorageLocation } from './storageLocation.js';
import {
  applyTurnPatches,
  emptyTrash,
  getStoredConversation,
  listStoredConversationSummaries,
  listTrash,
  patchConversationConfig,
  restoreFromTrash,
  summarizeConversation,
  syncStoredConversations,
  type StoredConversation,
} from './conversationStore.js';
import {
  abortStream,
  attachStream,
  createStream,
  detachStream,
  finishStream,
  listLiveStreams,
  probeStream,
  publishFrame,
  rehydrateRuns,
  resumeStream,
} from './streamRegistry.js';
import { startTurnMirror, type TurnMirrorHandle } from './turnMirror.js';
import { startStallSweeper } from './streamRegistry.js';
import {
  dropConnection,
  ensureConnection,
  listServersMasked,
  shutdownAll,
  testServer,
} from './mcp/manager.js';
import {
  getServer,
  getServerMasked,
  listServers,
  removeServer,
  upsertServer,
} from './mcp/config.js';
import { bridgeRouter } from './mcp/bridgeRoutes.js';
import { bridgeToken, resolveMainSessionId } from './mcp/bridge.js';
import { figmaAuthReset, figmaAuthStatus, figmaSignIn } from './mcp/figmaAuth.js';
import {
  BUILT_IN_PROVIDERS,
  findBuiltIn,
  isProviderKind,
} from './providers.js';
import { allModelMetadata, lookupModelMetadata } from './modelMetadata.js';
import {
  hintsFromListing,
  probeProviderModels,
} from './providerModels.js';
import { resolveModelCapability, type ResolvedModelCapability } from './modelCapability.js';
import { MODEL_CAPABILITY_FLAGS, PINNABLE_FIELDS, type ProviderModelConfig, type ProviderModelHint } from './contracts.js';
import { UpstreamError, type StreamHandler, type StreamParams } from './sse.js';
import { isLivenessTimeout, isAbortLike, STREAM_IDLE_MS } from './liveness.js';
import { isSteerable, pushSteer, registerSteerSession, unregisterSteerSession, type SteerEntry, type SteerPart } from './steer.js';
import { markSessionOpen, markSessionClose } from './agents/sessionRegistry.js';
import { SYSTEM_RULES_PRESETS } from './agents/writingRules.js';
import { providerStore as store } from './store.js';
import { resolveCredentials as resolveSharedCredentials } from './credentials.js';
import { startSweepTimer, touchSession } from './sessionLease.js';
import { getVisionConfig, setVisionConfig, type VisionConfig } from './visionConfig.js';
import { getActiveWorkspace } from './agents/workspace.js';
import {
  imageSessionsFile,
  imagesDir,
  morikoHomeDisplay,
  migrateLegacyLayout,
  morikoHome,
  settingsFile,
} from './paths.js';

migrateLegacyLayout();

const PORT = Number(process.env.PORT ?? 8826);

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  }),
);
app.use(
  compression({
    
    filter: (req, res) => {
      const type = res.getHeader('Content-Type');
      if (typeof type === 'string' && type.includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }),
);
app.use(guardedJsonParser());


function resolveBuiltIn(providerId: string): ProviderPublic {
  const definition = findBuiltIn(providerId);
  if (!definition) throw new HttpError(404, `Unknown provider "${providerId}".`);

  const credential = definition.envKey ? process.env[definition.envKey] : undefined;
  const baseUrl = (definition.envBaseUrl && process.env[definition.envBaseUrl]) || definition.baseUrl;

  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    baseUrl,
    models: definition.models,
    hasServerKey: Boolean(credential) || Boolean(definition.keyOptional),
    userSuppliedKey: false,
    builtIn: true,
    docsUrl: definition.docsUrl,
    note: definition.note,
  };
}




async function listProviders(): Promise<ProviderPublic[]> {
  const custom = await store.list();
  const customPublic: ProviderPublic[] = await Promise.all(
    custom.map(async (provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      models: provider.models,
      modelConfigs: provider.modelConfigs,
      modelHints: provider.modelHints,
      hasServerKey: Boolean(await store.getKey(provider.id)),
      userSuppliedKey: Boolean(await store.getKey(provider.id)),
      builtIn: false,
      imageCapabilities: imageCapabilitiesOrNull(
        { imageAdapter: provider.imageAdapter, imageConfig: provider.imageConfig },
        provider.baseUrl,
        provider.models,
      ),
      imageAdapter: provider.imageAdapter,
      imageConfig: provider.imageConfig,
    })),
  );

  return [
    ...(await Promise.all(
      BUILT_IN_PROVIDERS.map(async (definition) => {
        const resolved = resolveBuiltIn(definition.id);
        const envKey = definition.envKey ? process.env[definition.envKey] : undefined;
        const storedKey = await store.getBuiltInKey(definition.id);
        const userModels = await store.getBuiltInModels(definition.id);
        const liveModels = await store.getBuiltInLiveModels(definition.id);
        const modelConfigs = await store.getBuiltInModelConfigs(definition.id);
        const modelHints = await store.getBuiltInModelHints(definition.id);
        const catalogue = liveModels.length > 0
          ? [...liveModels, ...userModels]
          : [...resolved.models, ...userModels];
        return {
          ...resolved,
          models: catalogue,
          modelConfigs: Object.keys(modelConfigs).length > 0 ? modelConfigs : undefined,
          modelHints: Object.keys(modelHints).length > 0 ? modelHints : undefined,
          hasServerKey: Boolean(envKey) || Boolean(storedKey) || resolved.hasServerKey,
          userSuppliedKey: !envKey && Boolean(storedKey),
          imageCapabilities: imageCapabilitiesOrNull(
            definition.imageAdapter ? { imageAdapter: definition.imageAdapter } : undefined,
            resolved.baseUrl,
            catalogue,
          ),
        };
      }),
    )),
    ...customPublic,
  ];
}


async function resolveCapabilityFor(
  providerId: string,
  modelId: string,
): Promise<ResolvedModelCapability> {
  const builtIn = findBuiltIn(providerId);
  if (builtIn) {
    const [configs, hints] = await Promise.all([
      store.getBuiltInModelConfigs(providerId),
      store.getBuiltInModelHints(providerId),
    ]);
    return resolveModelCapability(
      modelId,
      configs[modelId],
      hints[modelId],
      lookupModelMetadata(modelId),
    );
  }

  const custom = await store.get(providerId);
  return resolveModelCapability(
    modelId,
    custom?.modelConfigs?.[modelId],
    custom?.modelHints?.[modelId],
    lookupModelMetadata(modelId),
  );
}


async function resolveCredentials(
  providerId: string,
  browserKey?: string,
): Promise<{ label: string; kind: ProviderKind; baseUrl: string; apiKey?: string }> {
  try {
    return await resolveSharedCredentials(store, providerId, browserKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Credential resolution failed.';
    throw new HttpError(400, message);
  }
}


app.get('/api/model-metadata', (_req, res) => {
  res.json(allModelMetadata());
});


app.get('/api/health', (_req, res) => {
  res.json({ ok: true, providers: BUILT_IN_PROVIDERS.length, uptime: process.uptime() });
});

app.get(
  '/api/providers',
  asyncRoute(async (_req, res) => {
    res.json({ providers: await listProviders() });
  }),
);

app.post(
  '/api/providers',
  asyncRoute(async (req, res) => {
    const input = req.body as CustomProviderInput;

    if (!input?.label?.trim()) throw new HttpError(400, 'A provider label is required.');
    if (!input?.baseUrl?.trim()) throw new HttpError(400, 'A base URL is required.');
    if (!isProviderKind(input.kind)) {
      throw new HttpError(400, 'Provider kind must be "openai", "gemini", "anthropic", or "mistral".');
    }
    if (input.id && findBuiltIn(input.id)) {
      throw new HttpError(400, `"${input.id}" is a built-in provider id. Choose another id.`);
    }

    const saved = await store.upsert({
      id: input.id?.trim() || '',
      label: input.label.trim(),
      kind: input.kind,
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: input.apiKey === undefined ? undefined : input.apiKey.trim(),
      models: (input.models ?? []).map((model) => model.trim()).filter(Boolean),
      modelConfigs: input.modelConfigs,
      imageAdapter: input.imageAdapter?.trim() || undefined,
      imageConfig: input.imageConfig,
    });

    res.status(201).json({
      provider: {
        id: saved.id,
        label: saved.label,
        kind: saved.kind,
        baseUrl: saved.baseUrl,
        models: saved.models,
        modelConfigs: saved.modelConfigs,
        modelHints: saved.modelHints,
        hasServerKey: Boolean(await store.getKey(saved.id)),
        userSuppliedKey: Boolean(await store.getKey(saved.id)),
        builtIn: false,
        imageCapabilities: imageCapabilitiesOrNull(
          { imageAdapter: saved.imageAdapter, imageConfig: saved.imageConfig },
          saved.baseUrl,
          saved.models,
        ),
        imageAdapter: saved.imageAdapter,
        imageConfig: saved.imageConfig,
      } satisfies ProviderPublic,
    });
  }),
);

app.delete(
  '/api/providers/:id',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    if (findBuiltIn(id)) throw new HttpError(400, 'Built-in providers cannot be deleted.');

    const removed = await store.remove(id);
    if (!removed) throw new HttpError(404, `Unknown provider "${id}".`);
    res.status(204).end();
  }),
);


app.put(
  '/api/providers/builtins/:id/key',
  asyncRoute(async (req, res) => {
    const builtIn = findBuiltIn(req.params.id);
    if (!builtIn) throw new HttpError(404, `Unknown built-in provider "${req.params.id}".`);

    const input = req.body as {
      apiKey?: string;
      addModels?: string[];
      removeModels?: string[];
      
      setModels?: string[];
      
      modelHints?: Record<string, ProviderModelHint>;
    };

    if (typeof input?.apiKey === 'string') {
      await store.setBuiltInKey(
        builtIn.id,
        input.apiKey.trim(),
        (builtIn.envBaseUrl && process.env[builtIn.envBaseUrl]) || builtIn.baseUrl,
      );
    }
    if (Array.isArray(input?.setModels)) {
      await store.setBuiltInLiveModels(builtIn.id, input.setModels);
    }
    if (input?.modelHints && typeof input.modelHints === 'object') {
      await store.mergeBuiltInModelHints(builtIn.id, input.modelHints);
    }
    let userModels = await store.getBuiltInModels(builtIn.id);
    if (Array.isArray(input?.addModels)) {
      const additions = input.addModels.map((model) => model.trim()).filter(Boolean);
      userModels = [...new Set([...userModels, ...additions])];
      await store.setBuiltInModels(builtIn.id, userModels);
    }
    if (Array.isArray(input?.removeModels)) {
      const removals = new Set(input.removeModels.map((model) => model.trim()));
      userModels = userModels.filter((model) => !removals.has(model));
      await store.setBuiltInModels(builtIn.id, userModels);
    }

    const envKey = builtIn.envKey ? process.env[builtIn.envKey] : undefined;
    const stored = await store.getBuiltInKey(builtIn.id);
    userModels = await store.getBuiltInModels(builtIn.id);
    const liveModels = await store.getBuiltInLiveModels(builtIn.id);
    res.json({
      ok: true,
      hasServerKey: Boolean(envKey) || Boolean(stored),
      userSuppliedKey: !envKey && Boolean(stored),
      models: liveModels.length > 0
        ? [...liveModels, ...userModels]
        : [...builtIn.models, ...userModels],
      userModels,
      liveModels,
      modelHints: await store.getBuiltInModelHints(builtIn.id),
    });
  }),
);


async function probeComfyuiModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const models: string[] = [];
  const folders = ['checkpoints', 'diffusion_models', 'unet'] as const;
  for (const folder of folders) {
    try {
      const res = await fetch(`${base}/models/${folder}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const files = (await res.json()) as string[];
      if (!Array.isArray(files)) continue;
      const tag = folder === 'checkpoints' ? 'ckpt' : folder === 'diffusion_models' ? 'diff' : 'unet';
      for (const f of files) if (f) models.push(`${tag}:${f}`);
    } catch {  }
  }
  return models;
}


async function isComfyui(baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { system?: unknown };
    return Boolean(data.system);
  } catch { return false; }
}


function modelListPayload(probe: Awaited<ReturnType<typeof probeProviderModels>>) {
  const textModels = probe.entries.map((entry) => entry.id);
  return {
    models: [...new Set([...textModels, ...probe.imageModels])],
    entries: probe.entries,
    hints: hintsFromListing(probe),
    family: probe.family,
  };
}


function sanitizeConfigSubmission(
  submitted: Record<string, unknown>,
  existing: Record<string, ProviderModelConfig>,
  hints: Record<string, ProviderModelHint>,
): Record<string, ProviderModelConfig> {
  const next: Record<string, ProviderModelConfig> = {};
  for (const [id, raw] of Object.entries(submitted)) {
    const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!row) continue;

    const previous = existing[id];
    const incomingPinned = Array.isArray(row.pinned)
      ? row.pinned.filter((value): value is string => typeof value === 'string')
      : [];
    const pinned = [...new Set([...(previous?.pinned ?? []), ...incomingPinned])]
      .filter((field) => PINNABLE_FIELDS.has(field)) as ProviderModelConfig['pinned'];

    const flags: Record<string, boolean> = {};
    for (const field of MODEL_CAPABILITY_FLAGS) {
      flags[field] = row[field] === true;
    }

    const context =
      typeof row.context === 'number' && Number.isFinite(row.context) && row.context > 0
        ? Math.round(row.context)
        : null;

    const resolved = resolveModelCapability(
      id,
      {
        id,
        imageIn: flags.imageIn,
        audioIn: flags.audioIn,
        videoIn: flags.videoIn,
        pdfIn: flags.pdfIn,
        tools: flags.tools,
        reasoning: flags.reasoning,
        imageOut: flags.imageOut,
        context,
        maxOut: null,
        source: 'user',
        pinned,
      },
      hints[id],
      lookupModelMetadata(id),
    );

    next[id] = {
      id,
      imageIn: resolved.imageIn,
      audioIn: resolved.audioIn,
      videoIn: resolved.videoIn,
      pdfIn: resolved.pdfIn,
      tools: resolved.tools,
      reasoning: resolved.reasoning,
      imageOut: resolved.imageOut,
      context: resolved.context,
      maxOut: resolved.maxOut,
      source: resolved.source,
      pinned,
    };
  }
  return next;
}


app.get(
  '/api/providers/:id/models',
  asyncRoute(async (req, res) => {
    const credentials = await resolveCredentials(req.params.id);
    const base = credentials.baseUrl.replace(/\/+$/, '');

    if (await isComfyui(base)) {
      res.json({ models: await probeComfyuiModels(base), entries: [], hints: {}, family: 'opaque' });
      return;
    }

    const probe = await probeProviderModels({
      baseUrl: base,
      apiKey: credentials.apiKey,
      kind: credentials.kind,
    });

    const hints = hintsFromListing(probe);
    if (Object.keys(hints).length > 0) {
      const builtIn = findBuiltIn(req.params.id);
      if (builtIn) await store.mergeBuiltInModelHints(builtIn.id, hints);
      else await store.mergeModelHints(req.params.id, hints);
    }

    res.json(modelListPayload(probe));
  }),
);


app.post(
  '/api/providers/probe-models',
  asyncRoute(async (req, res) => {
    const body = req.body as { baseUrl?: unknown; apiKey?: unknown; kind?: unknown };
    if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
      throw new HttpError(400, 'A baseUrl is required to probe for models.');
    }
    const baseUrl = (body.baseUrl as string).replace(/\/+$/, '');
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    const kind: ProviderKind =
      body.kind === 'gemini'
        ? 'gemini'
        : body.kind === 'anthropic'
          ? 'anthropic'
          : body.kind === 'mistral'
            ? 'mistral'
            : 'openai';

    if (await isComfyui(baseUrl)) {
      res.json({ models: await probeComfyuiModels(baseUrl), entries: [], hints: {}, family: 'opaque' });
      return;
    }

    const probe = await probeProviderModels({ baseUrl, apiKey, kind });
    res.json(modelListPayload(probe));
  }),
);


app.put(
  '/api/providers/:id/model-configs',
  asyncRoute(async (req, res) => {
    const providerId = req.params.id;
    const body = req.body as { configs?: unknown };
    const raw = body?.configs;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'A "configs" object keyed by model id is required.');
    }

    const builtIn = findBuiltIn(providerId);
    const custom = builtIn ? undefined : await store.get(providerId);
    if (!builtIn && !custom) throw new HttpError(404, `Unknown provider "${providerId}".`);

    const existing = builtIn
      ? await store.getBuiltInModelConfigs(providerId)
      : (custom?.modelConfigs ?? {});
    const hints = builtIn
      ? await store.getBuiltInModelHints(providerId)
      : (custom?.modelHints ?? {});

    const configs = sanitizeConfigSubmission(
      raw as Record<string, unknown>,
      existing,
      hints,
    );

    if (builtIn) await store.setBuiltInModelConfigs(providerId, configs);
    else await store.setModelConfigs(providerId, configs);

    res.json({ ok: true, modelConfigs: configs });
  }),
);



app.post(
  '/api/chat',
  asyncRoute(async (req, res) => {
    const body = req.body as ChatRequestBody;

    beginStream();
    let slotReleased = false;
    const releaseSlot = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      endStream();
    };
    let handedOff = false;
    res.on('close', () => {
      if (!handedOff) releaseSlot();
    });

    if (!body?.providerId) throw new HttpError(400, 'providerId is required.');
    if (!body?.model) throw new HttpError(400, 'model is required.');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new HttpError(400, 'At least one message is required.');
    }

    const credentials = await resolveCredentials(body.providerId, body.apiKey);

    const sessionId = typeof body.conversationId === 'string' ? body.conversationId : null;
    const isCompactionRequest = body.compaction === true;
    const storedConversation = sessionId ? getStoredConversation(sessionId) : null;
    const storedSettings =
      storedConversation &&
      typeof storedConversation.settings === 'object' &&
      storedConversation.settings !== null
        ? (storedConversation.settings as Partial<ChatSettingsDTO>)
        : undefined;
    const liveCompaction = sessionId ? getLiveCompactionConfig(sessionId) : undefined;
    const liveCompactionOverrides: Partial<ChatSettingsDTO> = liveCompaction
      ? {
          autoCompact: liveCompaction.autoCompact,
          compactThresholdTokens: liveCompaction.compactThresholdTokens,
          ...(liveCompaction.compactThresholdRatio !== null
            ? { compactThresholdRatio: liveCompaction.compactThresholdRatio }
            : {}),
          maxContextTokens: liveCompaction.maxContextTokens,
        }
      : {};
    const authoritativeSettings: ChatSettingsDTO = {
      ...(body.settings ?? ({} as ChatSettingsDTO)),
      ...(storedSettings ?? {}),
      ...liveCompactionOverrides,
      ...(isCompactionRequest
        ? {
            ...(body.settings?.systemInstruction !== undefined
              ? { systemInstruction: body.settings.systemInstruction }
              : {}),
            thinkingLevel: body.settings?.thinkingLevel ?? 'off',
            temperature: body.settings?.temperature ?? 0.2,
            topP: body.settings?.topP ?? 0.9,
            structuredOutputs: body.settings?.structuredOutputs ?? false,
          }
        : {}),
    };

    const rawEnforcement = authoritativeSettings.enforcement;
    const legacyLockdown = authoritativeSettings.lockdown?.active === true;
    const enforcementLevel: 0 | 1 | 2 | 3 | 4 | 5 = legacyLockdown
      ? 4
      : rawEnforcement && typeof rawEnforcement.level === 'number'
        ? (Math.max(0, Math.min(5, rawEnforcement.level)) as 0 | 1 | 2 | 3 | 4 | 5)
        : 0;
    const inLockdown = enforcementLevel >= 4;
    const inFrozen = enforcementLevel >= 5 || body.trust?.outputFrozen === true;
    // into raw transcript imitation (the garbage checkpoint bug).
    const settings: ChatSettingsDTO = {
      ...authoritativeSettings,
      ...(enforcementLevel >= 1
        ? {
            ...(enforcementLevel >= 3
              ? { useMcp: false, agentMode: false, fetchWeb: false, webAccess: false }
              : enforcementLevel === 2
                ? { agentMode: false, fetchWeb: false, webAccess: false }
                : {}),
            ...(enforcementLevel >= 4 && !isCompactionRequest
              ? { structuredOutputs: false, systemInstruction: '' }
              : {}),
          }
        : {}),
      ...(inFrozen ? { trust: { ...(body.trust ?? { level: 5 }), outputFrozen: true } } : body.trust ? { trust: body.trust } : {}),
    };

    const steerSessionId =
      typeof body.harness?.sessionId === 'string' && body.harness.sessionId.trim()
        ? body.harness.sessionId.trim()
        : undefined;
    const legacyUrls = (settings as { urlContext?: unknown }).urlContext;
    const fetchEnabled =
      inLockdown === false &&
      settings.webAccess !== false &&
      (Boolean(settings.fetchWeb) || (typeof legacyUrls === 'string' && legacyUrls.trim().length > 0));
    const { browserManager } = await import('./agents/browser/manager.js');
    await browserManager.setWebAccess(
      inLockdown === false && settings.webAccess === true,
      steerSessionId ?? sessionId ?? undefined,
    );
    resolveWireRefs(body.messages);
    capWireImages(body.messages);
    const messages = appendDeviceContext(await augmentWithWebContent(body.messages ?? [], fetchEnabled));

    const controller = new AbortController();
    const streamId = crypto.randomUUID();
    const assistantTurnId =
      typeof body.assistantTurnId === 'string' && body.assistantTurnId.trim()
        ? body.assistantTurnId.trim()
        : `turn_${streamId.replace(/-/g, '').slice(0, 20)}`;

    if (steerSessionId) registerSteerSession(steerSessionId);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const registrySessionId = steerSessionId ?? undefined;
    if (registrySessionId) {
      try {
        markSessionOpen({
          sessionId: registrySessionId,
          conversationId: sessionId ?? undefined,
          workspacePath: getActiveWorkspace(registrySessionId)?.path,
          model: body.model,
        });
      } catch {  }
    }

    createStream(streamId, {
      abortUpstream: () => controller.abort(),
      onEnded: () => {
        releaseSlot();
        if (steerSessionId) unregisterSteerSession(steerSessionId);
        if (registrySessionId) markSessionClose(registrySessionId);
        unsubscribeTree?.();
      },
    }, { conversationId: sessionId });
    handedOff = true;

    jobStore.start({
      runId: streamId,
      sessionId: steerSessionId,
      providerId: body.providerId,
      model: body.model,
      agentMode: settings.agentMode === true,
      webAccess: settings.webAccess === true,
    });
    const resumedFrom =
      typeof body.resumeFrom === 'string' && body.resumeFrom.trim()
        ? body.resumeFrom.trim()
        : undefined;

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      detachStream(streamId, res);
    });
    attachStream(streamId, res);

    
    let lastFinishReason: string | undefined;
    const send: StreamHandler = (event: StreamEvent) => {
      if (event.type === 'done' && event.finishReason) lastFinishReason = event.finishReason;
      publishFrame(streamId, `data: ${JSON.stringify(event)}\n\n`);
      turnMirror?.apply(event);
    };
    let turnMirror: TurnMirrorHandle | null = null;

    const treeWorkspace = getActiveWorkspace(steerSessionId);
    const unsubscribeTree = treeWorkspace ? subscribeTree(treeWorkspace.id, (event) => {
      send({
        type: 'tree_update',
        workspaceId: event.workspaceId,
        version: event.version,
        op: event.op,
        relPath: event.relPath,
        kind: event.kind,
        node: event.node,
      });
    }) : null;

    send({ type: 'meta', model: body.model, providerId: body.providerId });
    // duplicate-reply-per-consumer bug dies with this single field.
    send({ type: 'stream_id', id: streamId, turnId: assistantTurnId });
    turnMirror = sessionId && !isCompactionRequest
      ? startTurnMirror({
          conversationId: sessionId,
          turnId: assistantTurnId,
          model: body.model,
          providerId: body.providerId,
          suppressText: inFrozen,
        })
      : null;

    if (sessionId) touchSession(sessionId);

    const attachmentPaths: string[] = [];
    {
      const attachmentSessionId =
        (typeof body.harness?.sessionId === 'string' && body.harness.sessionId) ||
        (typeof req.query.chatId === 'string' && req.query.chatId) ||
        '';
      if (Array.isArray(body.attachmentPaths)) {
        attachmentPaths.push(...body.attachmentPaths.filter((entry) => typeof entry === 'string' && entry.trim()));
      } else if (attachmentSessionId) {
        const incoming = collectAttachmentInputs(messages);
        const stored = await persistAttachments(attachmentSessionId, incoming);
        attachmentPaths.push(...stored.map((entry) => entry.absolutePath));
      }
    }

    
    const capability = await resolveCapabilityFor(body.providerId, body.model);

    const harnessSessionId = typeof body.harness?.sessionId === 'string' ? body.harness.sessionId : undefined;
    const harnessContextId =
      typeof body.harness?.contextId === 'string' && body.harness.contextId.trim()
        ? body.harness.contextId.trim()
        : undefined;
    if (harnessSessionId && harnessContextId) {
      syncSessionContext(harnessSessionId, harnessContextId);
    }
    const persisted = Array.isArray(body.harness?.persisted)
      ? body.harness.persisted.filter(
          (entry): entry is { id: string; title: string; content: string } =>
            typeof entry?.id === 'string' &&
            typeof entry?.title === 'string' &&
            typeof entry?.content === 'string',
        )
      : [];
    let harnessInjections: Awaited<ReturnType<typeof buildHarnessInjections>> = persisted;
    if (body.harness?.refresh) {
      const fresh = await buildHarnessInjections(
        settings,
        harnessSessionId,
        attachmentPaths,
        typeof body.model === 'string' ? body.model : undefined,
        body.trust && typeof body.trust.level === 'number' && body.trust.level >= 1 && body.trust.level <= 5 && settings.probation?.enabled
          ? {
              level: body.trust.level as 1 | 2 | 3 | 4 | 5,
              outputFrozen: body.trust.outputFrozen === true,
              evadeAt: typeof body.trust.evadeAt === 'number' ? body.trust.evadeAt : undefined,
            }
          : undefined,
        typeof body.operatorDirective === 'string' && body.operatorDirective.trim()
          ? body.operatorDirective
          : undefined,
        capability,
      );
      for (const injection of fresh) {
        send({
          type: 'harness_injection',
          id: injection.id,
          title: injection.title,
          content: injection.content,
        });
      }
      harnessInjections = fresh;
    } else if (harnessSessionId) {
      if (settings.agentMode) {
        const freshAgent = agentHarnessInjection(settings.terminalMode ?? 'auto', harnessSessionId, settings.webAccess === true);
        const oldAgent = harnessInjections.find((entry) => entry.id === 'agent-tools');
        if (freshAgent && (!oldAgent || oldAgent.content !== freshAgent.content)) {
          send({ type: 'harness_injection', id: freshAgent.id, title: freshAgent.title, content: freshAgent.content });
          harnessInjections = oldAgent
            ? harnessInjections.map((entry) => (entry.id === 'agent-tools' ? freshAgent : entry))
            : [...harnessInjections, freshAgent];
        } else if (!freshAgent && oldAgent) {
          const stub = {
            id: 'agent-tools',
            title: 'System prompt · Agent harness',
            content:
              'Agent mode is ON, but NO workspace is bound to THIS conversation. ' +
              'File/terminal tools are unavailable until the user picks a folder for this chat ' +
              '(the workspace pill in the composer). If file work is needed, ask the user to pick ' +
              'one; never guess paths or rely on a folder from another conversation.',
          };
          send({ type: 'harness_injection', id: stub.id, title: stub.title, content: stub.content });
          harnessInjections = harnessInjections.map((entry) => (entry.id === 'agent-tools' ? stub : entry));
        }
        const freshMd = agentsMdInjection(harnessSessionId);
        const oldMd = harnessInjections.find((entry) => entry.id === 'agents-md');
        if (freshMd && (!oldMd || oldMd.content !== freshMd.content)) {
          send({ type: 'harness_injection', id: freshMd.id, title: freshMd.title, content: freshMd.content });
          harnessInjections = oldMd
            ? harnessInjections.map((entry) => (entry.id === 'agents-md' ? freshMd : entry))
            : [...harnessInjections, freshMd];
        }
      }
      const attachments = settings.agentMode
        ? attachmentsInjection(
            attachmentPaths,
            typeof body.model === 'string' ? body.model : undefined,
            capability,
          )
        : null;
      if (attachments) {
        send({
          type: 'harness_injection',
          id: attachments.id,
          title: attachments.title,
          content: attachments.content,
        });
        harnessInjections = [...harnessInjections, attachments];
      }
      const due = takeDueReminders(harnessSessionId);
      if (due.length > 0) {
        const pending = listReminders(harnessSessionId, false).filter(
          (reminder) => !due.some((entry) => entry.id === reminder.id),
        );
        const block = {
          id: 'reminders',
          title: 'Context injection · Reminders',
          content: [
            'SCHEDULED REMINDERS became due since the last message — surface them to the user now and act on them if asked:',
            ...due.map((reminder) => `- ${renderReminder(reminder)}`),
            ...(pending.length
              ? ['', `Other pending reminders (not yet due):\n${pending.map(renderReminder).join('\n')}`]
              : []),
          ].join('\n'),
        };
        send({ type: 'harness_injection', id: block.id, title: block.title, content: block.content });
        harnessInjections = [...persisted, block];
      }

      if (typeof body.operatorDirective === 'string' && body.operatorDirective.trim()) {
        const directive = operatorDirectiveInjection(body.operatorDirective);
        send({ type: 'harness_injection', id: directive.id, title: directive.title, content: directive.content });
        harnessInjections = [...harnessInjections, directive];
      }

      {
        const firstUser = [...messages].reverse().find((message: { role?: string }) => message?.role === 'user');
        const userText = typeof (firstUser as { content?: unknown } | undefined)?.content === 'string'
          ? (firstUser as { content: string }).content
          : '';
        const skillCommand = settings.agentMode && userText ? skillCommandFromText(userText, harnessSessionId) : null;
        if (skillCommand && !harnessInjections.some((entry) => entry.id === 'skill-command')) {
          send({ type: 'harness_injection', id: skillCommand.id, title: skillCommand.title, content: skillCommand.content });
          harnessInjections = [...harnessInjections, skillCommand];
        }
      }
    }

    if (enforcementLevel > 0 || (body.trust && body.trust.level > 1 && settings.probation?.enabled)) {
      const reminder = ladderReminderInjection(
        enforcementLevel,
        settings.probation?.enabled && body.trust ? body.trust.level : undefined,
        body.trust?.outputFrozen === true,
      );
      const alreadyBuilt = harnessInjections.some((entry) => entry.id === reminder.id);
      if (!alreadyBuilt) {
        send({ type: 'harness_injection', id: reminder.id, title: reminder.title, content: reminder.content });
      }
      harnessInjections = [...harnessInjections.filter((entry) => entry.id !== reminder.id), reminder];
    }

    const params: StreamParams = {
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      model: body.model,
      messages,
      settings: settings,
      providerId: body.providerId,
      signal: controller.signal,
      harnessInjections,
      sessionId: harnessSessionId,
      attachmentPaths: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      contextLimit: capability.context,
      compactGuard: {
        conversationId: sessionId ?? undefined,
        autoCompact: settings.autoCompact !== false,
        compactThresholdTokens:
          typeof settings.compactThresholdTokens === 'number' && settings.compactThresholdTokens > 0
            ? settings.compactThresholdTokens
            : null,
        compactThresholdRatio:
          typeof settings.compactThresholdRatio === 'number' ? settings.compactThresholdRatio : 0.95,
        maxContextTokens:
          typeof settings.maxContextTokens === 'number' && settings.maxContextTokens > 0
            ? settings.maxContextTokens
            : null,
      },
      capability,
    };

    let failed = false;
    try {
      await withRun(streamId, resumedFrom, async () => {
        switch (credentials.kind) {
          case 'gemini':
            await streamGemini(params, send);
            break;
          case 'anthropic':
            await streamAnthropic(params, send);
            break;
          case 'mistral':
            await streamMistral(params, send);
            break;
          default:
            await streamOpenAiCompatible(params, send);
            break;
        }
      });
    } catch (error) {
      if (controller.signal.aborted) {
      } else if (error instanceof UpstreamError) {
        failed = true;
        const isConcurrency =
          error.status === 429 ||
          /concurrency|rate.?limit|too many (request|session)s?/i.test(error.message);
        if (isConcurrency) {
          const providerText = error.message;
          send({
            type: 'error',
            message: `${credentials.label} reported a concurrency limit.\nProvider: ${providerText}`,
            detail: error.detail ?? providerText,
          });
        } else {
          send({ type: 'error', message: error.message, detail: error.detail });
        }
      } else if (isLivenessTimeout(error, 'STREAM_IDLE')) {
        failed = true;
        send({
          type: 'error',
          message:
            `Stream stalled — no data received from the provider for ${STREAM_IDLE_MS / 1000}s. ` +
            'This is a transient provider issue (bursty token generation); the run can be continued.',
        });
      } else if (isAbortLike(error)) {
        failed = true;
        send({
          type: 'error',
          message:
            'Stream connection was interrupted by the provider or network. ' +
            'This is a transient issue; the run can be continued.',
        });
      } else {
        failed = true;
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unexpected provider error.',
        });
      }
    } finally {
      clearInterval(heartbeat);
      send({ type: 'done', finishReason: lastFinishReason });
      turnMirror?.flushFinal();
      finishStream(streamId);
      jobStore.end(streamId, controller.signal.aborted ? 'aborted' : failed ? 'error' : 'completed');
      if (!res.writableEnded) res.end();
    }
  }),
);



app.post(
  '/api/compaction/config',
  (req, res) => {
    const body = req.body as { conversationId?: unknown; config?: Record<string, unknown> };
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    const config = body?.config;
    if (!conversationId || !config || typeof config !== 'object') {
      res.status(400).json({ error: 'conversationId and config are required.' });
      return;
    }
    const normalized = {
      autoCompact: config.autoCompact !== false,
      compactThresholdTokens:
        typeof config.compactThresholdTokens === 'number' && config.compactThresholdTokens > 0
          ? config.compactThresholdTokens
          : null,
      compactThresholdRatio:
        typeof config.compactThresholdRatio === 'number' && Number.isFinite(config.compactThresholdRatio)
          ? config.compactThresholdRatio
          : null,
      maxContextTokens:
        typeof config.maxContextTokens === 'number' && config.maxContextTokens > 0
          ? config.maxContextTokens
          : null,
    };
    setLiveCompactionConfig(conversationId, normalized);
    patchConversationConfig(conversationId, {
      settings: {
        autoCompact: normalized.autoCompact,
        compactThresholdTokens: normalized.compactThresholdTokens,
        ...(normalized.compactThresholdRatio !== null
          ? { compactThresholdRatio: normalized.compactThresholdRatio }
          : {}),
        maxContextTokens: normalized.maxContextTokens,
      },
    });
    res.json({ ok: true });
  },
);

app.get(
  '/api/chat/live',
  (_req, res) => {
    res.json({ streams: listLiveStreams() });
  },
);


app.head(
  '/api/chat/resume/:id',
  (req, res) => {
    const state = probeStream(req.params.id);
    if (state === 'live' || state === 'done') {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(state === 'unresumable' ? 204 : 404);
    res.end();
  },
);

app.get(
  '/api/chat/resume/:id',
  (req, res) => {
    const state = probeStream(req.params.id);
    if (state === 'unknown') {
      res.status(404).json({ error: 'Unknown stream (expired or never existed).' });
      return;
    }
    if (state === 'unresumable') {
      res.status(410).json({ error: 'This stream outgrew its replay buffer.' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const outcome = resumeStream(req.params.id, res);
    if (outcome !== 'tailing') return;
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    res.on('close', () => clearInterval(beat));
  },
);


app.post(
  '/api/chat/stream/:id/abort',
  (req, res) => {
    res.json({ ok: abortStream(req.params.id) });
  },
);


app.post(
  '/api/chat/steer',
  asyncRoute(async (req, res) => {
    const body = req.body as { sessionId?: unknown; text?: unknown; preset?: unknown; parts?: unknown };
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';

    let parts: SteerPart[];
    if (Array.isArray(body?.parts)) {
      parts = [];
      for (const raw of body.parts.slice(0, 12)) {
        if (!raw || typeof raw !== 'object') continue;
        const part = raw as { type?: unknown; text?: unknown; image_url?: { url?: unknown }; video_url?: { url?: unknown }; file?: { filename?: unknown; file_data?: unknown } };
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url) {
          parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        } else if (part.type === 'video_url' && typeof part.video_url?.url === 'string' && part.video_url.url) {
          parts.push({ type: 'video_url', video_url: { url: part.video_url.url } });
        } else if (
          part.type === 'file' &&
          typeof part.file?.filename === 'string' &&
          typeof part.file?.file_data === 'string' &&
          part.file.file_data
        ) {
          parts.push({ type: 'file', file: { filename: part.file.filename.slice(0, 200), file_data: part.file.file_data } });
        }
      }
    } else {
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      parts = text ? [{ type: 'text', text }] : [];
    }

    if (typeof body?.preset === 'string' && body.preset) {
      const presetText = SYSTEM_RULES_PRESETS[body.preset];
      if (!presetText) throw new HttpError(400, `Unknown reminder preset "${body.preset}".`);
      parts = [{ type: 'text', text: presetText }];
    }

    if (!sessionId) throw new HttpError(400, 'sessionId is required.');
    if (parts.length === 0) throw new HttpError(400, 'Steer content is required (text, parts, or preset).');

    if (!isSteerable(sessionId)) {
      res.status(409).json({ ok: false, reason: 'not_streaming' });
      return;
    }

    const entry: SteerEntry = pushSteer(sessionId, parts);
    res.status(202).json({ ok: true, id: entry.id });
  }),
);





app.post(
  '/api/images/generations',
  asyncRoute(async (req, res) => {
    const body = req.body as {
      providerId?: string;
      model?: string;
      prompt?: string;
      apiKey?: string;
      width?: unknown;
      height?: unknown;
      aspectRatio?: unknown;
      images?: unknown;
    };
    try {
      const { taskId } = await submitImageTask({
        providerId: body.providerId ?? '',
        model: body.model ?? '',
        prompt: body.prompt ?? '',
        apiKey: body.apiKey,
        width: body.width,
        height: body.height,
        aspectRatio: body.aspectRatio,
        images: body.images,
      });
      res.status(202).json({ taskId });
    } catch (error) {
      if (error instanceof ImageAdapterError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
  }),
);



const IMAGES_DIR = imagesDir;
fs.mkdirSync(IMAGES_DIR, { recursive: true });

app.use('/api/images/local', express.static(IMAGES_DIR, { fallthrough: false }));

const ADDONS_DIR = path.join(morikoHome, 'addons');
app.use('/addon-modules', express.static(ADDONS_DIR, { fallthrough: false }));


app.get(
  '/api/images/local-list',
  asyncRoute(async (_req, res) => {
    const files = fs
      .readdirSync(IMAGES_DIR)
      .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
      .map((name) => {
        const stats = fs.statSync(path.join(IMAGES_DIR, name));
        return { name, mtime: stats.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => `/api/images/local/${entry.name}`);
    res.json({ images: files });
  }),
);


app.get(
  '/api/images/meta/:name',
  asyncRoute(async (req, res) => {
    const base = path.basename(String(req.params.name ?? '')).replace(/\.[^.]+$/, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(base)) throw new HttpError(400, 'Invalid image name.');
    try {
      res.json(JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, `${base}.json`), 'utf8')));
    } catch {
      throw new HttpError(404, 'No metadata saved for this image.');
    }
  }),
);


app.get(
  '/api/images/tasks/:taskId',
  asyncRoute(async (req, res) => {
    const { taskId } = req.params;
    let outcome;
    try {
      outcome = await pollImageTaskOnce(taskId);
    } catch (error) {
      if (error instanceof ImageAdapterError) throw new HttpError(error.status, error.message);
      throw error;
    }
    if (!outcome) {
      throw new HttpError(404, 'Unknown image task — it may have finished or the server restarted. Submit again.');
    }
    res.json({
      status: outcome.status,
      images: outcome.images,
      ...(outcome.note ? { note: outcome.note } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }),
);


app.get(
  '/api/images/file',
  asyncRoute(async (req, res) => {
    const url = String(req.query.url ?? '');
    if (!/^https?:\/\//.test(url)) throw new HttpError(400, 'A valid image URL is required.');

    const upstream = await fetch(url);
    if (!upstream.ok) throw new HttpError(upstream.status, 'Could not fetch the generated image.');

    const type = upstream.headers.get('content-type') ?? 'image/jpeg';
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="moriko-image.${type.includes('png') ? 'png' : 'jpg'}"`,
    );
    res.send(buffer);
  }),
);




app.get('/api/gallery', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ images: readGallery() });
});

app.post(
  '/api/gallery',
  asyncRoute(async (req, res) => {
    const body = req.body as { images?: unknown };
    if (!Array.isArray(body?.images)) throw new HttpError(400, 'images must be an array.');

    const images = body.images
      .filter((v): v is string => typeof v === 'string')
      .filter((v) => /^https?:\/\//.test(v) || v.startsWith('/api/images/local/'))
      .slice(0, 500);
    writeGallery(images);
    res.json({ images });
  }),
);



interface ImageSessionItem {
  url: string;
  taskId: string;
  prompt: string;
  model: string;
  provider: string;
  savedAt: string;
}

interface ImageSession {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  items: ImageSessionItem[];
}

const IMAGE_SESSIONS_FILE = imageSessionsFile;

function readImageSessions(): ImageSession[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(IMAGE_SESSIONS_FILE, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ImageSession =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as ImageSession).id === 'string' &&
        Array.isArray((entry as ImageSession).items),
    );
  } catch {
    return [];
  }
}

function writeImageSessions(sessions: ImageSession[]): void {
  atomicWriteJson(IMAGE_SESSIONS_FILE, sessions);
}



function pruneSessionItems(sessions: ImageSession[]): boolean {
  let changed = false;
  for (const session of sessions) {
    const kept = session.items.filter((item) => {
      const name = localImageName(item.url);
      return !name || localImageExists(name);
    });
    if (kept.length !== session.items.length) {
      session.items = kept;
      session.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}


interface ServerSettings {
  
  imageRetentionDays: number;
}

const SETTINGS_FILE = settingsFile;
const IMAGE_RETENTION_DEFAULT = 7;

function readServerSettings(): ServerSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<ServerSettings>;
    const days = Number(parsed.imageRetentionDays);
    if (Number.isFinite(days) && days >= 0 && days <= 365) {
      return { imageRetentionDays: Math.floor(days) };
    }
    return { imageRetentionDays: IMAGE_RETENTION_DEFAULT };
  } catch {
    return { imageRetentionDays: IMAGE_RETENTION_DEFAULT };
  }
}

function writeServerSettings(settings: ServerSettings): void {
  atomicWriteJson(SETTINGS_FILE, settings);
}


function sweepTemporaryImages(): number {
  const { imageRetentionDays } = readServerSettings();
  if (!Number.isFinite(imageRetentionDays) || imageRetentionDays <= 0) return 0;
  const cutoff = Date.now() - imageRetentionDays * 86_400_000;
  const galleryNames = new Set(
    readGallery()
      .map((url) => localImageName(url))
      .filter((name): name is string => name !== null),
  );
  let removed = 0;
  try {
    for (const name of fs.readdirSync(IMAGES_DIR)) {
      if (!/\.(jpg|jpeg|png|webp)$/i.test(name)) continue;
      if (galleryNames.has(name)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(IMAGES_DIR, name)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > cutoff) continue;
      fs.rmSync(path.join(IMAGES_DIR, name), { force: true });
      fs.rmSync(path.join(IMAGES_DIR, name.replace(/\.[^.]+$/, '.json')), { force: true });
      removed += 1;
    }
  } catch (error) {
    console.error('[images] sweep failed:', error);
    return removed;
  }
  if (removed > 0) {
    logImageTask({ kind: 'sweep', removed, retentionDays: imageRetentionDays });
    console.log(`[images] sweep: removed ${removed} temporary file(s) (>${imageRetentionDays}d)`);
  }
  return removed;
}

app.get('/api/settings', (_req, res) => {
  res.json(readServerSettings());
});


const readUiState = (_req: Request, res: Response): void => {
  res.json({ state: getUiState() });
};

const writeUiState = (req: Request, res: Response): void => {
  const body = (req.body ?? {}) as { patch?: unknown };
  res.json({ state: patchUiState(body.patch ?? body) });
};

app.get('/api/ui-state', readUiState);
app.put('/api/ui-state', writeUiState);
app.post('/api/ui-state', writeUiState);

app.get('/api/storage/location', (_req, res) => {
  res.json(getStorageLocation());
});

app.put(
  '/api/storage/location',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { path?: unknown };
    const outcome = setStorageLocation(String(body.path ?? ''));
    res.json(outcome);
  }),
);

app.get('/api/mcp/servers', (_req, res) => {
  res.json({ servers: listServersMasked() });
});


app.get('/api/mcp/figma/auth', asyncRoute(async (_req, res) => {
  res.json(figmaAuthStatus());
}));


app.post('/api/mcp/figma/auth', asyncRoute(async (_req, res) => {
  try {
    res.json(await figmaSignIn());
  } catch (error) {
    throw new HttpError(502, error instanceof Error ? error.message : 'Figma sign-in failed.');
  }
}));


app.delete('/api/mcp/figma/auth', asyncRoute(async (_req, res) => {
  figmaAuthReset();
  res.json({ ok: true });
}));

app.post(
  '/api/mcp/servers',
  asyncRoute(async (req, res) => {
    const body = req.body as {
      name?: string;
      transport?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      auth?: 'figma';
      enabled?: boolean;
    };
    if (!body?.name?.trim()) throw new HttpError(400, 'MCP server name is required.');
    if (body.transport !== 'stdio' && body.transport !== 'http') {
      throw new HttpError(400, 'MCP transport must be "stdio" (local) or "http" (remote).');
    }
    if (body.transport === 'stdio' && !body.command?.trim()) {
      throw new HttpError(400, 'A local MCP server needs a command to run.');
    }
    if (body.transport === 'http' && !body.url?.trim()) {
      throw new HttpError(400, 'A remote MCP server needs a URL.');
    }
    const server = upsertServer({
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      env: body.env,
      url: body.url,
      headers: body.headers,
      auth: body.auth,
      enabled: body.enabled ?? true,
    });
    res.json({ ok: true, server: getServerMasked(server.id) });
  }),
);

app.put(
  '/api/mcp/servers/:id',
  asyncRoute(async (req, res) => {
    const existing = getServer(req.params.id);
    if (!existing) throw new HttpError(404, `Unknown MCP server "${req.params.id}".`);
    const body = req.body as {
      name?: string;
      transport?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      auth?: 'figma';
      enabled?: boolean;
      
      disabledTools?: string[];
    };
    await dropConnection(existing.id);
    const server = upsertServer({
      id: existing.id,
      name: body?.name?.trim() || existing.name,
      transport: (body?.transport === 'http' || body?.transport === 'stdio'
        ? body.transport
        : existing.transport) as 'stdio' | 'http',
      command: body?.command ?? existing.command,
      args: Array.isArray(body?.args) ? body.args.map(String) : existing.args,
      env: body?.env ?? existing.env,
      url: body?.url ?? existing.url,
      headers: body?.headers ?? existing.headers,
      auth: body?.auth ?? existing.auth,
      enabled: body?.enabled ?? existing.enabled,
      disabledTools: Array.isArray(body?.disabledTools) ? body.disabledTools : existing.disabledTools,
    });
    res.json({ ok: true, server: getServerMasked(server.id) });
  }),
);

app.delete(
  '/api/mcp/servers/:id',
  asyncRoute(async (req, res) => {
    await dropConnection(req.params.id);
    const removed = removeServer(req.params.id);
    if (!removed) throw new HttpError(404, `Unknown MCP server "${req.params.id}".`);
    res.json({ ok: true });
  }),
);


app.post(
  '/api/mcp/servers/:id/test',
  asyncRoute(async (req, res) => {
    res.json(await testServer(req.params.id));
  }),
);

app.get(
  '/api/mcp/servers/:id/tools',
  asyncRoute(async (req, res) => {
    const config = getServer(req.params.id);
    if (!config) throw new HttpError(404, `Unknown MCP server "${req.params.id}".`);
    try {
      const connection = await ensureConnection(config);
      res.json({
        tools: connection.tools.map((tool) => ({
          ...tool,
          disabled: Array.isArray(config.disabledTools) && config.disabledTools.includes(tool.name),
        })),
      });
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : 'MCP connection failed.');
    }
  }),
);


app.post(
  '/api/mcp/servers/:id/call',
  asyncRoute(async (req, res) => {
    const config = getServer(req.params.id);
    if (!config) throw new HttpError(404, `Unknown MCP server "${req.params.id}".`);
    const body = req.body as { name?: string; arguments?: Record<string, unknown> };
    if (!body?.name?.trim()) throw new HttpError(400, 'Tool name is required.');
    try {
      const connection = await ensureConnection(config);
      const result = await connection.client.callTool(body.name, body.arguments ?? {});
      res.json(result);
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : 'MCP tool call failed.');
    }
  }),
);

// Built-in Agents — workspace registry, picker browse, harness debug call.

app.use('/api/agent', agentRouter());
app.use('/api/goals', goalsRouter());
app.use('/api/todos', todosRouter());
app.use('/api/reminders', remindersRouter());
app.use('/api/workflows', workflowsRouter());
app.use('/api/skills', skillsRouter());
app.use('/api/plan-mode', planModeRouter());
app.use('/api/addons', addonRouter());
app.use('/api/watch', watchRouter());
app.use('/api/ui', uiExportRouter());

app.use('/', bridgeRouter());

app.get('/api/usage', (req, res) => {
  const windowKey = typeof req.query.window === 'string' ? req.query.window : '30d';
  const providerIds =
    typeof req.query.providers === 'string' && req.query.providers.trim()
      ? req.query.providers.split(',').map((id) => id.trim()).filter(Boolean)
      : undefined;
  const aggregate = aggregateUsage(windowKey);
  res.json({
    windows: Object.keys(USAGE_WINDOWS),
    window: windowKey in USAGE_WINDOWS ? windowKey : '30d',
    providers: aggregate.providers,
    totals: aggregate.totals,
    daily: dailyUsage(windowKey, providerIds),
  });
});

app.put(
  '/api/settings',
  asyncRoute(async (req, res) => {
    const body = req.body as { imageRetentionDays?: unknown };
    const days = Number(body?.imageRetentionDays);
    if (!Number.isFinite(days) || days < 0 || days > 365) {
      throw new HttpError(400, 'imageRetentionDays must be a number between 0 and 365 (0 = never).');
    }
    const settings: ServerSettings = { imageRetentionDays: Math.floor(days) };
    writeServerSettings(settings);
    res.json(settings);
  }),
);

app.get(
  '/api/images/sessions',
  asyncRoute(async (_req, res) => {
    const sessions = readImageSessions().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (pruneSessionItems(sessions)) writeImageSessions(sessions);
    res.json({ sessions });
  }),
);

app.post(
  '/api/images/sessions',
  asyncRoute(async (req, res) => {
    const body = req.body as { label?: unknown };
    const now = new Date().toISOString();
    const session: ImageSession = {
      id: `imgses-${crypto.randomUUID().slice(0, 8)}`,
      label:
        typeof body?.label === 'string' && body.label.trim()
          ? body.label.trim().slice(0, 80)
          : `Session ${new Date().toLocaleDateString()}`,
      createdAt: now,
      updatedAt: now,
      items: [],
    };
    const sessions = readImageSessions();
    sessions.push(session);
    writeImageSessions(sessions);
    logImageTask({ kind: 'session-created', sessionId: session.id, label: session.label });
    res.status(201).json({ session });
  }),
);

app.patch(
  '/api/images/sessions/:id',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const body = req.body as { label?: unknown };
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 80) : '';
    if (!label) throw new HttpError(400, 'A non-empty label is required.');
    const sessions = readImageSessions();
    const target = sessions.find((session) => session.id === id);
    if (!target) throw new HttpError(404, `Unknown image session "${id}".`);
    target.label = label;
    target.updatedAt = new Date().toISOString();
    writeImageSessions(sessions);
    res.json({ session: target });
  }),
);

app.delete(
  '/api/images/sessions/:id',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const sessions = readImageSessions();
    const target = sessions.find((session) => session.id === id);
    if (!target) throw new HttpError(404, `Unknown image session "${id}".`);

    const keep = new Set(
      readGallery()
        .map((url) => localImageName(url))
        .filter((name): name is string => name !== null),
    );
    for (const session of sessions) {
      if (session.id === id) continue;
      for (const item of session.items) {
        const name = localImageName(item.url);
        if (name) keep.add(name);
      }
    }
    let removedFiles = 0;
    for (const item of target.items) {
      const name = localImageName(item.url);
      if (!name || keep.has(name)) continue;
      fs.rmSync(path.join(IMAGES_DIR, name), { force: true });
      fs.rmSync(path.join(IMAGES_DIR, name.replace(/\.[^.]+$/, '.json')), { force: true });
      removedFiles += 1;
    }

    writeImageSessions(sessions.filter((session) => session.id !== id));
    logImageTask({
      kind: 'session-deleted',
      sessionId: id,
      label: target.label,
      removedFiles,
    });
    res.json({ removedFiles });
  }),
);

app.post(
  '/api/images/sessions/:id/items',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const body = req.body as { items?: unknown };
    if (!Array.isArray(body?.items)) throw new HttpError(400, 'items must be an array.');

    const sessions = readImageSessions();
    const session = sessions.find((entry) => entry.id === id);
    if (!session) throw new HttpError(404, `Unknown image session "${id}".`);

    for (const raw of body.items) {
      const item = raw as Partial<ImageSessionItem>;
      if (typeof item?.url !== 'string') continue;
      session.items.push({
        url: item.url,
        taskId: typeof item.taskId === 'string' ? item.taskId : '',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        model: typeof item.model === 'string' ? item.model : '',
        provider: typeof item.provider === 'string' ? item.provider : '',
        savedAt: typeof item.savedAt === 'string' ? item.savedAt : new Date().toISOString(),
      });
    }
    session.updatedAt = new Date().toISOString();
    writeImageSessions(sessions);
    res.json({ session });
  }),
);


app.post(
  '/api/images/cleanup',
  asyncRoute(async (req, res) => {
    const body = req.body as { all?: unknown; urls?: unknown };
    const galleryNames = new Set(
      readGallery()
        .map((url) => localImageName(url))
        .filter((name): name is string => name !== null),
    );

    const targets = new Set<string>();
    if (body?.all === true) {
      for (const name of fs.readdirSync(IMAGES_DIR)) {
        if (/\.(jpg|jpeg|png|webp)$/i.test(name)) targets.add(name);
      }
    } else if (Array.isArray(body?.urls)) {
      for (const url of body.urls) {
        if (typeof url !== 'string') continue;
        const name = localImageName(url);
        if (name) targets.add(name);
      }
    } else {
      throw new HttpError(400, 'Provide either all: true or a urls array.');
    }

    let removed = 0;
    let skipped = 0;
    for (const name of targets) {
      if (galleryNames.has(name)) {
        skipped += 1;
        continue;
      }
      fs.rmSync(path.join(IMAGES_DIR, name), { force: true });
      fs.rmSync(path.join(IMAGES_DIR, name.replace(/\.[^.]+$/, '.json')), { force: true });
      removed += 1;
    }

    const sessions = readImageSessions();
    if (pruneSessionItems(sessions)) writeImageSessions(sessions);

    logImageTask({ kind: 'cleanup', removed, skipped });
    res.json({ removed, skipped });
  }),
);


if (process.env.NODE_ENV === 'production') {
  const distDir = fileURLToPath(new URL('../dist', import.meta.url));
  app.use(express.static(distDir, { index: false }));
  app.get('*', (_req, res) => res.sendFile('index.html', { root: distDir }));
}

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Internal server error.';

  if (status >= 500) console.error(`[moriko] ${req.method} ${req.path} failed:`, error);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message });
});


loadImageTasksFromDisk();
sweepTemporaryImages();
setInterval(sweepTemporaryImages, 30 * 60 * 1000);

const IMAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
function pruneOldImages(): void {
  try {
    let removed = 0;
    for (const name of fs.readdirSync(IMAGES_DIR)) {
      const full = path.join(IMAGES_DIR, name);
      const stats = fs.statSync(full);
      if (Date.now() - stats.mtimeMs > IMAGE_RETENTION_MS) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    }
    if (removed > 0) console.log(`[images] pruned ${removed} file(s) older than 7 days`);
  } catch (error) {
    console.error('[images] retention pass failed:', error);
  }
}
pruneOldImages();



app.get(
  '/api/vision/config',
  asyncRoute(async (_req, res) => {
    const config = await getVisionConfig();
    res.json(config);
  }),
);

app.post(
  '/api/vision/config',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Partial<VisionConfig>;
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : undefined;
    await setVisionConfig({ providerId, model, baseUrl });
    res.json({ ok: true, config: { providerId, model, baseUrl } });
  }),
);



app.get(
  '/api/conversations',
  asyncRoute(async (_req, res) => {
    res.json({ conversations: await listStoredConversationSummaries() });
  }),
);


app.get(
  '/api/conversations/trash',
  asyncRoute(async (_req, res) => {
    res.json({ trash: listTrash() });
  }),
);

app.post(
  '/api/conversations/trash/restore',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { folder?: unknown };
    const folder = typeof body.folder === 'string' ? body.folder : '';
    if (!folder) throw new HttpError(400, 'trash/restore needs a "folder" name from the trash list.');
    const id = restoreFromTrash(folder);
    if (!id) throw new HttpError(404, 'Trash folder not found or unreadable.');
    const summary = getStoredConversation(id);
    res.json({ ok: true, id, summary: summary ? summarizeConversation(summary) : null });
  }),
);

app.post(
  '/api/conversations/trash/empty',
  asyncRoute(async (_req, res) => {
    res.json({ ok: true, removed: emptyTrash() });
  }),
);


app.get(
  '/api/attachments/ref/:hash',
  (req, res) => {
    const hash = typeof req.params.hash === 'string' ? req.params.hash : '';
    const stored = readStoredWithMime(hash);
    if (!stored) {
      res.status(404).json({ error: 'No stored payload for that hash.' });
      return;
    }
    const mime = typeof req.query.mime === 'string' && req.query.mime ? req.query.mime : stored.mime;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(stored.bytes);
  },
);


app.post(
  '/api/attachments/store',
  express.raw({ type: () => true, limit: '12mb' }),
  asyncRoute(async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || buffer.length === 0) {
      res.status(400).json({ ok: false, error: 'A non-empty body is required.' });
      return;
    }
    const mime =
      typeof req.query.mime === 'string' && req.query.mime ? req.query.mime : 'application/octet-stream';
    const hash = putBytes(buffer, mime);
    res.json({ ok: true, hash, byteSize: buffer.length, mime });
  }),
);


app.get(
  '/api/conversations/:id',
  asyncRoute(async (req, res) => {
    const conversation = await getStoredConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'No conversation with that id.' });
      return;
    }
    res.json({ conversation });
  }),
);

app.patch(
  '/api/conversations/:id/config',
  asyncRoute(async (req, res) => {
    const conversationId = String(req.params.id ?? '').trim();
    const body = (req.body ?? {}) as {
      settings?: unknown;
      compaction?: unknown;
      hasCompaction?: boolean;
      providerId?: unknown;
      model?: unknown;
      liveContext?: unknown;
      initialConversation?: unknown;
    };
    if (!conversationId) {
      res.status(400).json({ error: 'conversation id is required.' });
      return;
    }
    const initialConversation =
      body.initialConversation &&
      typeof body.initialConversation === 'object' &&
      !Array.isArray(body.initialConversation)
        ? ({ ...(body.initialConversation as Record<string, unknown>), id: conversationId } as StoredConversation)
        : undefined;
    const updated = patchConversationConfig(conversationId, {
      settings:
        body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
          ? (body.settings as Record<string, unknown>)
          : undefined,
      hasCompaction: body.hasCompaction === true || 'compaction' in body,
      compaction: body.compaction,
      providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      liveContext: 'liveContext' in body ? body.liveContext : undefined,
      initialConversation,
    });
    if (!updated) {
      res.status(404).json({ error: 'No conversation with that id.' });
      return;
    }
    const mergedSettings =
      typeof updated.settings === 'object' && updated.settings !== null
        ? (updated.settings as Record<string, unknown>)
        : {};
    setLiveCompactionConfig(conversationId, {
      autoCompact: mergedSettings.autoCompact !== false,
      compactThresholdTokens:
        typeof mergedSettings.compactThresholdTokens === 'number' &&
        mergedSettings.compactThresholdTokens > 0
          ? mergedSettings.compactThresholdTokens
          : null,
      compactThresholdRatio:
        typeof mergedSettings.compactThresholdRatio === 'number' &&
        Number.isFinite(mergedSettings.compactThresholdRatio)
          ? mergedSettings.compactThresholdRatio
          : null,
      maxContextTokens:
        typeof mergedSettings.maxContextTokens === 'number' &&
        mergedSettings.maxContextTokens > 0
          ? mergedSettings.maxContextTokens
          : null,
    });
    res.json({ ok: true, summary: summarizeConversation(updated) });
  }),
);


app.post(
  '/api/conversations/sync',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { upsert?: unknown; removeIds?: unknown; turnPatches?: unknown };
    const merged = await syncStoredConversations(
      Array.isArray(body.upsert) ? body.upsert : [],
      Array.isArray(body.removeIds) ? body.removeIds : [],
    );
    const patches = Array.isArray(body.turnPatches) ? body.turnPatches : [];
    if (patches.length > 0) applyTurnPatches(patches);
    // preview/rev/turnCount reflect the live in-flight state.
    const summaries = patches.length > 0 ? listStoredConversationSummaries() : merged.map(summarizeConversation);
    res.json({ ok: true, conversations: summaries });
  }),
);



app.post(
  '/api/attachments/upload',
  express.raw({ type: () => true, limit: '12mb' }),
  asyncRoute(async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    const name = typeof req.query.name === 'string' ? path.basename(req.query.name) : '';
    if (!buffer || buffer.length === 0 || !name) {
      res.status(400).json({ ok: false, error: 'A file body and a "name" query are required.' });
      return;
    }

    const sessionId =
      (typeof req.query.chatId === 'string' && req.query.chatId.trim()) ||
      (typeof req.query.sessionId === 'string' && req.query.sessionId.trim()) ||
      '';

    const stored = await persistAttachments(
      sessionId,
      [
        {
          name,
          mime: req.get('Content-Type') || 'application/octet-stream',
          size: buffer.length,
          buffer,
        },
      ],
    );

    if (stored.length === 0) {
      res.status(413).json({ ok: false, error: 'The file was rejected (empty, no session, or above the 10 MB cap).' });
      return;
    }

    res.json({
      ok: true,
      path: stored[0].absolutePath,
      filename: stored[0].filename,
      size: stored[0].size,
      mime: stored[0].mime,
    });
  }),
);

const httpServer = app.listen(PORT, () => {
  startSweepTimer();
  startStallSweeper();

  attachBrowserPanelWs(httpServer);

  void (async () => {
    try {
      const { seedBuiltinAddons } = await import('./addons/seed.js');
      const report = seedBuiltinAddons();
      if (report.seeded.length > 0) console.log(`  Seeded builtin addons: ${report.seeded.join(', ')}.`);
    } catch (error) {
      console.error('  [addons] builtin seed failed:', error);
    }
    await loadAllAddons();
    startAddonWatcher((ids) => {
      console.log(`  Addons reloaded: ${ids.join(', ')}.`);
      void publishBusEvent('addons.registry', { reason: 'watcher', addonIds: ids }, 'moriko-host');
    });
    try {
      const { emitPoint } = await import('./addons/points.js');
      await emitPoint('harness.start', { at: Date.now() });
    } catch {  }
    console.log(`  [mcp-bridge] POST /mcp/${bridgeToken()} (actor: council Main Session ${resolveMainSessionId() ?? 'pending'})`);
  })();

  const configured = BUILT_IN_PROVIDERS.filter(
    (provider) => (provider.envKey && process.env[provider.envKey]) || provider.keyOptional,
  ).map((provider) => provider.label);

  const crashed = jobStore.sweepCrashed();
  const resurrected = rehydrateRuns();

  console.log(`\n  Moriko Studio proxy → http://127.0.0.1:${PORT}`);
  console.log(`  Providers ready:    ${configured.join(', ') || 'none (add keys to .env)'}`);
  console.log(`  App data (~/.moriko-studio): ${morikoHomeDisplay()}`);
  console.log(`  MCP servers:        ${listServers().filter((server) => server.enabled).length} enabled`);
  if (crashed.length > 0) {
    console.log(`  Interrupted runs:   ${crashed.length} (marked crashed — resumable from the UI)`);
  }
  if (resurrected.length > 0) {
    console.log(`  Replayed runs:      ${resurrected.length} (frames restored from the run journal)`);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdownAll().finally(() => process.exit(0));
  });
}
process.on('exit', () => {
  void shutdownAll();
});
