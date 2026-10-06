/**
 * P2 EXTERNALIZATION — the byte store behind conversation records.
 *
 * Problem: the 1.6 MB conversation record carried its weight INLINE —
 * attachment images as base64 data URLs, agent__render_visual payloads as
 * full HTML documents, read_file inline images as base64. Every layer paid:
 * the GET body (LCP gate), JSON.parse on boot, the sync debounce upload, and
 * the turn-patch writes.
 *
 * This module owns `~/.moriko/attachments/` — one content-addressed directory
 * (`<sha1 hex>` filenames, deduplicated across every conversation). Records
 * never store large payloads again; they store a REFERENCE object instead:
 *
 *   attachment:  { dataRef: { hash, mime, byteSize } }   — dataUrl dropped
 *   visual:      { htmlRef: { hash, byteSize } }         — html dropped
 *   toolImages:  { mime, dataRef: { hash, ... } }        — dataUrl dropped
 *
 * `dataRef.hash` is the sha1 of the DECODED BYTES (not of the base64 text, so
 * re-encoding differences cannot duplicate files). Resolution goes the other
 * way at the boundaries that need bytes:
 *
 *   - GET /api/attachments/ref/:hash  → the bytes (browser-cacheable; the
 *     thread's <img> and VisualCard fetch-on-mount read through here);
 *   - GET /api/conversations/:id      → `resolveRecordRefs` re-inlines refs as
 *     data URLs for the client's render+send path; the strip runs again
 *     server-side before anything persists, so the record stays lean;
 *   - POST /api/chat                  → `resolveWireRefs` swaps
 *     `moriko-ref://<mime>/<hash>` URLs for data URLs at the provider
 *     boundary — the adapters never learn refs exist.
 *
 * Everything here is synchronous and best-effort per payload: one unreadable
 * entry never loses the rest of the record.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './atomicWrite.js';
import { attachmentsStoreDir, conversationDir, conversationManifestFile } from './paths.js';

/** Payloads whose data-URL text is under this ride inline (record JSON keeps them). */
export const INLINE_DATA_URL_LIMIT = 50_000;

/** The pseudo-protocol wire URLs use: `moriko-ref://<mime>/<hash>`. */
export const REF_PROTOCOL = 'moriko-ref://';


function hashBytes(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Writes bytes under their content hash (+ a mime sidecar) — idempotent. */
export function putBytes(bytes: Buffer, mime?: string): string {
  const hash = hashBytes(bytes);
  try {
    mkdirSync(attachmentsStoreDir, { recursive: true });
    const target = path.join(attachmentsStoreDir, hash);
    if (!existsSync(target)) writeFileSync(target, bytes);
    if (mime) {
      const meta = path.join(attachmentsStoreDir, `${hash}.json`);
      if (!existsSync(meta)) writeFileSync(meta, JSON.stringify({ mime }));
    }
  } catch {
  }
  return hash;
}

/** Reads one stored payload back; null when the hash has no file on disk. */
export function getBytes(hash: string): Buffer | null {
  if (!/^[0-9a-f]{8,64}$/.test(hash)) return null;
  try {
    return readFileSync(path.join(attachmentsStoreDir, hash));
  } catch {
    return null;
  }
}

/** Bytes + best-known mime for the GET route (sidecar, else octet-stream). */
export function readStoredWithMime(hash: string): { bytes: Buffer; mime: string } | null {
  const bytes = getBytes(hash);
  if (!bytes) return null;
  let mime = 'application/octet-stream';
  try {
    const sidecar = JSON.parse(
      readFileSync(path.join(attachmentsStoreDir, `${hash}.json`), 'utf8'),
    ) as { mime?: unknown };
    if (typeof sidecar.mime === 'string' && sidecar.mime) mime = sidecar.mime;
  } catch {
  }
  return { bytes, mime };
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:')) return null;
  const header = dataUrl.slice(0, comma);
  const mime = /data:([^;,]+)/.exec(header)?.[1] || 'application/octet-stream';
  try {
    const body = dataUrl.slice(comma + 1);
    const bytes = /;base64/i.test(header)
      ? Buffer.from(body, 'base64')
      : Buffer.from(decodeURIComponent(body), 'utf8');
    return bytes.length > 0 ? { mime, bytes } : null;
  } catch {
    return null;
  }
}


interface DataRef {
  hash: string;
  mime: string;
  byteSize: number;
}

function stripDataUrlValue(dataUrl: unknown): { ref: DataRef; wireSize: number } | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  if (dataUrl.length < INLINE_DATA_URL_LIMIT) return null;
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) return null;
  return {
    ref: { hash: putBytes(decoded.bytes, decoded.mime), mime: decoded.mime, byteSize: decoded.bytes.byteLength },
    wireSize: dataUrl.length,
  };
}

function stripVisualHtml(html: unknown): { ref: { hash: string; byteSize: number }; wireSize: number } | null {
  if (typeof html !== 'string' || html.length < INLINE_DATA_URL_LIMIT) return null;
  return {
    ref: { hash: putBytes(Buffer.from(html, 'utf8'), 'text/html'), byteSize: Buffer.byteLength(html, 'utf8') },
    wireSize: html.length,
  };
}

/** Strips ONE turn in place; returns the wire bytes the record shed. */
function stripTurn(turn: Record<string, unknown>): number {
  let shed = 0;

  if (Array.isArray(turn.attachments)) {
    for (const entry of turn.attachments) {
      if (!entry || typeof entry !== 'object') continue;
      const attachment = entry as Record<string, unknown>;
      const stripped = stripDataUrlValue(attachment.dataUrl);
      if (!stripped) continue;
      shed += stripped.wireSize;
      attachment.dataRef = stripped.ref;
      delete attachment.dataUrl;
    }
  }

  if (Array.isArray(turn.segments)) {
    for (const entry of turn.segments) {
      if (!entry || typeof entry !== 'object') continue;
      const segment = entry as Record<string, unknown>;
      if (segment.visual && typeof segment.visual === 'object') {
        const visual = segment.visual as Record<string, unknown>;
        const stripped = stripVisualHtml(visual.html);
        if (stripped) {
          shed += stripped.wireSize;
          visual.htmlRef = stripped.ref;
          delete visual.html;
        }
        // VISUAL v2: frontend-preview candidates externalize individually.
        if (Array.isArray(visual.variants)) {
          for (const variant of visual.variants) {
            if (!variant || typeof variant !== 'object') continue;
            const candidate = variant as Record<string, unknown>;
            const strippedVariant = stripVisualHtml(candidate.html);
            if (!strippedVariant) continue;
            shed += strippedVariant.wireSize;
            candidate.htmlRef = strippedVariant.ref;
            delete candidate.html;
          }
        }
      }
      if (Array.isArray(segment.toolImages)) {
        for (const image of segment.toolImages) {
          if (!image || typeof image !== 'object') continue;
          const toolImage = image as Record<string, unknown>;
          const stripped = stripDataUrlValue(toolImage.dataUrl);
          if (!stripped) continue;
          shed += stripped.wireSize;
          toolImage.dataRef = stripped.ref;
          delete toolImage.dataUrl;
        }
      }
    }
  }

  return shed;
}

/**
 * Strips a FULL record in place (sync upserts + turn patches): walks every
 * turn and externalizes oversized payloads. Returns bytes shed (0 = clean).
 * The caller persists the record AFTER this runs, so the on-disk chat-data
 * stays the stripped shape from then on.
 */
export function stripAttachmentDataUrls(record: Record<string, unknown>): number {
  if (!Array.isArray(record.turns)) return 0;
  let shed = 0;
  for (const entry of record.turns) {
    if (entry && typeof entry === 'object') shed += stripTurn(entry as Record<string, unknown>);
  }
  return shed;
}

/** Strips ONE turn (turn-patch path: the patch body is stripped pre-store). */
export function stripTurnPayloads(turn: unknown): void {
  if (turn && typeof turn === 'object') stripTurn(turn as Record<string, unknown>);
}

/**
 * One-shot BOOT migration for a record just read from disk: strips payloads
 * and, when anything moved, REWRITES the chat file immediately — a legacy
 * multi-megabyte record must not survive one more boot. Best-effort: a disk
 * failure leaves the in-memory record stripped (the next flush persists it).
 */
export function migrateAttachmentDataUrls(id: string, record: unknown): void {
  try {
    if (!record || typeof record !== 'object') return;
    const typed = record as Record<string, unknown>;
    if (!Array.isArray(typed.turns)) return;
    if (stripAttachmentDataUrls(typed) > 0) {
      const folder = manifestFolderFor(id);
      if (folder) {
        try {
          atomicWriteJson(path.join(conversationDir, folder, 'chat-data.json'), typed);
        } catch {
        }
      }
    }
  } catch {
  }
}

/** Manifest folder lookup: id → chat folder under conversationDir/. */
function manifestFolderFor(id: string): string | null {
  try {
    if (!existsSync(conversationManifestFile)) return null;
    const manifest = JSON.parse(readFileSync(conversationManifestFile, 'utf8')) as {
      folders?: Record<string, string>;
    };
    return manifest.folders?.[id] ?? null;
  } catch {
    return null;
  }
}


function dataUrlFor(hash: string, mime: string): string | null {
  const bytes = getBytes(hash);
  if (!bytes) return null;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * Resolves `moriko-ref://` URLs IN PLACE on a raw parts array — the steer
 * path. Steered parts bypass /api/chat's resolveWireRefs (they sit in the
 * steer buffer, drained by the adapter straight into the convo), so this
 * runs at the drain seam instead: without it the provider would receive a
 * dead pseudo-protocol URL.
 */
export function resolveSteerPartRefs(
  parts: Array<{ type: string; image_url?: { url?: string }; file?: { file_data?: string } }>,
): void {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith(REF_PROTOCOL)) {
      const rest = part.image_url.url.slice(REF_PROTOCOL.length);
      const slash = rest.lastIndexOf('/');
      const mime = slash > 0 ? rest.slice(0, slash) : 'application/octet-stream';
      const hash = slash > 0 ? rest.slice(slash + 1) : rest;
      const dataUrl = dataUrlFor(hash, mime);
      if (dataUrl) part.image_url.url = dataUrl;
      else parts.splice(i, 1);
    } else if (part.type === 'file' && typeof part.file?.file_data === 'string' && part.file.file_data.startsWith(REF_PROTOCOL)) {
      const rest = part.file.file_data.slice(REF_PROTOCOL.length);
      const slash = rest.lastIndexOf('/');
      const mime = slash > 0 ? rest.slice(0, slash) : 'application/octet-stream';
      const hash = slash > 0 ? rest.slice(slash + 1) : rest;
      const dataUrl = dataUrlFor(hash, mime);
      if (dataUrl) part.file.file_data = dataUrl;
      else parts.splice(i, 1);
    }
  }
}

/**
 * Swaps `moriko-ref://<mime>/<hash>` URLs on OUTGOING wire messages for data
 * URLs resolved from the byte store. A hash that cannot resolve is DROPPED
 * (the provider must never see a dead URL); the surrounding text part stays.
 */
export function resolveWireRefs(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let i = content.length - 1; i >= 0; i -= 1) {
      const part = content[i];
      if (!part || typeof part !== 'object') continue;
      const typed = part as {
        type?: string;
        image_url?: { url?: string };
        file?: { file_data?: string };
      };
      if (typed.type === 'image_url' && typeof typed.image_url?.url === 'string' && typed.image_url.url.startsWith(REF_PROTOCOL)) {
        const rest = typed.image_url.url.slice(REF_PROTOCOL.length);
        const slash = rest.lastIndexOf('/');
        const mime = slash > 0 ? rest.slice(0, slash) : 'application/octet-stream';
        const hash = slash > 0 ? rest.slice(slash + 1) : rest;
        const dataUrl = dataUrlFor(hash, mime);
        if (dataUrl) typed.image_url.url = dataUrl;
        else content.splice(i, 1);
      } else if (typed.type === 'file' && typeof typed.file?.file_data === 'string' && typed.file.file_data.startsWith(REF_PROTOCOL)) {
        const rest = typed.file.file_data.slice(REF_PROTOCOL.length);
        const slash = rest.lastIndexOf('/');
        const mime = slash > 0 ? rest.slice(0, slash) : 'application/octet-stream';
        const hash = slash > 0 ? rest.slice(slash + 1) : rest;
        const dataUrl = dataUrlFor(hash, mime);
        if (dataUrl) typed.file.file_data = dataUrl;
        else content.splice(i, 1);
      }
    }
  }
}