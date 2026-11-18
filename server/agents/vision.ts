

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deadline } from '../liveness.js';

export interface VisionConfig {
  
  providerId: string;
  
  model: string;
  
  apiKey?: string;
  
  baseUrl?: string;
}

export interface VisionRequest {
  
  buffer: Buffer;
  mime: string;
  
  question: string;
}

export interface VisionResult {
  ok: boolean;
  
  text: string;
  
  by: string;
}


const MAX_IMAGE_BYTES = 20_000_000;

const MAX_ANSWER_CHARS = Infinity;

const VISION_TIMEOUT_MS = 90_000;

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
]);


export async function resolveImageSource(
  input: string,
  fetchPublicBuffer: (url: string) => Promise<{ buffer: Buffer; contentType: string }>,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('data:')) {
    const comma = trimmed.indexOf(',');
    if (comma < 0) return null;
    const header = trimmed.slice(0, comma);
    const mime = /data:([^;,]+)/.exec(header)?.[1] || 'image/png';
    if (!mime.startsWith('image/')) return null;
    return { buffer: Buffer.from(trimmed.slice(comma + 1), 'base64'), mime };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const { buffer, contentType } = await fetchPublicBuffer(trimmed);
    if (!contentType.startsWith('image/')) return null;
    return { buffer, mime: contentType };
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  const buffer = readFileSync(trimmed);
  const mime = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg'
    : ext === '.tif' || ext === '.tiff'
      ? 'image/tiff'
      : `image/${ext.slice(1)}`;
  return { buffer, mime };
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

const DEFAULT_QUESTION =
  'Describe this image in detail: what it shows, any text visible, layout, colors, and anything notable.';

function buildVisionBody(config: VisionConfig, request: VisionRequest): Record<string, unknown> {
  const dataUrl = `data:${request.mime};base64,${request.buffer.toString('base64')}`;
  return {
    model: config.model,
    stream: false,
    max_tokens: 64_000,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: request.question || DEFAULT_QUESTION },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };
}


export async function callVisionModel(
  config: VisionConfig,
  request: VisionRequest,
  resolveCredentials: (providerId: string, browserKey?: string) => Promise<{
    kind: string;
    baseUrl: string;
    apiKey?: string;
  }>,
): Promise<VisionResult> {
  if (!isImageMime(request.mime)) {
    throw new Error(`Not an image (got ${request.mime}) — vision accepts image files only.`);
  }
  if (request.buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is ${(request.buffer.byteLength / 1_000_000).toFixed(1)} MB — above the ${MAX_IMAGE_BYTES / 1_000_000} MB vision cap.`,
    );
  }

  const credentials = await resolveCredentials(config.providerId, config.apiKey);
  const baseUrl = (config.baseUrl && config.baseUrl.trim()) || credentials.baseUrl;
  const base = baseUrl.replace(/\/+$/, '');

  const bound = deadline(undefined, VISION_TIMEOUT_MS, 'VISION_TIMEOUT');
  try {
    if (credentials.kind === 'gemini') {
      const endpoint = `${base}/models/${encodeURIComponent(config.model)}:generateContent`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(credentials.apiKey ? { 'x-goog-api-key': credentials.apiKey } : {}),
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: request.question || DEFAULT_QUESTION },
                { inlineData: { mimeType: request.mime, data: request.buffer.toString('base64') } },
              ],
            },
          ],
        }),
        signal: bound.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const snippet = detail.slice(0, 400).replace(/\s+/g, ' ').trim();
        throw new Error(
          `Vision model ${config.model} answered HTTP ${response.status} at ${endpoint}` +
            (snippet ? `: ${snippet}` : '. Check the model id and key.'),
        );
      }

      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('\n')
        .trim();

      if (!text) throw new Error(`Vision model ${config.model} returned an empty answer.`);

      return {
        ok: true,
        by: `${config.providerId}/${config.model}`,
        text: text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}\n\n…(description capped at ${MAX_ANSWER_CHARS} chars)` : text,
      };
    }

    const endpoint = `${base}/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
      },
      body: JSON.stringify(buildVisionBody(config, request)),
      signal: bound.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const snippet = detail.slice(0, 400).replace(/\s+/g, ' ').trim();
      throw new Error(
        `Vision model ${config.model} answered HTTP ${response.status} at ${endpoint}` +
          (snippet ? `: ${snippet}` : '. Check the model id and key.'),
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };

    const answer = payload.choices?.[0]?.message?.content;
    const text = typeof answer === 'string'
      ? answer
      : Array.isArray(answer)
        ? answer
            .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
            .join('\n')
            .trim()
        : '';

    if (!text) {
      throw new Error(`Vision model ${config.model} returned an empty answer.`);
    }

    return {
      ok: true,
      by: `${config.providerId}/${config.model}`,
      text: text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}\n\n…(description capped at ${MAX_ANSWER_CHARS} chars)` : text,
    };
  } finally {
    bound.clear();
  }
}
