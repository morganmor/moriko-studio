import type { ChatMessage } from './contracts.js';
import { deadline, isAbortLike } from './liveness.js';

/**
 * Built-in Fetch Web tool.
 *
 * When enabled, the LOCAL PROXY scans the newest user message for URLs,
 * downloads each page, strips it to readable text, and appends the content
 * to that message's wire payload. The stored conversation never changes —
 * the injected text exists only on the request to the provider, so the chat
 * history stays clean while every model (not just tool-aware ones) can read
 * the page.
 *
 * Safety rails: http/https only, private/loopback hosts are refused
 * (a user-pasted link must never be able to probe the local network),
 * 15 s timeout, 512 KB download cap, 12 k chars injected per page,
 * at most 3 links per message. Fetch failures degrade to a short note
 * instead of failing the whole generation.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MAX_LINKS_PER_MESSAGE = 3;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/** Hosts a pasted link should never reach: loopback and RFC1918/link-local. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd')) return true;
  const v4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = v4 ? v4[1] : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipv4)) {
    const [a, b] = ipv4.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export interface UrlScan {
  /** URLs the fetch may attempt. */
  allowed: string[];
  /** URLs refused by the safety gate — reported EXPLICITLY so the model
   *  learns a fetch was blocked instead of hallucinating the page content. */
  blocked: Array<{ url: string; reason: string }>;
}

export function extractUrls(text: string): UrlScan {
  const matches = text.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const seenBlocked = new Set<string>();
  const allowed: string[] = [];
  const blocked: Array<{ url: string; reason: string }> = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:]+$/, '');
    try {
      const url = new URL(cleaned);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (isPrivateHost(url.hostname)) {
        const key = url.toString();
        if (!seenBlocked.has(key)) {
          seenBlocked.add(key);
          blocked.push({
            url: key,
            reason: 'private/loopback target is refused by the Fetch Web safety gate',
          });
        }
        continue;
      }
      const key = url.toString();
      if (!seen.has(key)) {
        seen.add(key);
        allowed.push(key);
      }
    } catch {
    }
  }
  return {
    allowed: allowed.slice(0, MAX_LINKS_PER_MESSAGE),
    blocked: blocked.slice(0, MAX_LINKS_PER_MESSAGE),
  };
}

/** Strips HTML down to readable text without pulling in a DOM dependency. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return num > 31 && num < 65536 ? String.fromCodePoint(num) : ' ';
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Downloads one page and returns its text, or a short failure reason. */
async function fetchPageText(url: string): Promise<string> {
  const bound = deadline(undefined, FETCH_TIMEOUT_MS, 'WEB_FETCH_TIMEOUT');
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: bound.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; MorikoStudio/1.0; +local proxy Fetch Web)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    if (!response.ok) return `[Fetch failed: ${url} — HTTP ${response.status}]`;

    const contentType = response.headers.get('content-type') ?? '';
    const buffer = await response.arrayBuffer();
    const clipped = buffer.byteLength > MAX_DOWNLOAD_BYTES
      ? new Uint8Array(buffer).slice(0, MAX_DOWNLOAD_BYTES)
      : new Uint8Array(buffer);
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(clipped);

    const text = contentType.includes('html') || /<html|<body|<div\b/i.test(raw)
      ? htmlToText(raw)
      : raw;
    if (!text.trim()) return `[Fetch failed: ${url} — the page has no readable text]`;
    const trimmed = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[…truncated]` : text;
    return `[Content of ${url}]\n${trimmed}\n[/Content of ${url}]`;
  } catch (error) {
    const reason = isAbortLike(error)
      ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
      : error instanceof Error
        ? error.message
        : 'request failed';
    return `[Fetch failed: ${url} — ${reason}]`;
  } finally {
    bound.clear();
  }
}

/** The text of one message, whatever shape the wire content takes. */
function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

/**
 * Scans the LAST user message for links and, when Fetch Web is enabled,
 * returns the history with the fetched page texts appended to that message.
 * Resolves fast when nothing matches; never rejects.
 */
export async function augmentWithWebContent(
  messages: ChatMessage[],
  enabled: boolean,
): Promise<ChatMessage[]> {
  if (!enabled || messages.length === 0) return messages;

  let lastIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex < 0) return messages;

  const scan = extractUrls(messageText(messages[lastIndex]));
  if (scan.allowed.length === 0 && scan.blocked.length === 0) return messages;

  const blocks = await Promise.all(scan.allowed.map((url) => fetchPageText(url)));
  const blockedNotes = scan.blocked.map(
    (entry) =>
      `[Fetch BLOCKED: ${entry.url} — ${entry.reason}. The page content could NOT be read. ` +
      'Acknowledge to the user that this link is blocked; never describe or guess its content.]',
  );
  const suffix = `\n\n${[...blocks, ...blockedNotes].join('\n\n')}`;
  const last = messages[lastIndex];

  const augmented: ChatMessage = {
    ...last,
    content: typeof last.content === 'string'
      ? last.content + suffix
      : [
          ...(last.content ?? []),
          { type: 'text', text: suffix },
        ],
  };
  return [...messages.slice(0, lastIndex), augmented, ...messages.slice(lastIndex + 1)];
}
