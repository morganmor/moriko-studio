/**
 * Client-side reference-image plumbing for Image Studio: file → data URL,
 * remote result → reference, and canvas encoding that stays under the
 * 3 MB submit-body cap (data URLs travel inside POST /api/images/generations).
 */

/** Per-reference-image upload cap (data URL travels in the submit body). */
export const MAX_REFERENCE_BYTES = 3 * 1024 * 1024;

/** Reads an image file into a data URL for reference upload. */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'));
    reader.readAsDataURL(file);
  });
}

/** Approximate decoded byte size of a data URL. */
export function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return 0;
  const header = url.slice(0, comma);
  const isBase64 = header.endsWith(';base64');
  const body = url.length - comma - 1;
  return isBase64 ? Math.floor((body * 3) / 4) : body;
}

/**
 * Encodes a canvas under `maxBytes`: tries the requested mime ladder, then
 * downscales 75% per round (max 4 rounds). Returns null when nothing fits.
 * `flatten` composites onto white first — JPEG has no alpha channel.
 */
export function encodeWithinLimit(
  canvas: HTMLCanvasElement,
  maxBytes: number,
  preferLossless = false,
): string | null {
  let current = canvas;
  const ladder: Array<[string, number | undefined]> = preferLossless
    ? [['image/png', undefined], ['image/jpeg', 0.92], ['image/jpeg', 0.8], ['image/jpeg', 0.65]]
    : [['image/jpeg', 0.92], ['image/jpeg', 0.8], ['image/jpeg', 0.65], ['image/png', undefined]];
  let flatten = preferLossless;
  for (let round = 0; round < 4; round += 1) {
    if (flatten) {
      const flat = document.createElement('canvas');
      flat.width = current.width;
      flat.height = current.height;
      const ctx = flat.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(current, 0, 0);
      current = flat;
      flatten = false;
    }
    for (const [type, quality] of ladder) {
      const url = current.toDataURL(type, quality);
      if (dataUrlBytes(url) <= maxBytes) return url;
    }
    if (current.width <= 64 || current.height <= 64) break;
    const next = document.createElement('canvas');
    next.width = Math.max(1, Math.round(current.width * 0.75));
    next.height = Math.max(1, Math.round(current.height * 0.75));
    const ctx = next.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  return null;
}

/**
 * Turns a generated result URL into a reference data URL. Same-origin
 * `/api/images/local/...` snapshots load without CORS; oversized blobs are
 * re-encoded through the ladder above instead of being rejected.
 */
export async function referenceFromUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.type.startsWith('image/') === false) throw new Error('Not an image');
  if (blob.size <= MAX_REFERENCE_BYTES) return readFileAsDataUrl(blob);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const encoded = encodeWithinLimit(canvas, MAX_REFERENCE_BYTES, blob.type === 'image/png');
  if (!encoded) throw new Error('Image too large');
  return encoded;
}
