/**
 * agent__image / agent__image_models — LLM-driven image generation.
 *
 * The chat model composes the FINAL prompt (it is the prompt engineer) and
 * submits through the shared image runtime (./images/runtime.ts) — the same
 * engine the HTTP routes use, so provider adapters, task persistence, the
 * failure journal and local saving behave identically.
 *
 * Two modes, picked automatically:
 *  - text-to-image: no referencePaths.
 *  - edit: referencePaths present (user attachments, earlier results).
 *
 * Results are appended to the user's Gallery automatically (user decision),
 * ride back INLINE so the model can see and iterate on them, and the local
 * URLs are stable enough to feed back as referencePaths.
 */
import type { HarnessToolResult, AgentToolContext, ToolImage } from './shared.js';
import { str, resolveWithPermission } from './shared.js';
import { resolveImageSource } from '../vision.js';
import { fetchPublicImage } from './vision.js';
import { getUiState } from '../../uiState.js';
import {
  appendToGallery,
  listImageCapableProviders,
  localImageByUrl,
  resolveAgentImageTarget,
  runImageTask,
  type ImageProviderEntry,
} from '../../images/runtime.js';

/** One active generation per session — the model must not fan out image calls. */
const activeRuns = new Set<string>();

/** Cap on the composed prompt (providers clamp lower; their error surfaces). */
const MAX_PROMPT_CHARS = 2000;
/** Inline images returned to the model per call (context budget). */
const MAX_INLINE_IMAGES = 2;

function unconfigured(): HarnessToolResult {
  return {
    ok: false,
    isError: true,
    text:
      'Image generation is not configured. Ask the user to set it up in the app: open Image Studio, ' +
      'pick a provider with image capabilities (adding its API key in Provider settings). ' +
      'agent__image_models lists which providers/models are usable. Then retry.',
  };
}

function readableError(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : '';
  return text.trim() ? text.slice(0, 600) : fallback;
}

/**
 * Resolves ONE reference input — a previous result URL (`/api/images/local/…`),
 * a data: URL, a public http(s) URL, or a workspace/attachment path (same
 * permission gate the vision tool uses).
 */
async function resolveReference(
  input: string,
  ctx: AgentToolContext,
): Promise<{ dataUrl: string } | { error: string }> {
  const trimmed = input.trim();
  if (!trimmed) return { error: '(empty reference path)' };

  if (trimmed.startsWith('/api/images/local/')) {
    const local = localImageByUrl(trimmed);
    if (!local) return { error: `"${trimmed}" — no such previously generated image on disk.` };
    return { dataUrl: `data:${local.mime};base64,${local.buffer.toString('base64')}` };
  }

  if (trimmed.startsWith('data:') || /^https?:\/\//i.test(trimmed)) {
    const out = await resolveImageSource(trimmed, fetchPublicImage);
    if (!out) return { error: `"${trimmed}" is not a supported image (expected an image content type).` };
    return { dataUrl: `data:${out.mime};base64,${out.buffer.toString('base64')}` };
  }

  try {
    const { absolute } = await resolveWithPermission('image', trimmed, ctx, 'read');
    const out = await resolveImageSource(absolute, fetchPublicImage);
    if (!out) return { error: `"${trimmed}" is not a supported image (expected png/jpg/webp…).` };
    return { dataUrl: `data:${out.mime};base64,${out.buffer.toString('base64')}` };
  } catch (error) {
    return { error: `"${trimmed}": ${readableError(error, 'could not read the file.')}` };
  }
}

export async function imageTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const prompt = str(args, 'prompt').trim();
  if (!prompt) {
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: 'agent__image needs "prompt" — the FINAL image prompt you composed (subject, style, composition, lighting).',
    };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      isError: true,
      text: `The prompt is ${prompt.length} chars — providers reject over ~1000. Compress it to the essentials and retry.`,
    };
  }

  const runKey = ctx.sessionId ?? '__debug__';
  if (activeRuns.has(runKey)) {
    return {
      ok: false,
      isError: true,
      text: 'An image generation is already running in this session — wait for its result before starting another.',
    };
  }

  const target = await resolveAgentImageTarget({
    providerId: str(args, 'providerId').trim() || undefined,
    model: str(args, 'model').trim() || undefined,
  });
  if (!target) return unconfigured();

  const rawRefs = Array.isArray(args.referencePaths) ? args.referencePaths : [];
  const refInputs = rawRefs
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 8);
  const images: string[] = [];
  for (const input of refInputs) {
    const resolved = await resolveReference(input, ctx);
    if ('error' in resolved) {
      return {
        ok: false,
        isError: true,
        text: `Could not use reference image ${resolved.error} Fix the path (or drop it) and retry.`,
      };
    }
    images.push(resolved.dataUrl);
  }

  const providers = await listImageCapableProviders();
  const entry = providers.find((p) => p.providerId === target.providerId);
  if (entry && images.length > entry.maxReferences) {
    return {
      ok: false,
      isError: true,
      text:
        entry.maxReferences === 0
          ? `${entry.label} cannot carry reference images — remove referencePaths (pure text-to-image), or pick an edit-capable model via agent__image_models.`
          : `${entry.label} accepts at most ${entry.maxReferences} reference image(s) per request — you sent ${images.length}.`,
    };
  }
  if (entry && images.length > 0) {
    const caps = entry.models.find((m) => m.id === target.model);
    if (caps && !caps.modes.includes('edit')) {
      return {
        ok: false,
        isError: true,
        text: `"${target.model}" is classified text-to-image only — it cannot edit references. Call agent__image_models to find an edit-capable model, or drop referencePaths.`,
      };
    }
  }

  const coerceDim = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  let aspectRatio = str(args, 'aspectRatio').trim() || undefined;
  let width = coerceDim(args.width);
  let height = coerceDim(args.height);
  if ((width !== undefined) !== (height !== undefined)) {
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text:
        `width and height must be sent as a PAIR — you sent only ${width !== undefined ? `width=${width}` : `height=${height}`}. ` +
        `Resend the call with BOTH width and height (numbers, 64-4096), or drop both and use aspectRatio.`,
    };
  }
  if (
    width !== undefined &&
    height !== undefined &&
    (width < 64 || height < 64 || width > 4096 || height > 4096)
  ) {
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: `width/height must be 64-4096 — you sent ${width}x${height}.`,
    };
  }
  if (!aspectRatio && width === undefined && height === undefined) {
    const saved = getUiState()['imageStudio'] as
      | { sizeMode?: unknown; aspectRatio?: unknown; pixelWidth?: unknown; pixelHeight?: unknown }
      | undefined;
    if (saved && typeof saved === 'object') {
      if (saved.sizeMode === 'aspect' && typeof saved.aspectRatio === 'string' && saved.aspectRatio !== 'auto') {
        aspectRatio = saved.aspectRatio;
      } else if (saved.sizeMode === 'pixels') {
        const w = Number(saved.pixelWidth);
        const h = Number(saved.pixelHeight);
        if (Number.isFinite(w) && Number.isFinite(h)) {
          width = w;
          height = h;
        }
      }
    }
  }

  activeRuns.add(runKey);
  try {
    const outcome = await runImageTask(
      {
        providerId: target.providerId,
        model: target.model,
        prompt,
        aspectRatio,
        width,
        height,
        images: images.length > 0 ? images : undefined,
      },
      {
        signal: ctx.signal,
        onProgress: (message) => ctx.onProgress?.(`Image (${target.providerLabel}/${target.model}): ${message}`),
      },
    );

    if (outcome.status !== 'SUCCEED' || outcome.images.length === 0) {
      return {
        ok: false,
        isError: true,
        text: `Image generation failed: ${outcome.error ?? `status ${outcome.status}.`}`,
      };
    }

    appendToGallery(outcome.images);

    const inline: ToolImage[] = [];
    for (const url of outcome.images.slice(0, MAX_INLINE_IMAGES)) {
      const local = localImageByUrl(url);
      if (local) inline.push({ mime: local.mime, dataUrl: `data:${local.mime};base64,${local.buffer.toString('base64')}` });
    }

    const lines = [
      `Generated ${outcome.images.length} image(s) with ${target.providerLabel}/${target.model}${images.length > 0 ? ' (edit mode)' : ''}:`,
      ...outcome.images.map((url) => `- ${url}`),
    ];
    if (outcome.note) lines.push(`Note: ${outcome.note}`);
    lines.push('');
    lines.push(
      'The image(s) ride this result inline — LOOK at them before describing the result to the user. ' +
        'They were saved to the user\'s Gallery automatically. ' +
        'To iterate ("make it darker", "change the background"), call agent__image again with the result URL ' +
        'in referencePaths and the edit instruction as the prompt.',
    );

    return {
      ok: true,
      isError: false,
      text: lines.join('\n'),
      ...(inline.length > 0 ? { images: inline } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Image generation failed: ${readableError(error, 'the provider request could not be completed.')}`,
    };
  } finally {
    activeRuns.delete(runKey);
  }
}

export async function imageModelsTool(_args: Record<string, unknown>, _ctx: AgentToolContext): Promise<HarnessToolResult> {
  const providers = await listImageCapableProviders();
  if (providers.length === 0) return unconfigured();

  const saved = (() => {
    try {
      const value = getUiState()['imageStudio'] as { providerId?: unknown; model?: unknown } | undefined;
      if (!value || typeof value !== 'object') return null;
      const providerId = typeof value.providerId === 'string' ? value.providerId : '';
      const model = typeof value.model === 'string' ? value.model : '';
      return providerId && model ? { providerId, model } : null;
    } catch {
      return null;
    }
  })();

  const render = (entry: ImageProviderEntry): string => {
    const modelLines = entry.models
      .map((model) => {
        const isDefault = saved && entry.providerId === saved.providerId && model.id === saved.model;
        const modes = model.modes.join('/');
        const label = model.label ? ` (${model.label})` : '';
        return `  - ${model.id}${label} [${modes}, refs ${model.maxReferences}]${isDefault ? ' ← DEFAULT' : ''}`;
      })
      .join('\n');
    const keyState = entry.hasServerKey ? '' : ' — NO API KEY (ask the user to add one)';
    return `${entry.providerId} · ${entry.label}${keyState} (provider refs: ${entry.maxReferences})\n${modelLines}`;
  };

  const body = providers.map(render).join('\n\n');
  return {
    ok: true,
    isError: false,
    text:
      `Available image models:\n\n${body}\n\n` +
      (saved
        ? `Default (the user's saved Image Studio choice): ${saved.providerId}/${saved.model}. ` +
          'agent__image uses it unless the user names a model — then pass it in "model" (and "providerId" when it belongs to another provider).'
        : 'No saved default — the first usable provider/model is used. The user can pick one in Image Studio.'),
  };
}
