/**
 * OpenAI-compatible synchronous image adapter.
 *
 * Many gateways answer `POST /v1/images/generations` with the finished image
 * in the same response (`data[].url` or `data[].b64_json`) — no task to poll.
 * The client contract stays async, so this adapter wraps the synchronous call
 * in a server-side local job: `submit` returns a generated id immediately and
 * runs the upstream call in the background; `poll` reads the job's state.
 */

import { randomUUID } from 'node:crypto';

import {
  ensureV1,
  ImageAdapterError,
  type AdapterContext,
  type ImageAdapter,
  type ImagePollResult,
  type ImageSubmitRequest,
  type ImageCredentials,
  type NormalizedImage,
} from './types.js';
import { ratioToSize } from './ratio.js';
import { formatRejection } from './errorReport.js';

interface LocalJob {
  status: 'RUNNING' | 'SUCCEED' | 'FAILED';
  images: NormalizedImage[];
  error?: string;
  /** Non-fatal caveat for a successful generation (e.g. size was dropped). */
  note?: string;
  raw?: unknown;
}

/** Local job states live here (not in `imageTasks`) so sync execution owns them. */
const localJobs = new Map<string, LocalJob>();

function rememberJob(id: string, job: LocalJob): void {
  if (localJobs.size > 200) {
    const oldest = localJobs.keys().next().value;
    if (oldest) localJobs.delete(oldest);
  }
  localJobs.set(id, job);
}

/**
 * Known OpenAI image sizes mapped from our aspect-ratio presets. Ratios with
 * no safe mapping are omitted rather than guessed — the provider default
 * applies.
 */
const RATIO_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
};

interface OpenAiImagesResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}

/** What this adapter's contract says the endpoint accepts — quoted verbatim
 * in rejection reports so the user sees the expected configuration. */
const ACCEPTED_CONTRACT =
  'model, prompt, n (image count), size "WxH" (optional — some OpenAI-compatible ' +
  'gateways, e.g. BitDeer, reject size with HTTP 400 invalid request, in which case ' +
  'Moriko retries with the minimal body and the provider default applies) — response ' +
  'returns data[].url or data[].b64_json';

/** The two request shapes the adapter tries, in order. Gateways vary in how
 * strictly they validate optional parameters (BitDeer rejects `size` with
 * 400), so a 400 falls back to the minimal proven body instead of failing
 * the generation outright. */
function attemptBodies(req: ImageSubmitRequest): Array<{ label: string; body: Record<string, unknown> }> {
  const size =
    req.width && req.height
      ? `${req.width}x${req.height}`
      : req.aspectRatio
        ? (RATIO_TO_SIZE[req.aspectRatio] ?? ratioToSize(req.aspectRatio) ?? undefined)
        : undefined;
  const attempts: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: 'full request (model, prompt, n' + (size ? ', size)' : ')'),
      body: { model: req.model, prompt: req.prompt, n: 1, ...(size ? { size } : {}) },
    },
    {
      label: 'minimal fallback (model, prompt only — no optional parameters)',
      body: { model: req.model, prompt: req.prompt },
    },
  ];
  return attempts;
}

async function execute(
  localId: string,
  req: ImageSubmitRequest,
  credentials: ImageCredentials,
): Promise<void> {
  const job = localJobs.get(localId);
  if (!job) return;

  const base = ensureV1(credentials.baseUrl);
  const url = `${base}/images/generations`;
  const sizeDesc =
    req.width && req.height
      ? `size "${req.width}x${req.height}"`
      : req.aspectRatio
        ? `size from preset ${req.aspectRatio}`
        : 'no size parameter (Size: Default)';

  let lastStatus = 0;
  let lastText = '';
  let fellBack = false;

  try {
    for (const [index, attempt] of attemptBodies(req).entries()) {
      if (index > 0) fellBack = true;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiKey ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(attempt.body),
      });
      const text = await upstream.text();

      if (upstream.ok) {
        let payload: OpenAiImagesResponse;
        try {
          payload = JSON.parse(text) as OpenAiImagesResponse;
        } catch {
          throw new ImageAdapterError(
            502,
            `${credentials.label} returned a non-JSON response.`,
            `non-JSON body: ${text.slice(0, 600)}`,
          );
        }
        const images: NormalizedImage[] = (payload.data ?? [])
          .map((entry): NormalizedImage | null =>
            entry.url
              ? { kind: 'url', url: entry.url }
              : entry.b64_json
                ? { kind: 'b64', data: entry.b64_json }
                : null,
          )
          .filter((entry): entry is NormalizedImage => entry !== null);
        if (images.length === 0) {
          throw new ImageAdapterError(
            502,
            `${credentials.label} returned no image data.`,
            `no images in body: ${text.slice(0, 600)}`,
          );
        }

        job.images = images;
        job.raw = payload;
        job.status = 'SUCCEED';
        if (fellBack) {
          job.note =
            'This provider rejected the size parameter (HTTP 400), so the generation was retried without it — the image uses the provider\'s default size. Leave Size: Default for this provider, or use a provider that accepts size.';
        }
        return;
      }

      lastStatus = upstream.status;
      lastText = text;
      if (upstream.status !== 400) break;
    }

    throw new ImageAdapterError(
      lastStatus || 502,
      formatRejection({
        label: credentials.label,
        status: lastStatus || 502,
        bodyText: lastText,
        request:
          `POST ${url} — model "${req.model}", prompt ${req.prompt.length} chars, ${sizeDesc}` +
          (fellBack ? ' — retried with the minimal request (model + prompt only) and still rejected' : ''),
        accepts: ACCEPTED_CONTRACT,
      }),
      lastText,
    );
  } catch (error) {
    job.status = 'FAILED';
    job.error = error instanceof Error ? error.message : 'Generation failed.';
    job.raw = error instanceof ImageAdapterError ? error.upstreamBody : undefined;
  }
}

export const openaiSyncAdapter: ImageAdapter = {
  id: 'openai-sync',
  capabilities: {
    execution: 'sync',
    sizeParam: 'size',
    resultFormat: 'both',
    maxImages: 1,
    supportsNegativePrompt: false,
    // POST /images/generations carries no image input in the OpenAI spec —
    // this adapter puts references on NO wire, so the composer warns before
    // sending (capability is ours to declare, not HF's to guess).
    maxReferences: 0,
  },

  async submit(
    req: ImageSubmitRequest,
    { credentials }: AdapterContext,
  ): Promise<{ taskId: string }> {
    const localId = randomUUID();
    rememberJob(localId, { status: 'RUNNING', images: [] });
    void execute(localId, req, credentials).catch(() => {
    });
    return { taskId: localId };
  },

  async poll(taskId: string): Promise<ImagePollResult> {
    const job = localJobs.get(taskId);
    if (!job) {
      throw new ImageAdapterError(
        404,
        'Unknown image task — it may have finished or the server restarted. Submit again.',
      );
    }
    return { status: job.status, images: job.images, error: job.error, note: job.note, raw: job.raw };
  },
};
