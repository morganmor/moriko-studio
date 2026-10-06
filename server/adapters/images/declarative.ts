/**
 * Config-driven adapter for "long-tail" providers whose APIs fit the
 * submit → poll pattern but use their own paths, field names, and status
 * vocabularies. Adding one requires zero code — just an `imageConfig` on the
 * provider record:
 *
 * ```json
 * {
 *   "imageAdapter": "declarative",
 *   "imageConfig": {
 *     "submit": {
 *       "path": "/gen/start",
 *       "body": { "model": "{model}", "text": "{prompt}", "ratio": "{aspect_ratio}" },
 *       "taskIdPath": "result.uid"
 *     },
 *     "poll": {
 *       "path": "/gen/check?id={taskId}",
 *       "statusPath": "state",
 *       "imagesPath": "frames[*].link",
 *       "successValue": "DONE_OK",
 *       "failedValue": "DONE_BAD",
 *       "errorPath": "why"
 *     }
 *   }
 * }
 * ```
 *
 * Placeholders: `{model}`, `{prompt}`, `{aspect_ratio}`, `{width}`, `{height}`,
 * `{size}` (as `WxH`), `{negative_prompt}` (always '' until the client sends
 * one), `{taskId}` in poll paths. Paths are dot-paths with bracket wildcards:
 * `frames[*].link`. Result entries may be http(s) URLs, `data:image/...`
 * URIs, or bare base64 — everything is normalized to local files.
 */

import {
  ImageAdapterError,
  type AdapterContext,
  type ImageAdapter,
  type ImageCapabilities,
  type ImagePollResult,
  type ImageSubmitRequest,
  type NormalizedImage,
} from './types.js';
import { formatRejection } from './errorReport.js';

export interface DeclarativeImageConfig {
  /** `bearer` (default) sends `Authorization: Bearer <key>`; `none` omits it. */
  auth?: 'bearer' | 'none';
  /** Expected number of images per request (documentational + UI hint). */
  maxImages?: number;
  submit: {
    path: string;
    method?: string;
    /** Request body template; `{placeholder}` tokens are substituted. */
    body?: Record<string, unknown>;
    taskIdPath: string;
    /** Header templates; `{placeholder}` tokens are substituted too. */
    extraHeaders?: Record<string, string>;
  };
  poll: {
    /** Path template; `{taskId}` is substituted. */
    path: string;
    extraHeaders?: Record<string, string>;
    /** Dot-path of the status field. Default: `status`. */
    statusPath?: string;
    /** Dot-path (wildcards allowed) of finished image URLs / base64. Required. */
    imagesPath: string;
    /** Dot-path of a human-readable failure reason. */
    errorPath?: string;
    /** Provider's terminal status values. Defaults: `SUCCEED` / `FAILED`. */
    successValue?: string;
    failedValue?: string;
  };
  sizeParam?: ImageCapabilities['sizeParam'];
}

/**
 * Tokenizes a dot/bracket path: `frames[*].link` → ['frames', '*', 'link'],
 * `output.images[0].url` → ['output', 'images', '0', 'url']. A plain
 * `.split('.')` would NOT split around brackets — `frames[*]` would stay one
 * token and never match a real key.
 */
function tokenizePath(path: string): string[] {
  const tokens: string[] = [];
  for (const match of path.matchAll(/([^[.\]]+)|\[\s*\*\s*\]|\[\s*(\d+)\s*\]/g)) {
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(match[2]);
    else tokens.push('*');
  }
  return tokens;
}

/** Reads a dot/bracket path with optional `*` fan-out; undefined when absent. */
function getByPath(value: unknown, path: string): unknown {
  const walk = (current: unknown, segments: string[]): unknown => {
    if (segments.length === 0) return current;
    const [head, ...rest] = segments;
    if (head === '*') {
      if (!Array.isArray(current)) return undefined;
      return current.map((item) => walk(item, rest)).flat();
    }
    if (current == null || typeof current !== 'object') return undefined;
    const record = current as Record<string, unknown>;
    return walk(record[head], rest);
  };
  return walk(value, tokenizePath(path));
}

/** Substitutes `{placeholder}` tokens in every string of a JSON template.
 * Known placeholders that are unset render as '' (e.g. no aspect ratio
 * requested); unknown tokens are left untouched for the provider to judge. */
function renderTemplate(value: unknown, vars: Record<string, string | number | undefined>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (!(key in vars)) return match;
      const replacement = vars[key];
      return replacement === undefined ? '' : String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, vars));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderTemplate(item, vars),
      ]),
    );
  }
  return value;
}

/** Classifies one result entry: http(s) URL → download; `data:image/...`
 * URI or a bare base64 payload → inline bytes. Anything else is skipped. */
function toNormalizedImage(entry: unknown): NormalizedImage | undefined {
  if (typeof entry !== 'string') return undefined;
  const value = entry.trim();
  if (!value) return undefined;
  if (/^https?:\/\//.test(value)) return { kind: 'url', url: value };
  const dataUri = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (dataUri) return { kind: 'b64', data: dataUri[1] };
  if (value.length > 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    return { kind: 'b64', data: value };
  }
  return undefined;
}

export function createDeclarativeAdapter(config: DeclarativeImageConfig): ImageAdapter {
  if (!config?.submit?.path || !config.submit.taskIdPath) {
    throw new Error('declarative imageAdapter requires imageConfig.submit.path and submit.taskIdPath.');
  }
  if (!config.poll?.path || !config.poll.imagesPath) {
    throw new Error('declarative imageAdapter requires imageConfig.poll.path and poll.imagesPath.');
  }

  const successValue = config.poll.successValue ?? 'SUCCEED';
  const failedValue = config.poll.failedValue ?? 'FAILED';

  return {
    id: 'declarative',
    capabilities: {
      execution: 'async',
      sizeParam: config.sizeParam ?? 'none',
      resultFormat: 'both',
      maxImages: Math.max(1, Math.floor(config.maxImages ?? 1)),
      supportsNegativePrompt: false,
      // No reference-field mapping in the declarative config → cannot carry.
      maxReferences: 0,
    },

    async submit(
      req: ImageSubmitRequest,
      { credentials }: AdapterContext,
    ): Promise<{ taskId: string }> {
      const vars: Record<string, string | number | undefined> = {
        model: req.model,
        prompt: req.prompt,
        aspect_ratio: req.aspectRatio,
        width: req.width,
        height: req.height,
        size: req.width && req.height ? `${req.width}x${req.height}` : undefined,
        negative_prompt: undefined,
      };
      const bodyJson = JSON.stringify(renderTemplate(config.submit.body ?? {}, vars));
      const url = `${credentials.baseUrl.replace(/\/+$/, '')}${config.submit.path}`;
      const upstream = await fetch(url, {
        method: config.submit.method ?? 'POST',
        headers: {
          ...(config.auth === 'none' ? {} : { Authorization: `Bearer ${credentials.apiKey ?? ''}` }),
          'Content-Type': 'application/json',
          ...(renderTemplate(config.submit.extraHeaders ?? {}, vars) as Record<string, string>),
        },
        body: bodyJson,
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        throw new ImageAdapterError(
          upstream.status,
          formatRejection({
            label: credentials.label,
            status: upstream.status,
            bodyText: text,
            request: `${config.submit.method ?? 'POST'} ${url} — body ${bodyJson.slice(0, 160)}`,
            accepts:
              `whatever your imageConfig declares — submit ${config.submit.path}, body template ` +
              `${JSON.stringify(config.submit.body ?? {}).slice(0, 140)} — placeholders: ` +
              '{model} {prompt} {aspect_ratio} {width} {height} {size} {negative_prompt} ' +
              '(unset placeholders render as empty strings)',
          }),
          text,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ImageAdapterError(
          502,
          `${credentials.label} returned a non-JSON response.`,
          `non-JSON body: ${text.slice(0, 600)}`,
        );
      }
      const taskId = getByPath(payload, config.submit.taskIdPath);
      if (typeof taskId !== 'string' || !taskId.trim()) {
        throw new ImageAdapterError(
          502,
          `${credentials.label} did not return a task id.`,
          `no task id at "${config.submit.taskIdPath}": ${text.slice(0, 600)}`,
        );
      }
      return { taskId };
    },

    async poll(taskId: string, { credentials }: AdapterContext): Promise<ImagePollResult> {
      const path = config.poll.path.replace(/\{taskId\}/g, encodeURIComponent(taskId));
      const upstream = await fetch(`${credentials.baseUrl.replace(/\/+$/, '')}${path}`, {
        headers: {
          ...(config.auth === 'none' ? {} : { Authorization: `Bearer ${credentials.apiKey ?? ''}` }),
          ...(renderTemplate(config.poll.extraHeaders ?? {}, { taskId }) as Record<string, string>),
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
            request: `${config.poll.path.replace(/\{taskId\}/g, taskId)} (task polling per your imageConfig)`,
            accepts: 'the poll path, status/images/error paths, and status values from your imageConfig',
          }),
          detail,
        );
      }

      const payload: unknown = await upstream.json();
      const providerStatus = getByPath(payload, config.poll.statusPath ?? 'status');
      const rawStatus =
        providerStatus === undefined || providerStatus === null ? 'UNKNOWN' : String(providerStatus);

      let error: string | undefined;
      if (rawStatus === failedValue) {
        const rawError = config.poll.errorPath
          ? getByPath(payload, config.poll.errorPath)
          : undefined;
        error = rawError ? String(rawError) : JSON.stringify(payload);
      }

      const status: ImagePollResult['status'] =
        rawStatus === successValue ? 'SUCCEED' : rawStatus === failedValue ? 'FAILED' : 'RUNNING';

      const images: ImagePollResult['images'] = [];
      if (status === 'SUCCEED') {
        const found = getByPath(payload, config.poll.imagesPath);
        const list = Array.isArray(found) ? found : found !== undefined ? [found] : [];
        for (const entry of list) {
          const normalized = toNormalizedImage(entry);
          if (normalized) images.push(normalized);
        }
      }

      return { status, providerStatus: rawStatus, images, error, raw: payload };
    },
  };
}
