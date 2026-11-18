

import { randomUUID } from 'node:crypto';

import {
  ImageAdapterError,
  type AdapterContext,
  type ImageAdapter,
  type ImagePollResult,
  type ImageSubmitRequest,
  type ImageCredentials,
  type NormalizedImage,
} from './types.js';

interface LocalJob {
  status: 'RUNNING' | 'SUCCEED' | 'FAILED';
  images: NormalizedImage[];
  error?: string;
  note?: string;
  raw?: unknown;
}

const localJobs = new Map<string, LocalJob>();

function rememberJob(id: string, job: LocalJob): void {
  if (localJobs.size > 200) {
    const oldest = localJobs.keys().next().value;
    if (oldest) localJobs.delete(oldest);
  }
  localJobs.set(id, job);
}


const SUPPORTED_RATIOS = new Set([
  '1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4',
  '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);


function imageSizeFor(width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined;
  const long = Math.max(width, height);
  if (long <= 512) return '512';
  if (long <= 1024) return '1K';
  if (long <= 2048) return '2K';
  return '4K';
}


function toInlineData(dataUrl: string): { inlineData: { mimeType: string; data: string } } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

interface GeminiImagePart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiImageResponse {
  candidates?: Array<{
    content?: { parts?: GeminiImagePart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

const ACCEPTED_CONTRACT =
  'model, contents[].parts[] (text prompt + optional inlineData reference images), ' +
  'generationConfig.responseModalities ["TEXT","IMAGE"], ' +
  'generationConfig.imageConfig.aspectRatio (1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9) ' +
  'and imageConfig.imageSize (512, 1K, 2K, 4K) — response returns inlineData base64 parts';

async function execute(
  localId: string,
  req: ImageSubmitRequest,
  credentials: ImageCredentials,
): Promise<void> {
  const job = localJobs.get(localId);
  if (!job) return;

  const base = credentials.baseUrl.replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(req.model)}:generateContent`;

  const parts: unknown[] = [{ text: req.prompt }];
  let droppedReferences = 0;
  for (const reference of req.images ?? []) {
    const inline = toInlineData(reference);
    if (inline) parts.push(inline);
    else droppedReferences += 1;
  }

  const aspectRatio =
    req.aspectRatio && SUPPORTED_RATIOS.has(req.aspectRatio)
      ? req.aspectRatio
      : req.width && req.height
        ? undefined
        : undefined;
  const imageSize = imageSizeFor(req.width, req.height);

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(aspectRatio || imageSize
        ? {
            imageConfig: {
              ...(aspectRatio ? { aspectRatio } : {}),
              ...(imageSize ? { imageSize } : {}),
            },
          }
        : {}),
    },
  };

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(credentials.apiKey ? { 'x-goog-api-key': credentials.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await upstream.text();

    if (!upstream.ok) {
      throw new ImageAdapterError(
        upstream.status,
        `${credentials.label} rejected the image request (HTTP ${upstream.status}): ` +
          text.slice(0, 600).replace(/\s+/g, ' ').trim(),
        text,
      );
    }

    let payload: GeminiImageResponse;
    try {
      payload = JSON.parse(text) as GeminiImageResponse;
    } catch {
      throw new ImageAdapterError(
        502,
        `${credentials.label} returned a non-JSON response.`,
        `non-JSON body: ${text.slice(0, 600)}`,
      );
    }

    if (payload.promptFeedback?.blockReason) {
      throw new ImageAdapterError(
        400,
        `${credentials.label} blocked the prompt (${payload.promptFeedback.blockReason}).`,
        text,
      );
    }

    const images: NormalizedImage[] = [];
    for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        images.push({ kind: 'b64', data: `data:${part.inlineData.mimeType ?? 'image/png'};base64,${part.inlineData.data}` });
      }
    }

    if (images.length === 0) {
      throw new ImageAdapterError(
        502,
        `${credentials.label} returned no image. ${ACCEPTED_CONTRACT}`,
        `no inlineData in body: ${text.slice(0, 600)}`,
      );
    }

    job.images = images;
    job.raw = payload;
    job.status = 'SUCCEED';
    if (droppedReferences > 0) {
      job.note = `${droppedReferences} reference image(s) could not be decoded and were not sent.`;
    }
  } catch (error) {
    job.status = 'FAILED';
    job.error = error instanceof Error ? error.message : 'Generation failed.';
    job.raw = error instanceof ImageAdapterError ? error.upstreamBody : undefined;
  }
}

export const geminiImageAdapter: ImageAdapter = {
  id: 'gemini-native',
  capabilities: {
    execution: 'sync',
    sizeParam: 'aspect_ratio',
    resultFormat: 'b64',
    maxImages: 1,
    supportsNegativePrompt: false,
    maxReferences: 8,
  },

  async submit(req: ImageSubmitRequest, { credentials }: AdapterContext): Promise<{ taskId: string }> {
    const localId = randomUUID();
    rememberJob(localId, { status: 'RUNNING', images: [] });
    void execute(localId, req, credentials).catch(() => {});
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
