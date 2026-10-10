/**
 * ComfyUI local adapter — workflow-based image generation.
 *
 * ComfyUI runs locally at http://127.0.0.1:8188 (no auth). Instead of
 * OpenAI's /images/generations, it accepts workflow JSON via POST /prompt,
 * returns a prompt_id, and results are polled via GET /history/{id} then
 * downloaded via GET /view.
 *
 * Model discovery scans /models/{folder} for checkpoints, diffusion_models,
 * and unet (legacy). Each model is tagged: "ckpt:name" uses
 * CheckpointLoaderSimple (bundled MODEL+CLIP+VAE); "diff:name" / "unet:name"
 * uses UNETLoader (MODEL only — CLIP and VAE are auto-detected from
 * /models/clip and /models/vae at submit time).
 *
 * Supported modes:
 *  - Text-to-Image: EmptyLatentImage → KSampler (denoise=1)
 *  - Image-to-Image: LoadImage → VAEEncode → KSampler (denoise<1)
 *
 * For diffusion models (Flux, SD3), the adapter auto-detects CLIP and VAE
 * files: Flux models pair with t5xxl + clip_l + ae; other diffusion models
 * fall back to the first available CLIP/VAE.
 */

import { randomUUID } from 'node:crypto';

import { formatRejection } from './errorReport.js';
import type {
  AdapterContext,
  ImageAdapter,
  ImageAdapterError,
  ImageCapabilities,
  ImagePollResult,
  ImageSubmitRequest,
  NormalizedImage,
} from './types.js';

// ─── helpers ──────────────────────────────────────────────────────────

/** Strip trailing slashes; ComfyUI has no /v1 prefix. */
function base(host: string): string {
  return host.replace(/\/+$/, '');
}

/** Parse model ID: "ckpt:filename" | "diff:filename" | "unet:filename" | "filename". */
function parseModelId(model: string): { loader: 'checkpoint' | 'diffusion'; filename: string } {
  const colon = model.indexOf(':');
  if (colon > 0) {
    const prefix = model.slice(0, colon);
    const filename = model.slice(colon + 1);
    if (prefix === 'diff' || prefix === 'unet') return { loader: 'diffusion', filename };
    if (prefix === 'ckpt') return { loader: 'checkpoint', filename };
    return { loader: 'checkpoint', filename: model };
  }
  return { loader: 'checkpoint', filename: model };
}

/** Fetch JSON, return null on failure (non-OK or network error). */
async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── CLIP / VAE auto-detection ────────────────────────────────────────

interface ClipVae {
  clip1?: string;
  clip2?: string;
  vae?: string;
}

async function autoDetectClipVae(baseUrl: string, modelFilename: string): Promise<ClipVae> {
  const lower = modelFilename.toLowerCase();
  const isFlux = /flux/.test(lower);
  const isSd3 = /sd3/.test(lower);

  const clipList = (await fetchJson<string[]>(`${baseUrl}/models/clip`)) ?? [];
  const vaeList = (await fetchJson<string[]>(`${baseUrl}/models/vae`)) ?? [];

  const findClip = (pattern: RegExp) => clipList.find((f) => pattern.test(f.toLowerCase()));
  const findVae = (pattern: RegExp) => vaeList.find((f) => pattern.test(f.toLowerCase()));

  let clip1: string | undefined;
  let clip2: string | undefined;
  let vae: string | undefined;

  if (isFlux || isSd3) {
    clip1 = findClip(/t5xxl|t5/) ?? clipList[0];
    clip2 = findClip(/clip[_-]l|clip[_-]g/) ?? clipList.find((f) => f !== clip1);
    vae = findVae(/\bae\b|sdxl|sd3|ema/) ?? vaeList[0];
  } else {
    clip1 = clipList[0];
    clip2 = clipList.find((f) => f !== clip1);
    vae = vaeList[0];
  }

  return { clip1, clip2, vae };
}

// ─── image upload ─────────────────────────────────────────────────────

interface UploadedImage {
  name: string;
  subfolder: string;
  type: string;
}

async function uploadImage(baseUrl: string, dataUrl: string): Promise<UploadedImage> {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Invalid reference image data URL.');

  const mime = match[1];
  const buf = Buffer.from(match[2], 'base64');
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';

  const form = new FormData();
  form.append('image', new Blob([buf], { type: mime }), `moriko_input.${ext}`);
  form.append('type', 'input');
  form.append('subfolder', 'moriko');
  form.append('overwrite', 'true');

  const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`ComfyUI image upload failed (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as UploadedImage;
}

// ─── workflow builder ──────────────────────────────────────────────────

interface WorkflowParams {
  model: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  denoise: number;
  referenceName?: string;
  clipVae: ClipVae;
}

/** Detect Flux-family model → lower cfg, simple scheduler. */
function isFluxFamily(filename: string): boolean {
  return /flux/i.test(filename);
}

/** Build the ComfyUI API-format workflow JSON. */
function buildWorkflow(p: WorkflowParams): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const { loader, filename } = parseModelId(p.model);
  const isFlux = isFluxFamily(filename);
  const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};

  // ── Model loader ──
  if (loader === 'checkpoint') {
    // CheckpointLoaderSimple → MODEL [0], CLIP [1], VAE [2]
    wf['4'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: filename } };
  } else {
    // UNETLoader → MODEL [0] only; separate CLIP + VAE
    wf['10'] = { class_type: 'UNETLoader', inputs: { unet_name: filename, weight_dtype: 'default' } };

    // DualCLIPLoader or CLIPLoader
    if (p.clipVae.clip1 && p.clipVae.clip2) {
      wf['11'] = { class_type: 'DualCLIPLoader', inputs: { clip_name1: p.clipVae.clip1, clip_name2: p.clipVae.clip2 } };
    } else if (p.clipVae.clip1) {
      wf['11'] = { class_type: 'CLIPLoader', inputs: { clip_name: p.clipVae.clip1 } };
    } else {
      throw new Error(
        'No CLIP models found in ComfyUI /models/clip. Diffusion models (Flux, SD3) require separate CLIP files. ' +
        'Download them to the models/clip (or models/text_encoders) folder.',
      );
    }

    // VAELoader
    if (!p.clipVae.vae) {
      throw new Error(
        'No VAE model found in ComfyUI /models/vae. Diffusion models require a separate VAE file. ' +
        'Download one to the models/vae folder.',
      );
    }
    wf['12'] = { class_type: 'VAELoader', inputs: { vae_name: p.clipVae.vae } };
  }

  // ── CLIP text encoders ──
  const clipRef = loader === 'checkpoint' ? ['4', 1] : ['11', 0];
  wf['6'] = { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: clipRef } };
  wf['7'] = { class_type: 'CLIPTextEncode', inputs: { text: p.negative || '', clip: clipRef } };

  // ── Latent source ──
  if (p.referenceName) {
    // i2i: LoadImage → VAEEncode → latent
    wf['14'] = { class_type: 'LoadImage', inputs: { image: p.referenceName } };
    const vaeRef = loader === 'checkpoint' ? ['4', 2] : ['12', 0];
    wf['13'] = { class_type: 'VAEEncode', inputs: { pixels: ['14', 0], vae: vaeRef } };
    wf['3'] = {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed, steps: p.steps, cfg: p.cfg,
        sampler_name: isFlux ? 'euler' : 'dpmpp_2m',
        scheduler: isFlux ? 'simple' : 'karras',
        denoise: p.denoise,
        model: loader === 'checkpoint' ? ['4', 0] : ['10', 0],
        positive: ['6', 0], negative: ['7', 0],
        latent_image: ['13', 0],
      },
    };
  } else {
    // t2i: EmptyLatentImage → latent
    wf['5'] = { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } };
    wf['3'] = {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed, steps: p.steps, cfg: p.cfg,
        sampler_name: isFlux ? 'euler' : 'dpmpp_2m',
        scheduler: isFlux ? 'simple' : 'karras',
        denoise: p.denoise,
        model: loader === 'checkpoint' ? ['4', 0] : ['10', 0],
        positive: ['6', 0], negative: ['7', 0],
        latent_image: ['5', 0],
      },
    };
  }

  // ── VAE decode + save ──
  const vaeDecodeRef = loader === 'checkpoint' ? ['4', 2] : ['12', 0];
  wf['8'] = { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: vaeDecodeRef } };
  wf['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'Moriko', images: ['8', 0] } };

  return wf;
}

// ─── adapter ──────────────────────────────────────────────────────────

const ACCEPTS =
  'ComfyUI POST /prompt — workflow JSON with model, prompt, negative, ' +
  'width, height, seed, steps, cfg, sampler, scheduler, denoise';

export const comfyuiAdapter: ImageAdapter = {
  id: 'comfyui-local',

  capabilities: {
    execution: 'async',
    sizeParam: 'width_height',
    resultFormat: 'b64',
    maxImages: 1,
    supportsNegativePrompt: true,
    maxReferences: 1,
  } satisfies ImageCapabilities,

  async submit(req: ImageSubmitRequest, { credentials }: AdapterContext): Promise<{ taskId: string }> {
    const host = base(credentials.baseUrl);

    // Health check
    const stats = await fetchJson<{ system?: unknown }>(`${host}/system_stats`);
    if (!stats) {
      throw {
        status: 502,
        upstreamBody: 'ComfyUI server not reachable. Is it running? Default: http://127.0.0.1:8188',
        message: 'ComfyUI server not reachable. Is it running? Default: http://127.0.0.1:8188',
      } as ImageAdapterError;
    }

    const { loader, filename } = parseModelId(req.model);
    const isFlux = isFluxFamily(filename);

    // Auto-detect CLIP/VAE for diffusion models
    let clipVae: ClipVae = {};
    if (loader === 'diffusion') {
      clipVae = await autoDetectClipVae(host, filename);
    }

    // Upload reference image if i2i
    let referenceName: string | undefined;
    if (req.images && req.images.length > 0) {
      const uploaded = await uploadImage(host, req.images[0]);
      referenceName = uploaded.name;
    }

    // Determine dimensions
    const width = req.width && req.width >= 64 ? Math.round(req.width) : 1024;
    const height = req.height && req.height >= 64 ? Math.round(req.height) : 1024;

    const seed = Math.floor(Math.random() * 1_125_899_906_842_624);
    const cfg = isFlux ? 1.0 : 7.0;
    const steps = isFlux ? 20 : 20;
    const denoise = referenceName ? 0.5 : 1.0;

    // Build workflow
    const workflow = buildWorkflow({
      model: req.model,
      prompt: req.prompt,
      negative: '', // ComfyUI gets negative via the prompt's "negative" field if provided
      width,
      height,
      seed,
      steps,
      cfg,
      denoise,
      referenceName,
      clipVae,
    });

    // Submit
    const clientId = randomUUID();
    const promptRes = await fetch(`${host}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });

    if (!promptRes.ok) {
      const bodyText = await promptRes.text().catch(() => '');
      const request = `POST ${host}/prompt — model "${req.model}", prompt ${req.prompt.length} chars, ${width}x${height}, ${referenceName ? 'i2i denoise 0.5' : 't2i denoise 1.0'}`;
      throw {
        status: promptRes.status,
        upstreamBody: bodyText,
        message: formatRejection({ label: credentials.label, status: promptRes.status, bodyText, request, accepts: ACCEPTS }),
      } as ImageAdapterError;
    }

    const result = (await promptRes.json()) as { prompt_id?: string; error?: string; node_errors?: Record<string, unknown> };
    if (result.error || result.node_errors) {
      const detail = result.error ?? JSON.stringify(result.node_errors ?? {});
      throw {
        status: 400,
        upstreamBody: detail,
        message: `${credentials.label} workflow validation failed: ${detail}`,
      } as ImageAdapterError;
    }
    if (!result.prompt_id) {
      throw {
        status: 502,
        upstreamBody: 'No prompt_id in ComfyUI response',
        message: 'ComfyUI returned no prompt_id — unexpected response format.',
      } as ImageAdapterError;
    }

    return { taskId: result.prompt_id };
  },

  async poll(taskId: string, { credentials }: AdapterContext): Promise<ImagePollResult> {
    const host = base(credentials.baseUrl);

    const history = await fetchJson<Record<string, ComfyHistoryEntry>>(`${host}/history/${encodeURIComponent(taskId)}`);
    if (!history) return { status: 'RUNNING', images: [] };

    const entry = history[taskId];
    if (!entry) return { status: 'RUNNING', images: [] };

    // Check for error
    const statusInfo = entry.status;
    if (statusInfo && statusInfo.status_str === 'error') {
      return {
        status: 'FAILED',
        providerStatus: statusInfo.status_str,
        images: [],
        error: `ComfyUI execution error: ${JSON.stringify(statusInfo)}`,
        raw: entry,
      };
    }

    // Check for completed outputs
    if (!entry.outputs) return { status: 'RUNNING', images: [] };

    const images: NormalizedImage[] = [];
    for (const nodeId of Object.keys(entry.outputs)) {
      const nodeOut = entry.outputs[nodeId];
      if (!nodeOut.images) continue;

      for (const img of nodeOut.images) {
        const viewUrl =
          `${host}/view?filename=${encodeURIComponent(img.filename)}` +
          `&subfolder=${encodeURIComponent(img.subfolder ?? '')}` +
          `&type=${encodeURIComponent(img.type ?? 'output')}`;

        const viewRes = await fetch(viewUrl);
        if (!viewRes.ok) continue;

        const buf = await viewRes.arrayBuffer();
        const b64 = Buffer.from(buf).toString('base64');
        images.push({ kind: 'b64', data: `data:image/png;base64,${b64}` });
      }
    }

    if (images.length === 0) return { status: 'RUNNING', images: [] };

    return {
      status: 'SUCCEED',
      providerStatus: statusInfo?.status_str ?? 'success',
      images,
    };
  },
};

// ─── ComfyUI history response types ───────────────────────────────────

interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
  status?: { status_str?: string; completed?: boolean };
}
