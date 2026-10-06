/**
 * Civitai Orchestration adapter — image generation through Civitai's
 * workflow API (developer.civitai.com/orchestration).
 *
 * Contract (verified against the official quick start + Flux 2 recipe):
 *   POST {base}/v2/consumer/workflows?wait=0   → { id: "wf_…", status, steps[] }
 *   GET  {base}/v2/consumer/workflows/{id}     → same Workflow object while polling
 *
 * A workflow is a list of steps; one `imageGen` step covers everything Image
 * Studio needs. The step's `engine`/`model`/`modelVersion` select the model
 * family and tier, `operation` picks text-to-image (`createImage`) versus
 * reference-guided editing (`editImage`, up to 2 source images on Klein —
 * sent as data URLs / https URLs / raw base64 directly, no upload step).
 * Outputs come back as `output.images[]` (some engines emit `output.blobs[]`
 * instead) holding SIGNED urls that expire — the route already snapshots
 * results into the local image store, so expiry is harmless.
 *
 * Model ids used by Moriko:
 *   flux2-klein-4b / flux2-klein-9b   → engine "flux2", model "klein" (default, cheapest)
 *   flux2-dev                          → engine "flux2", model "dev"
 *
 * Billing is Buzz per workflow; rejections (invalid token, insufficient
 * Buzz, content moderation) arrive as HTTP 4xx with a JSON error body.
 */

import {
  ImageAdapterError,
  type AdapterContext,
  type ImageAdapter,
  type ImagePollResult,
  type ImageSubmitRequest,
} from './types.js';
import { formatRejection } from './errorReport.js';
import { ratioToWxH } from './ratio.js';

/** Which engine/model/modelVersion a Moriko model id maps to. */
function parseCivitaiModel(model: string): {
  engine: string;
  ecosystem?: string;
  model?: string;
  modelVersion?: string;
  maxEditImages: number;
  /** URN models run on sdcpp, whose img2img operation is `createVariant`. */
  urnMode: boolean;
} {
  if (model.startsWith('urn:air:')) {
    const ecosystem = model.split(':')[2] || 'sdxl';
    return { engine: 'sdcpp', ecosystem, model, maxEditImages: 1, urnMode: true };
  }
  switch (model) {
    case 'flux2-klein-9b':
      return { engine: 'flux2', model: 'klein', modelVersion: '9b', maxEditImages: 2, urnMode: false };
    case 'flux2-dev':
      return { engine: 'flux2', model: 'dev', maxEditImages: 2, urnMode: false };
    case 'flux2-klein-4b':
    default:
      return { engine: 'flux2', model: 'klein', modelVersion: '4b', maxEditImages: 2, urnMode: false };
  }
}

const MIN_SIZE = 512;
const MAX_SIZE = 2048;

/** Clamps a size into the API's range; Klein requires multiples of 16. */
function clampSize(value: number, multipleOf16: boolean): number {
  let size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value)));
  if (multipleOf16) size -= size % 16;
  return size;
}

interface WorkflowStepOutput {
  images?: Array<{ url?: string }>;
  blobs?: Array<{ url?: string }>;
  reason?: string;
}

interface WorkflowStep {
  status?: string;
  output?: WorkflowStepOutput;
}

interface WorkflowPayload {
  id?: string;
  status?: string;
  steps?: WorkflowStep[];
}

interface WorkflowStepInput {
  [key: string]: unknown;
}

export const civitaiAdapter: ImageAdapter = {
  id: 'civitai-orchestration',
  capabilities: {
    execution: 'async',
    sizeParam: 'width_height',
    resultFormat: 'url',
    maxImages: 4,
    supportsNegativePrompt: true,
    // Reads `req.images` → editImage / createVariant (per-model spec caps 1–2).
    maxReferences: 2,
  },

  async submit(
    req: ImageSubmitRequest,
    { credentials }: AdapterContext,
  ): Promise<{ taskId: string }> {
    const base = credentials.baseUrl.replace(/\/+$/, '');
    const spec = parseCivitaiModel(req.model);

    const requested = req.width && req.height
      ? { width: req.width, height: req.height }
      : (req.aspectRatio ? ratioToWxH(req.aspectRatio) : null) ?? { width: 1024, height: 1024 };
    const multipleOf16 = spec.urnMode || spec.model === 'klein';
    const width = clampSize(requested.width, multipleOf16);
    const height = clampSize(requested.height, multipleOf16);

    const references = req.images ?? [];
    if (references.length > spec.maxEditImages) {
      throw new ImageAdapterError(
        400,
        `${req.model} accepts at most ${spec.maxEditImages} reference image(s) per request — you sent ${references.length}. Remove some in Image Studio.`,
      );
    }

    const input: WorkflowStepInput = {
      engine: spec.engine,
      ...(spec.ecosystem ? { ecosystem: spec.ecosystem } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.modelVersion ? { modelVersion: spec.modelVersion } : {}),
      operation:
        references.length > 0 ? (spec.urnMode ? 'createVariant' : 'editImage') : 'createImage',
      prompt: req.prompt.slice(0, 1000),
      width,
      height,
      quantity: 1,
      outputFormat: 'png',
    };
    if (references.length > 0) {
      if (spec.urnMode) {
        input.image = references[0];
        input.strength = 0.7;
      } else {
        input.images = references;
      }
    }

    const url = `${base}/v2/consumer/workflows?wait=0`;
    const requestLine = `POST ${url} — engine "${spec.engine}", model "${spec.model ?? '-'}"${
      spec.modelVersion ? `/${spec.modelVersion}` : ''
    }, operation "${String(input.operation)}", ${width}×${height}${
      references.length > 0 ? `, ${references.length} reference image(s)` : ''
    }`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ steps: [{ $type: 'imageGen', input }] }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      throw new ImageAdapterError(
        upstream.status,
        formatRejection({
          label: credentials.label,
          status: upstream.status,
          bodyText: text,
          request: requestLine,
          accepts:
            'a workflow with one imageGen step — input: engine/model/modelVersion per the ' +
            'Flux 2 recipe, prompt ≤1000 chars, width/height 512–2048 (Klein: multiple of 16), ' +
            'quantity 1–4, outputFormat jpeg|png, images[] for editImage (data:/https:/base64)',
        }),
        text,
      );
    }

    let payload: WorkflowPayload;
    try {
      payload = JSON.parse(text) as WorkflowPayload;
    } catch {
      throw new ImageAdapterError(
        502,
        `${credentials.label} returned a non-JSON response.`,
        `non-JSON body: ${text.slice(0, 600)}`,
      );
    }
    if (!payload.id) {
      throw new ImageAdapterError(
        502,
        `${credentials.label} did not return a workflow id.`,
        `no workflow id in body: ${text.slice(0, 600)}`,
      );
    }
    return { taskId: payload.id };
  },

  async poll(taskId: string, { credentials }: AdapterContext): Promise<ImagePollResult> {
    const base = credentials.baseUrl.replace(/\/+$/, '');
    const url = `${base}/v2/consumer/workflows/${encodeURIComponent(taskId)}`;

    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${credentials.apiKey ?? ''}` },
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      throw new ImageAdapterError(
        upstream.status,
        formatRejection({
          label: credentials.label,
          status: upstream.status,
          bodyText: detail,
          request: `GET ${url} (workflow polling)`,
          accepts: 'the workflow id returned by the submit call',
        }),
        detail,
      );
    }

    const data = (await upstream.json()) as WorkflowPayload;
    const status = data.status ?? 'pending';

    if (status === 'succeeded') {
      const images = (data.steps ?? [])
        .flatMap((step) => step.output?.images ?? step.output?.blobs ?? [])
        .map((entry) => entry?.url)
        .filter((url2): url2 is string => typeof url2 === 'string' && url2.length > 0)
        .map((url2) => ({ kind: 'url' as const, url: url2 }));
      return { status: 'SUCCEED', providerStatus: status, images, raw: data };
    }

    if (status === 'failed' || status === 'canceled') {
      const failure =
        (data.steps ?? []).map((step) => step.output?.reason).find((reason) => Boolean(reason)) ??
        `Workflow ${status}.`;
      return {
        status: 'FAILED',
        providerStatus: status,
        images: [],
        error: failure,
        raw: data,
      };
    }

    return { status: 'RUNNING', providerStatus: status, images: [], raw: data };
  },
};
