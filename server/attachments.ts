/**
 * ATTACHMENT DIRECTORY — uploaded files never vanish from context.
 *
 * Per-conversation layout (v2): every upload lives inside the CHAT'S OWN
 * session folder under the app's conversation store —
 *
 *   ~/.moriko/conversation/chat-001-YYYYMMDD/attachment/attachment-001.jpg
 *
 * The folder is allocated by `ensureChatDirFor` the moment the first upload
 * arrives (BEFORE the chat record exists), so a brand-new conversation can
 * accept files immediately and the record later flushes into the SAME folder.
 *
 * Because the store sits under the app's own data root (outside every
 * workspace), the harness tools may NOT resolve these paths like workspace
 * files. Reading them instead goes through a dedicated, always-allowed
 * attachment exemption (see `isAttachmentPath` in workspace.ts): the agent
 * references an upload by its absolute store path and reads it with zero
 * approval — attachments belong to the conversation, not to a workspace.
 *
 * Files are written once and deduplicated per conversation by content hash:
 * uploading the same image twice in one chat reuses the first copy. Nothing
 * here deletes on send; pruning follows the chat (the trash moves the folder).
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ensureChatDirFor } from './conversationStore.js';
import type { ChatMessage } from './contracts.js';

/** The chat folder's own attachment subdirectory name. */
export const ATTACHMENT_DIR = 'attachment';

/** Hard cap on a single attachment's bytes — matches the Composer's 10 MB. */
const MAX_FILE_BYTES = 10_000_000;

export interface StoredAttachment {
  /** ABSOLUTE path inside the app store — stable, self-describing, and the
   *  exact form the agent references the file by (reads need no approval). */
  absolutePath: string;
  /** The stable filename inside the chat's attachment directory. */
  filename: string;
  size: number;
  mime: string;
}

/** Extracts the bytes from a data: URL (the only shape the client sends). */
function decodeDataUrl(dataUrl: string): { buffer: Buffer; mime: string } {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URL.');
  const header = dataUrl.slice(0, comma);
  const mime = /data:([^;,]+)/.exec(header)?.[1] || 'application/octet-stream';
  const isBase64 = /;base64/i.test(header);
  const body = dataUrl.slice(comma + 1);
  return {
    mime,
    buffer: isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8'),
  };
}

/**
 * Stable filename: `attachment-NNN.ext` — the per-conversation UPLOAD
 * SEQUENCE number plus the original extension. The number is per chat (the
 * 1st upload in THIS conversation = 001, whatever other chats did), so the
 * model can read the upload order straight off the name. Same bytes
 * re-uploaded in the same chat REUSE the first file's number — one file
 * never occupies two rows in the directory.
 */
function contentFilename(name: string, sequence: number): string {
  const ext = path.extname(name).toLowerCase() || '.bin';
  const seq = String(sequence).padStart(3, '0');
  return `attachment-${seq}${ext}`;
}

/** Filename shape this module writes: `attachment-NNN.ext`. */
const STORED_NAME_RE = /^attachment-(\d{1,4})\.([\w.-]+)$/;

/**
 * Per-conversation write state: the next upload number and a
 * hash→filename index, built once per process from the directory listing
 * (each stored file hashed once to rebuild dedup). The proxy is the only
 * writer of the chat's attachment dir, so an in-memory counter cannot race.
 */
interface ChatSeq {
  next: number;
  byHash: Map<string, string>;
}
const chatSeqs = new Map<string, ChatSeq>();

async function chatSeqFor(chatDir: string): Promise<ChatSeq> {
  const cached = chatSeqs.get(chatDir);
  if (cached) return cached;
  const state: ChatSeq = { next: 1, byHash: new Map() };
  const attachmentDir = path.join(chatDir, ATTACHMENT_DIR);
  try {
    for (const entry of await readdir(attachmentDir)) {
      const match = STORED_NAME_RE.exec(entry);
      if (!match) continue;
      const no = Number(match[1]);
      if (no >= state.next) state.next = no + 1;
      try {
        const bytes = await readFile(path.join(attachmentDir, entry));
        state.byHash.set(createHash('sha256').update(bytes).digest('hex').slice(0, 16), entry);
      } catch {
      }
    }
  } catch {
  }
  chatSeqs.set(chatDir, state);
  return state;
}

/**
 * Human-readable upload metadata parsed back out of a stored path: the
 * per-conversation upload NUMBER. Legacy paths (workspace layout) come back
 * as nulls — callers fall back to the raw path.
 */
export function describeAttachment(
  relativePath: string,
): { no: number | null; when: string | null } {
  const match = STORED_NAME_RE.exec(path.basename(relativePath));
  if (!match) return { no: null, when: null };
  return { no: Number(match[1]), when: null };
}

/**
 * Pulls attachment inputs off the wire messages — the fallback path for
 * one-shot callers (scripts) that POST /api/chat with data URLs but no
 * declared attachment list.
 */
export function collectAttachmentInputs(messages: ChatMessage[]): Array<{
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
}> {
  const inputs: Array<{ name: string; mime: string; size: number; dataUrl: string }> = [];
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'image_url' || typeof part.image_url?.url !== 'string') continue;
      const url = part.image_url.url;
      if (!url.startsWith('data:')) continue;
      try {
        const { mime } = decodeDataUrl(url);
        inputs.push({
          name: `attachment_${inputs.length + 1}`,
          mime,
          size: Buffer.byteLength(url),
          dataUrl: url,
        });
      } catch {
      }
    }
  }
  return inputs;
}

/**
 * Writes attachments to the chat's OWN folder inside the conversation store
 * (`conversation/chat-XXX/attachment/attachment-NNN.ext`) and returns the
 * ABSOLUTE store paths the model references. Non-fatal per file: one bad
 * entry does not lose the rest.
 *
 * Each input may carry its bytes EITHER as a decoded buffer (the upload route
 * sends raw bytes directly) or as a data: URL (the fallback path decodes wire
 * messages). Exactly one is required per entry.
 */
export async function persistAttachments(
  sessionId: string,
  attachments: Array<{
    name: string;
    mime: string;
    size: number;
    dataUrl?: string;
    buffer?: Buffer;
  }>,
): Promise<StoredAttachment[]> {
  if (!attachments || attachments.length === 0) return [];
  const chatDir = ensureChatDirFor(sessionId);
  if (!chatDir) return [];
  const attachmentDir = path.join(chatDir, ATTACHMENT_DIR);
  await mkdir(attachmentDir, { recursive: true });

  const stored: StoredAttachment[] = [];
  for (const attachment of attachments) {
    try {
      let buffer: Buffer | undefined;
      let mime = attachment.mime;
      if (attachment.buffer) {
        buffer = attachment.buffer;
      } else if (attachment.dataUrl) {
        const decoded = decodeDataUrl(attachment.dataUrl);
        buffer = decoded.buffer;
        mime = decoded.mime;
      }
      if (!buffer) continue;
      if (buffer.byteLength === 0) continue;
      if (buffer.byteLength > MAX_FILE_BYTES) continue;

      const seq = await chatSeqFor(chatDir);
      const contentHash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      const existing = seq.byHash.get(contentHash);
      const filename = existing ?? contentFilename(attachment.name, seq.next);
      if (!existing) {
        seq.next += 1;
        seq.byHash.set(contentHash, filename);
      }
      const absolute = path.join(attachmentDir, filename);
      const present = existing
        ? await stat(absolute)
            .then((stats) => stats.size === buffer.byteLength)
            .catch(() => false)
        : false;
      if (!present) {
        await pipeline(Readable.from([buffer]), createWriteStream(absolute));
      }
      stored.push({
        absolutePath: absolute,
        filename,
        size: buffer.byteLength,
        mime: mime || attachment.mime,
      });
    } catch {
    }
  }
  return stored;
}
