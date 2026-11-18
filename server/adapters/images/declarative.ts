

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
  
  auth?: 'bearer' | 'none';
  
  maxImages?: number;
  submit: {
    path: string;
    method?: string;
    
    body?: Record<string, unknown>;
    taskIdPath: string;
    
    extraHeaders?: Record<string, string>;
  };
  poll: {
    
    path: string;
    extraHeaders?: Record<string, string>;
    
    statusPath?: string;
    
    imagesPath: string;
    
    errorPath?: string;
    
    successValue?: string;
    failedValue?: string;
  };
  sizeParam?: ImageCapabilities['sizeParam'];
}


function tokenizePath(path: string): string[] {
  const tokens: string[] = [];
  for (const match of path.matchAll(/([^[.\]]+)|\[\s*\*\s*\]|\[\s*(\d+)\s*\]/g)) {
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(match[2]);
    else tokens.push('*');
  }
  return tokens;
}


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
