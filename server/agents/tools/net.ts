/**
 * agent__fetch — read a PUBLIC web page or text resource over http(s) and
 * get its content as text/markdown. Binary responses are rejected (use
 * download for files). Local/private network addresses are blocked.
 *
 * agent__download — download a file from a public http(s) URL INTO the
 * workspace (never overwrites unless overwrite: true).
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, bool, formatSize, truncateOutput, resolveWithPermission } from './shared.js';
import { fetchText, NetBlockedError, boundedGet } from '../net.js';
import { snapshotFile } from '../vault.js';

const FETCH_DEFAULT_CHARS = 20_000;
const FETCH_MAX_CHARS = 100_000;
const MAX_DOWNLOAD_BYTES = 200_000_000;

export async function fetchTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  void ctx;
  const url = str(args, 'url').trim();
  if (!url) return { ok: false, isError: true, text: 'fetch needs a "url".' };
  const formatInput = str(args, 'format').trim().toLowerCase();
  const format = formatInput === 'html' ? 'html' : formatInput === 'text' ? 'text' : 'markdown';
  const maxLength = Math.min(Math.max(num(args, 'maxLength') ?? FETCH_DEFAULT_CHARS, 200), FETCH_MAX_CHARS);
  try {
    const result = await fetchText(url, format);
    const text = result.text.length > maxLength ? result.text.slice(0, maxLength) : result.text;
    const header = `GET ${result.finalUrl} → ${result.status} · ${result.contentType} · ${formatSize(result.bytes)}\n\n`;
    return {
      ok: result.status < 400,
      isError: result.status >= 400,
      text: truncateOutput(header + text + (result.text.length > maxLength ? '\n…(use maxLength up to 100000 for more)' : '')),
    };
  } catch (error) {
    const message = error instanceof NetBlockedError ? error.message : error instanceof Error ? error.message : 'fetch failed';
    return { ok: false, isError: true, text: `fetch failed: ${message}` };
  }
}

export async function downloadTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const url = str(args, 'url').trim();
  const inputPath = str(args, 'path').trim();
  if (!url || !inputPath) {
    return { ok: false, isError: true, text: 'download needs "url" and a "path" relative to the workspace root.' };
  }
  const { absolute, relative } = await resolveWithPermission('download', inputPath, ctx, 'write');
  let exists = false;
  try {
    exists = statSync(absolute).isFile();
  } catch {
    exists = false;
  }
  if (exists && !bool(args, 'overwrite')) {
    return { ok: false, isError: true, text: `${relative} already exists — pass overwrite: true to replace it (the old file is vaulted).` };
  }
  try {
    const result = await boundedGet(url);
    if (result.status >= 400) {
      return { ok: false, isError: true, text: `Download failed: HTTP ${result.status} from ${result.finalUrl}.` };
    }
    if (result.buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      return { ok: false, isError: true, text: `File exceeds the ${Math.round(MAX_DOWNLOAD_BYTES / 1_000_000)} MB download cap.` };
    }
    if (exists) snapshotFile(ctx.sessionId, absolute, 'download-overwrite');
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, result.buffer);
    return {
      ok: true,
      isError: false,
      text: `Downloaded ${result.finalUrl} → ${relative} (${formatSize(result.buffer.byteLength)}, ${result.contentType}).`,
    };
  } catch (error) {
    const message = error instanceof NetBlockedError ? error.message : error instanceof Error ? error.message : 'download failed';
    return { ok: false, isError: true, text: `download failed: ${message}` };
  }
}
