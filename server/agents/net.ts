import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { deadline, isAbortLike } from '../liveness.js';

/**
 * NETWORK GATE for internet-capable harness tools (fetch, download).
 *
 * The agent may read PUBLIC http(s) resources — nothing else. The gate:
 *  - only http/https on ports 80/443;
 *  - blocks loopback, private, link-local and cloud-metadata targets by
 *    IP — checked BOTH on the literal host and on the DNS resolution
 *    result (anti DNS-rebinding: resolve first, connect to the resolved
 *    IP, never re-resolve);
 *  - bounds every transfer: redirects (≤5), wall time (≤30s) and bytes.
 *
 * All limits are deliberately strict; the agent reads reference material,
 * it does not crawl.
 */

const MAX_REDIRECTS = 5;
const NET_TIMEOUT_MS = 30_000;
const MAX_NET_BYTES = 20_000_000;
const FETCH_TEXT_LIMIT = 240_000;

export class NetBlockedError extends Error {}

function assertPublicIp(ip: string, host: string): void {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (ip.endsWith('.0') || ip.endsWith('.2'))) ||
      a >= 224;
    if (blocked) throw new NetBlockedError(`Blocked: "${host}" resolves to a private/reserved address (${ip}).`);
    return;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const blocked =
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fe80') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:169.254') ||
      lower.startsWith('::ffff:192.168');
    if (blocked) throw new NetBlockedError(`Blocked: "${host}" resolves to a private/reserved address (${ip}).`);
  }
}

function assertLiteralHost(host: string): void {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare) || net.isIPv6(bare)) assertPublicIp(bare, host);
}

/** Validates the URL and resolves the host, rejecting private targets. */
async function resolveTarget(rawUrl: string): Promise<{ url: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetBlockedError(`Only http(s) URLs are allowed (got ${url.protocol}).`);
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) {
    throw new NetBlockedError(`Only ports 80 and 443 are allowed (got ${port}).`);
  }
  const host = url.hostname;
  if (!host) throw new Error('URL has no host.');
  assertLiteralHost(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new NetBlockedError(`Blocked: "${host}" is a local hostname.`);
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    throw new Error(`DNS lookup failed for "${host}": ${error instanceof Error ? error.message : 'error'}`);
  }
  if (addresses.length === 0) throw new Error(`DNS lookup returned no addresses for "${host}".`);
  for (const entry of addresses) assertPublicIp(entry.address, host);
  return { url };
}

export interface NetResult {
  status: number;
  contentType: string;
  finalUrl: string;
  /** Response body, hard-capped at MAX_NET_BYTES. */
  buffer: Buffer;
}

/**
 * Performs a bounded GET. Redirects are followed (re-validated through the
 * gate every hop); the response body streams into a hard byte cap.
 */
export async function boundedGet(rawUrl: string): Promise<NetResult> {
  let currentUrl = rawUrl.trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { url } = await resolveTarget(currentUrl);
    const bound = deadline(undefined, NET_TIMEOUT_MS, 'NET_FETCH_TIMEOUT');
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: bound.signal,
        headers: {
          'user-agent': 'MorikoStudio-Agent/1.0 (+local harness; reference fetching)',
          accept: '*/*',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error(`Redirect ${response.status} without a Location header.`);
        if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`);
        currentUrl = new URL(location, url).toString();
        continue;
      }
      const reader = response.body?.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_NET_BYTES) {
            void reader.cancel();
            throw new Error(`Response exceeds the ${Math.round(MAX_NET_BYTES / 1_000_000)} MB cap.`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      await resolveTarget(url.toString());
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        finalUrl: url.toString(),
        buffer: Buffer.concat(chunks),
      };
    } catch (error) {
      if (error instanceof NetBlockedError) throw error;
      if (isAbortLike(error)) {
        throw new Error(`Request timed out after ${NET_TIMEOUT_MS / 1000}s.`);
      }
      throw error;
    } finally {
      bound.clear();
    }
  }
  throw new Error('unreachable');
}

/** GET + text extraction for agent__fetch. */
export async function fetchText(
  rawUrl: string,
  format: 'text' | 'html' | 'markdown',
): Promise<{ text: string; status: number; contentType: string; finalUrl: string; bytes: number }> {
  const result = await boundedGet(rawUrl);
  const raw = result.buffer.toString('utf8');
  const looksBinary = result.contentType.startsWith('image/') ||
    result.contentType.startsWith('audio/') ||
    result.contentType.startsWith('video/') ||
    result.contentType.includes('octet-stream') ||
    /\u0000/.test(raw.slice(0, 2000));
  if (looksBinary) {
    throw new Error(`"${result.finalUrl}" is binary (${result.contentType}) — use agent__download for files.`);
  }
  let text: string;
  if (format === 'html') {
    text = raw;
  } else {
    text = htmlToReadable(raw, format === 'markdown');
  }
  const truncated = text.length > FETCH_TEXT_LIMIT;
  if (truncated) text = text.slice(0, FETCH_TEXT_LIMIT);
  return {
    text: truncated ? `${text}\n…(truncated at ${FETCH_TEXT_LIMIT} chars)` : text,
    status: result.status,
    contentType: result.contentType,
    finalUrl: result.finalUrl,
    bytes: result.buffer.byteLength,
  };
}

/** Strips scripts/styles/tags into readable text (or light markdown). */
export function htmlToReadable(html: string, markdown: boolean): string {
  let working = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  if (markdown) {
    working = working
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `${inner.trim()} (${href})`)
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner.trim()}\n\n`)
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner.trim()}`)
      .replace(/<\/(p|div|section|article|tr|h[1-6])>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n');
  }
  working = working
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
  return working.trim();
}
