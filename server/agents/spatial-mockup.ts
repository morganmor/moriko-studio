/**
 * SPATIAL MOCKUP (F6) — design target tier: mockup image → Layout IR.
 *
 * The third rung of the translation ladder (docs/plans/PLAN-SPATIAL-HARNESS.md):
 * a DESIGN IMAGE (Figma export, screenshot, hand sketch) is segmented by the
 * configured vision model into the SAME Layout IR the static and runtime
 * tiers produce. The result is a design TARGET:
 *
 *   mockup IR (target) ──implement──► code ──runtime capture──► compare
 *
 * so "does the build match the design?" becomes a region-level diff instead
 * of a feeling. Honesty rules: the segmentation is APPROXIMATE (±5-10% box
 * estimates), always labelled tier 'mockup', never merged into static/runtime
 * verdicts, and only as good as the configured vision model.
 *
 * This module is pure: it parses the model's ANSWER into a map. The tool
 * layer owns the network call (agent__vision machinery).
 */
import {
  detectCollisions,
  type SpatialMap,
  type SpatialRegion,
  type SpatialConstraint,
  type SpatialRect,
} from './spatial.js';

/** Region cap — a design target is a handful of layout blocks, not a DOM dump. */
const MAX_MOCKUP_REGIONS = 80;

/**
 * The segmentation instruction sent to the vision model. Strict JSON out;
 * layout blocks only; the ids become the vocabulary for later
 * implement→verify loops, so they must be semantic and stable.
 */
export const MOCKUP_PROMPT = [
  'You are a UI-layout segmenter. Analyze this design mockup and return ONLY a JSON object — no prose, no markdown fences — shaped exactly like:',
  '{"canvas":{"w":<image width in px>,"h":<image height in px>},"regions":[{"id":"<semantic-lowercase-id>","role":"<optional aria-ish role>","rect":{"x":<int>,"y":<int>,"w":<int>,"h":<int>}}]}',
  'Rules:',
  '- Regions are MAJOR layout blocks only: header, sidebar, nav, main panels, cards, footer, prominent buttons/inputs. Skip text spans, icons and decorations.',
  '- id: short, semantic, lowercase, hyphenated (e.g. "left-sidebar", "primary-button", "stats-card-1"). No duplicates.',
  '- rect: integer pixel bounds relative to the TOP-LEFT of the image. Estimates are fine; do not skip a block because the box is uncertain.',
  '- Include "canvas" with the full image size. Return at most 30 regions.',
].join('\n');


/** Parse intrinsic image size from PNG IHDR / JPEG SOF / GIF headers (no deps). */
export function parseImageDimensions(buffer: Buffer, mime: string): { w: number; h: number } | null {
  try {
    if (mime === 'image/png' && buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
      const w = buffer.readUInt32BE(16);
      const h = buffer.readUInt32BE(20);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (mime === 'image/gif' && buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
      const w = buffer.readUInt16LE(6);
      const h = buffer.readUInt16LE(8);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (mime === 'image/jpeg' && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
          offset += 2;
          continue;
        }
        const length = buffer.readUInt16BE(offset + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          const h = buffer.readUInt16BE(offset + 5);
          const w = buffer.readUInt16BE(offset + 7);
          return w > 0 && h > 0 ? { w, h } : null;
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}


export interface MockupRegion {
  id: string;
  role?: string;
  rect: SpatialRect;
}

export interface MockupAnswer {
  canvas?: { w: number; h: number };
  regions: MockupRegion[];
}

/**
 * Extract the JSON segmentation from the model's answer. Tolerates markdown
 * fences and surrounding prose; refuses anything that is not a parseable
 * object with a regions array (the caller reports the error verbatim).
 */
export function parseMockupAnswer(text: string): MockupAnswer | string {
  const unfenced = text.replace(/```[a-z]*\n?/gi, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return 'The vision answer contains no JSON object. Retry the capture, or ask the vision model for a plain JSON reply.';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return 'The vision answer contained malformed JSON — the segmentation could not be trusted. Retry, or use a stronger vision model.';
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { regions?: unknown }).regions)) {
    return 'The vision JSON is missing the "regions" array. A mockup map without regions is not a design target.';
  }
  const raw = parsed as { canvas?: { w?: unknown; h?: unknown }; regions: Array<Record<string, unknown>> };
  const canvas =
    typeof raw.canvas?.w === 'number' && typeof raw.canvas?.h === 'number' && raw.canvas.w > 0 && raw.canvas.h > 0
      ? { w: Math.round(raw.canvas.w), h: Math.round(raw.canvas.h) }
      : undefined;

  const regions: MockupRegion[] = [];
  for (const entry of raw.regions.slice(0, MAX_MOCKUP_REGIONS)) {
    const rect = (entry?.rect ?? {}) as Record<string, unknown>;
    const id = typeof entry?.id === 'string' ? entry.id.trim().toLowerCase().replace(/\s+/g, '-') : '';
    const x = typeof rect.x === 'number' ? Math.round(rect.x) : NaN;
    const y = typeof rect.y === 'number' ? Math.round(rect.y) : NaN;
    const w = typeof rect.w === 'number' ? Math.round(rect.w) : NaN;
    const h = typeof rect.h === 'number' ? Math.round(rect.h) : NaN;
    if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue;
    }
    regions.push({
      id,
      role: typeof entry?.role === 'string' ? entry.role : undefined,
      rect: { x, y, w: Math.max(1, w), h: Math.max(1, h) },
    });
  }
  if (regions.length === 0) {
    return 'Every region entry was malformed (missing id or rect) — no usable design target could be built.';
  }
  return { canvas, regions };
}


const OVERLAY_RE = /modal|dialog|tooltip|popover|menu|overlay|toast|drawer/i;

export function buildMockupMap(
  answer: MockupAnswer,
  source: string,
  intrinsic: { w: number; h: number } | null,
): SpatialMap {
  const canvas = answer.canvas ?? intrinsic ?? null;
  const warnings: string[] = [];
  if (!canvas) {
    warnings.push('canvas size unknown (image header unreadable and the model gave none) — coordinates are model-relative estimates');
  } else if (answer.canvas && intrinsic && (Math.abs(answer.canvas.w - intrinsic.w) > 2 || Math.abs(answer.canvas.h - intrinsic.h) > 2)) {
    warnings.push(
      `the model reported a ${answer.canvas.w}×${answer.canvas.h} canvas but the image is ${intrinsic.w}×${intrinsic.h} — ` +
      'using the model\u2019s frame; box estimates may be scaled',
    );
  }

  const used = new Map<string, number>();
  const regions: SpatialRegion[] = answer.regions.map((region) => {
    const seen = used.get(region.id) ?? 0;
    used.set(region.id, seen + 1);
    return {
      id: seen === 0 ? region.id : `${region.id}#${seen + 1}`,
      file: source,
      line: 0,
      rect: region.rect,
      constraint: 'unknown' as SpatialConstraint,
      magicNumbers: [],
      zIndex: null,
      overlay: OVERLAY_RE.test(region.id) || OVERLAY_RE.test(region.role ?? ''),
      via: 'mockup' as const,
    };
  });

  if (canvas) {
    const off = regions.filter(
      (r) => r.rect !== null && (r.rect.x < -8 || r.rect.y < -8 || r.rect.x + r.rect.w > canvas.w + 8 || r.rect.y + r.rect.h > canvas.h + 8),
    );
    if (off.length > 0) {
      warnings.push(
        `${off.length} region(s) fall outside the ${canvas.w}×${canvas.h} canvas — the segmentation box estimates are rough`,
      );
    }
  }
  warnings.push('mockup geometry is a vision-model ESTIMATE (±5-10%) — implement against it as intent, verify with the runtime tier');

  return {
    tier: 'mockup',
    files: [source],
    regions,
    collisions: detectCollisions(regions),
    warnings,
  };
}
