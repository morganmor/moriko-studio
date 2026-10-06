/**
 * Human-readable upstream rejections.
 *
 * A raw provider error body (`{"error":{"message":"invalid request!","type":
 * "invalid_request_error",…}}`) is useless to a person. This module turns it
 * into a structured multi-line report the UI shows as-is:
 *
 *   My provider rejected the generation (HTTP 400).
 *   Provider said: "invalid request!" (invalid_request_error).
 *   We sent: POST https://…/v1/images/generations — model "seedream-5.0-lite",
 *   prompt 24 chars, n 1, no size parameter.
 *   This endpoint accepts: model, prompt, n, size "WxH" (…) — returns data[].url.
 *   Likely fix: …
 *
 * Every adapter composes the "We sent" and "accepts" lines from its own
 * contract, so the message states facts (what left the server, what the
 * adapter expects) instead of raw JSON.
 */

export interface ParsedUpstreamError {
  message?: string;
  type?: string;
  code?: string | number;
}

/**
 * Pulls the readable parts out of an error body. Handles the OpenAI shape
 * (`{error:{message,type,code}}`), plain `{message}`, FastAPI `{detail}`, a
 * string `error`, and finally short plain-text bodies.
 */
export function parseUpstreamError(bodyText: string): ParsedUpstreamError {
  const trimmed = (bodyText ?? '').trim();
  if (!trimmed) return {};

  let payload: unknown = null;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    payload = null;
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === 'object') {
      const err = nested as Record<string, unknown>;
      return {
        message: typeof err.message === 'string' && err.message.trim() ? err.message.trim() : undefined,
        type: typeof err.type === 'string' && err.type.trim() ? err.type.trim() : undefined,
        code:
          typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
      };
    }
    if (typeof nested === 'string' && nested.trim()) return { message: nested.trim() };
    if (typeof record.message === 'string' && record.message.trim())
      return { message: record.message.trim() };
    if (typeof record.detail === 'string' && record.detail.trim())
      return { message: record.detail.trim() };
  }

  const oneLine = trimmed.replace(/\s+/g, ' ');
  if (oneLine.length <= 200 && !oneLine.startsWith('<')) return { message: oneLine };
  return {};
}

/** Status-specific "likely fix" line, in plain language. */
export function statusHint(status: number): string {
  if (status === 400)
    return (
      'Likely fix: the request body does not match what this endpoint accepts. ' +
      'Try Size: Default (sends no size parameter), check the model id, or — for custom ' +
      'gateways — set Image adapter "declarative" with an imageConfig template in Provider settings.'
    );
  if (status === 401 || status === 403)
    return 'Likely fix: the API key was rejected — check it in Provider settings.';
  if (status === 404)
    return 'Likely fix: the path or the model id does not exist — check the Base URL (most OpenAI-shaped gateways need /v1) and the model name in Run settings.';
  if (status === 429) return 'Likely fix: rate limited — wait a moment and try again.';
  if (status >= 500) return 'Likely fix: the provider had an internal error — try again later.';
  return "Likely fix: check the provider's API documentation for the exact request format.";
}

/** Builds the full multi-line report. `request` is one line describing the
 * exact outgoing request; `accepts` is the adapter's contract summary. */
export function formatRejection(params: {
  label: string;
  status: number;
  bodyText: string;
  request: string;
  accepts: string;
}): string {
  const parsed = parseUpstreamError(params.bodyText);
  const said = parsed.message
    ? `"${parsed.message}"`
    : 'no readable message in the response body';
  const kind = parsed.type ? ` (${parsed.type})` : '';
  const code = parsed.code !== undefined ? ` [code ${parsed.code}]` : '';
  return [
    `${params.label} rejected the generation (HTTP ${params.status}).`,
    `Provider said: ${said}${kind}${code}.`,
    `We sent: ${params.request}`,
    `This endpoint accepts: ${params.accepts}.`,
    statusHint(params.status),
  ].join('\n');
}
