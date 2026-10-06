/**
 * ModelScope async-task adapter — the reference implementation.
 *
 * Behavior moved verbatim from the former hardcoded routes in
 * `server/index.ts` (submit: `X-ModelScope-Async-Mode: true`, poll:
 * `X-ModelScope-Task-Type: image_generation`), so existing providers keep
 * working bit-for-bit.
 */

import {
  ensureV1,
  ImageAdapterError,
  type AdapterContext,
  type ImageAdapter,
  type ImagePollResult,
  type ImageSubmitRequest,
} from './types.js';
import { ratioToSize } from './ratio.js';
import { formatRejection } from './errorReport.js';

interface ModelScopeSubmitResponse {
  task_id?: string;
}

interface ModelScopePollResponse {
  task_status?: string;
  output_images?: string[];
  message?: string;
  error_message?: string;
  error?: string;
  logs?: string;
}

export const modelscopeAdapter: ImageAdapter = {
  id: 'modelscope-async',
  capabilities: {
    execution: 'async',
    sizeParam: 'aspect_ratio',
    resultFormat: 'url',
    maxImages: 1,
    supportsNegativePrompt: false,
    // Reads `req.images` → `image_url`; ModelScope's edit API takes up to 3.
    maxReferences: 3,
  },

  async submit(
    req: ImageSubmitRequest,
    { credentials }: AdapterContext,
  ): Promise<{ taskId: string }> {
    const base = ensureV1(credentials.baseUrl);

    const size =
      req.width && req.height
        ? { size: `${req.width}x${req.height}`, width: req.width, height: req.height }
        : req.aspectRatio
          ? (() => {
              const translated = ratioToSize(req.aspectRatio);
              return translated ? { size: translated } : {};
            })()
          : {};
    const ratio = req.aspectRatio && !req.width && !req.height ? { aspect_ratio: req.aspectRatio } : {};

    const references = req.images ?? [];
    if (references.length > 3) {
      throw new ImageAdapterError(
        400,
        `ModelScope accepts at most 3 reference images per request — you sent ${references.length}. Remove some in Image Studio.`,
      );
    }

    const body = JSON.stringify({
      model: req.model,
      prompt: req.prompt,
      ...size,
      ...ratio,
      ...(references.length > 0 ? { image_url: references } : {}),
    });
    const url = `${base}/images/generations`;
    const sizeDesc = size.size
      ? `size "${size.size}"`
      : 'no size parameter (provider default 760×1280)';
    const requestLine = `POST ${url} — model "${req.model}", prompt ${req.prompt.length} chars, ${sizeDesc}${
      ratio.aspect_ratio ? `, aspect_ratio "${req.aspectRatio}"` : ''
    }${references.length > 0 ? `, ${references.length} reference image(s)` : ''}`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey ?? ''}`,
        'Content-Type': 'application/json',
        'X-ModelScope-Async-Mode': 'true',
      },
      body,
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
            'model, prompt, size "WxH" (honored — long edge 1280, square 1024) and ' +
            'aspect_ratio (presently ignored by this provider); edit models additionally ' +
            'require image_url (array of reference images, data: or https:); async submit ' +
            'needs the X-ModelScope-Async-Mode: true header; poll reads GET /v1/tasks/{id} ' +
            'with X-ModelScope-Task-Type: image_generation',
        }),
        text,
      );
    }

    let payload: ModelScopeSubmitResponse;
    try {
      payload = JSON.parse(text) as ModelScopeSubmitResponse;
    } catch {
      throw new ImageAdapterError(
        502,
        `${credentials.label} returned a non-JSON response.`,
        `non-JSON body: ${text.slice(0, 600)}`,
      );
    }
    if (!payload.task_id) {
      throw new ImageAdapterError(
        502,
        `${credentials.label} did not return a task id.`,
        `no task id in body: ${text.slice(0, 600)}`,
      );
    }
    return { taskId: payload.task_id };
  },

  async poll(taskId: string, { credentials }: AdapterContext): Promise<ImagePollResult> {
    const base = ensureV1(credentials.baseUrl);

    const upstream = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${credentials.apiKey ?? ''}`,
        'X-ModelScope-Task-Type': 'image_generation',
      },
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      throw new ImageAdapterError(
        upstream.status,
        formatRejection({
          label: credentials.label,
          status: upstream.status,
          bodyText: detail,
          request: `GET ${base}/tasks/${encodeURIComponent(taskId)} (task polling, X-ModelScope-Task-Type: image_generation)`,
          accepts: 'the task id returned by the submit call, with the async task headers above',
        }),
        detail,
      );
    }

    const data = (await upstream.json()) as ModelScopePollResponse;
    const status = data.task_status ?? 'UNKNOWN';
    const failure =
      status === 'FAILED'
        ? (data.error_message || data.message || data.error || data.logs || JSON.stringify(data))
        : undefined;

    return {
      status,
      images:
        status === 'SUCCEED'
          ? (data.output_images ?? []).map((url) => ({ kind: 'url' as const, url }))
          : [],
      error: failure,
      raw: data,
    };
  },
};
