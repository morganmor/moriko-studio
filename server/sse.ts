import type { HarnessInjection } from './agents/systemPrompt.js';
import type { ChatMessage, ChatSettingsDTO, StreamEvent } from './contracts.js';

export interface StreamParams {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  messages: ChatMessage[];
  settings: ChatSettingsDTO;
  providerId: string;
  signal: AbortSignal;
  /**
   * Harness-injected system prompt blocks (agent tools, MCP tools, …). The
   * route builds them once, streams each to the UI, and adapters append
   * their content to the system message. Empty for plain chat.
   */
  harnessInjections: HarnessInjection[];
  /** Conversation id — keys session-scoped harness state (goals). */
  sessionId?: string;
  /**
   * The model's context window (tokens, models.dev snapshot) — drives the
   * tool loop's context-budget stop. Null/absent = unknown, budget stop off.
   */
  contextLimit?: number | null;
  /**
   * Attachment paths persisted THIS request (see server/attachments.ts),
   * relative to the active workspace root. The agent-harness injection turns
   * them into instructions the model can act on immediately.
   */
  attachmentPaths?: string[];
}

export type StreamHandler = (event: StreamEvent) => void;

/** Raised for expected upstream failures so the route can emit a clean error event. */
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

/**
 * Reads a `text/event-stream` response and yields each `data:` payload.
 * Handles CRLF, multi-line data fields, and chunk boundaries that split an event.
 */
export async function* iterateSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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

/** Turns a non-2xx upstream response into an UpstreamError with a readable detail. */
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
