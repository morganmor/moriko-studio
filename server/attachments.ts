

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ensureChatDirFor } from './conversationStore.js';
import type { ChatMessage } from './contracts.js';


export const ATTACHMENT_DIR = 'attachment';


const MAX_FILE_BYTES = 10_000_000;

export interface StoredAttachment {
  
  absolutePath: string;
  
  filename: string;
  size: number;
  mime: string;
}


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


function contentFilename(name: string, sequence: number): string {
  const ext = path.extname(name).toLowerCase() || '.bin';
  const seq = String(sequence).padStart(3, '0');
  return `attachment-${seq}${ext}`;
}


const STORED_NAME_RE = /^attachment-(\d{1,4})\.([\w.-]+)$/;


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


export function describeAttachment(
  relativePath: string,
): { no: number | null; when: string | null } {
  const match = STORED_NAME_RE.exec(path.basename(relativePath));
  if (!match) return { no: null, when: null };
  return { no: Number(match[1]), when: null };
}


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
