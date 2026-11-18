import type { HarnessInjection } from './agents/systemPrompt.js';
import type { ChatMessage, ChatSettingsDTO, StreamEvent } from './contracts.js';
import type { ResolvedModelCapability } from './modelCapability.js';

export interface StreamParams {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  messages: ChatMessage[];
  settings: ChatSettingsDTO;
  providerId: string;
  signal: AbortSignal;
  
  harnessInjections: HarnessInjection[];
  
  sessionId?: string;
  
  contextLimit?: number | null;
  
  compactGuard?: {
    autoCompact: boolean;
    compactThresholdTokens: number | null;
    compactThresholdRatio: number;
    maxContextTokens?: number | null;
    
    conversationId?: string;
  };
  
  capability?: ResolvedModelCapability;
  
  attachmentPaths?: string[];
}

export type StreamHandler = (event: StreamEvent) => void;


export class UpstreamError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.detail = detail;
  }
}


export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + buffer.slice(boundary).match(/^\r?\n\r?\n/)![0].length);

        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (data) yield data;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }

    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}


export async function assertOk(response: Response, providerLabel: string): Promise<void> {
  if (response.ok) return;

  let detail = '';
  try {
    detail = (await response.text()).slice(0, 1200);
  } catch {
    detail = '<no response body>';
  }

  let message = `${providerLabel} returned HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } | string; message?: string };
    const nested = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    const resolved = nested ?? parsed.message;
    if (resolved) message = resolved;
  } catch {
  }

  throw new UpstreamError(message, response.status, detail);
}
