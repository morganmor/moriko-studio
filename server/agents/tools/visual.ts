/**
 * agent__render_visual (Fase D + Visual v2) — the agent's LIVE VISUAL channel.
 *
 * The model writes a COMPLETE standalone HTML document; the harness hands it
 * to the client as a `visual` attachment on the tool_result and renders it in
 * a locked-down iframe:
 *
 *   <iframe sandbox="allow-scripts" srcDoc={html} csp="default-src 'none'">
 *
 * - `allow-scripts` (WITHOUT allow-same-origin) → the document runs in an
 *   opaque origin: no DOM parent access, no localStorage, no cookie jar.
 * - csp="default-src 'none'" → ZERO network (scripts, styles, images, fetch,
 *   websockets all fail closed). Inline <style>/<script> still run, so CSS
 *   animations and JS interactivity stay fully alive inside the box.
 * - The payload NEVER rides the model's context: the wire rebuild charges
 *   tool results for text; a visual is capped at 256 KB and returned to the
 *   model as a short text summary (title + dimensions + a stable id), so the
 *   agent loop continues normally after rendering.
 *
 * Size cap 256 KB (post-unzip HTML is text; 256 KB is ~5k lines — beyond
 * that the visual belongs in a workspace file, not a chat artifact).
 *
 * ── VISUAL v2 ────────────────────────────────────────────────────────────
 *  1. EDIT-IN-PLACE: `id` is now a MODEL-SUPPLIED key. Passing the id of an
 *     existing visual rewrites THAT card in every open browser (history
 *     keeps the audit trail — the turn segments persist, the live thread
 *     re-binds by id). One tool per card instead of one tool call per frame.
 *  2. FRONTEND PREVIEW: `variants: [{ source, title, height? }]` (1..3) turns
 *     ONE call into a multi-candidate card — the user sees up to three
 *     live frontends side by side in one card and picks one; the pick is
 *     re-broadcast to the model as a tool_result-shaped steer so the agent
 *     loop learns the decision without re-rendering.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput } from './shared.js';
import { publishBusEvent } from '../../addons/bus.js';
import { listStoredVisuals, updateStoredVisual } from '../../conversationStore.js';

/** Hard cap on the HTML payload (bytes of UTF-8). */
export const VISUAL_MAX_BYTES = 256 * 1024;

/** Rendered height clamp (CSS px) — the card may not exceed the viewport. */
const HEIGHT_MIN = 120;
const HEIGHT_MAX = 2000;

/** Candidate cap for the frontend-preview mode (matches the card UI). */
export const VISUAL_MAX_VARIANTS = 3;

/** Per-variant byte budget: 3 × 256 KB documents in one card is abuse. */
const VARIANT_MAX_BYTES = 256 * 1024;

/** The addon-bus topics other browsers listen on for live visual updates. */
export const VISUAL_BUS_TOPICS = {
  render: 'moriko:visual-rendered',
  update: 'moriko:visual-updated',
  pick: 'moriko:visual-picked',
} as const;

let visualSeq = 0;

/** A visual payload riding a tool_result (mirrors ToolImage's shape role). */
export interface VisualPayload {
  id: string;
  /** Complete standalone HTML document (sandboxed+CSPed at render time). */
  html: string;
  title: string;
  /** Preferred render height in CSS px (clamped 120–2000). */
  height: number;
  /**
   * F5.1 — vendor library ids the CLIENT injects into the iframe head before
   * srcDoc (fetched same-origin from /api/visual-vendor/:lib, cached in memory
   * per lib). Only NAMES ride the payload — bundles never enter the chat.
   */
  libs?: string[];
  /**
   * VISUAL v2 — replaced candidates carried by an edit-in-place. The client
   * re-binds EVERY live card with this id to the new payload and the thread
   * folds it into the LAST render_visual segment for the audit trail.
   */
  replaces?: true;
  /** Frontend-preview candidates (1..3), present when the call used `variants`. */
  variants?: Array<{ id: string; html: string; title: string; height: number; libs?: string[] }>;
}

/** F5.1 — allowed vendor lib ids (validated server-side). */
export const VISUAL_LIBS = new Set(['three', 'three-addons-orbit', 'pixi', 'matter', 'moriko-gl']);

/** Reads a finite number out of an arbitrary per-variant object. */
function variantHeight(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  return num(source as Record<string, unknown>, 'height');
}

/** Reads a title string out of an arbitrary per-variant object. */
function variantTitle(source: unknown): string {
  if (!source || typeof source !== 'object') return '';
  return str(source as Record<string, unknown>, 'title');
}

/** Clamps one height request to the card's window. */
function clampHeight(requested: number | undefined): number {
  return requested === undefined ? 360 : Math.round(Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, requested)));
}

/** Validates one candidate document; returns the error message or null. */
function variantError(source: string): string | null {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > VARIANT_MAX_BYTES) {
    return `${bytes} bytes — the per-variant cap is ${VARIANT_MAX_BYTES} (256 KB)`;
  }
  return null;
}

/**
 * One render_visual call → a VisualPayload + a text summary for the model.
 *
 * THREE modes share one entry point:
 *  - `variants` present            → frontend preview (1..3 candidates, one card)
 *  - `id` of an existing visual    → edit-in-place (replaces that card live)
 *  - otherwise                     → new visual (classic Fase-D behavior)
 */
export function renderVisualTool(args: Record<string, unknown>, ctx: AgentToolContext): HarnessToolResult {
  const title = str(args, 'title').trim().slice(0, 120);

  // ── FRONTEND PREVIEW (variants) ────────────────────────────────────────
  const rawVariants = args.variants;
  if (Array.isArray(rawVariants)) {
    return renderPreview(args, rawVariants, title);
  }

  const source = str(args, 'source').trim();
  if (!source) {
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text:
        'render_visual needs "source": a COMPLETE standalone HTML document (<!doctype html>…</html>). ' +
        'Alternatives: pass "id" of an existing visual to edit it in place, or "variants" (1..3) for a frontend preview.',
    };
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > VISUAL_MAX_BYTES) {
    return {
      ok: false,
      isError: true,
      errorCode: 'visual_too_large',
      text:
        `"source" is ${bytes} bytes — the cap is ${VISUAL_MAX_BYTES} (256 KB). ` +
        'Split the visual, move data to a workspace file, or simplify the markup.',
    };
  }

  const height = clampHeight(num(args, 'height'));
  const rawLibs = Array.isArray(args.libs) ? args.libs : [];
  const libs = [...new Set(rawLibs.filter((l): l is string => typeof l === 'string' && VISUAL_LIBS.has(l)))];
  const badLibs = rawLibs.filter((l) => typeof l === 'string' && !VISUAL_LIBS.has(l));
  if (badLibs.length > 0) {
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: `Unknown lib(s): ${badLibs.join(', ')}. Available: ${[...VISUAL_LIBS].join(', ')}.`,
    };
  }
  visualSeq += 1;
  const requestedId = str(args, 'id').trim();
  const editing = requestedId.length > 0;

  /** EDIT-IN-PLACE — validate the id against THIS conversation's stored
   *  visuals and rewrite the record BEFORE the card event rides. An unknown
   *  id fails fast WITH the stored ids, so a hallucinated id costs one
   *  corrected call instead of a phantom card. */
  if (editing) {
    const stored = ctx.sessionId ? listStoredVisuals(ctx.sessionId) : [];
    if (!stored.some((entry) => entry.id === requestedId)) {
      const known = stored
        .slice(0, 10)
        .map((entry) => `"${entry.id}" (${entry.title})`)
        .join(', ');
      return {
        ok: false,
        isError: true,
        errorCode: 'visual_not_found',
        text:
          `"id" "${requestedId}" does not match any visual in this conversation ` +
          `(stored: ${known || 'none yet'}). Pass the id EXACTLY as a previous render summary ` +
          'returned it, or omit "id" to render a NEW visual.',
      };
    }
    if (ctx.sessionId) {
      updateStoredVisual(ctx.sessionId, requestedId, {
        html: source,
        height,
        ...(title ? { title } : {}),
      });
    }
  }

  const visual: VisualPayload = {
    id: editing ? requestedId : `visual_${Date.now().toString(36)}_${visualSeq}`,
    html: source,
    title: title || (editing ? 'Visual (edited)' : 'Visual'),
    height,
    ...(libs.length > 0 ? { libs } : {}),
    ...(editing ? { replaces: true as const } : {}),
  };

  if (!editing) {
    void publishBusEvent(VISUAL_BUS_TOPICS.render, {
      visualId: visual.id,
      title: visual.title,
    }, 'render_visual');
    return {
      ok: true,
      isError: false,
      text: truncateOutput(
        `Visual rendered: "${visual.title}" (${height}px tall, ${(bytes / 1024).toFixed(1)} KB` +
          `${libs.length > 0 ? `, libs: ${libs.join(', ')}` : ''}). ` +
          `Id: ${visual.id}. The user sees it live in the thread. To change it, call render_visual ` +
          `again with the SAME id ("id": "${visual.id}") — the card updates in place, no new card. ` +
          'Network access is disabled inside the sandbox: inline styles/scripts only; vendor libs are injected client-side from the harness origin.',
      ),
      visual,
    };
  }

  void publishBusEvent(VISUAL_BUS_TOPICS.update, {
    visualId: visual.id,
    title: visual.title,
  }, 'render_visual');
  return {
    ok: true,
    isError: false,
    text: truncateOutput(
      `Visual "${visual.title}" (${visual.id}) updated IN PLACE — the user's card now shows the new ` +
        `version (${height}px tall, ${(bytes / 1024).toFixed(1)} KB). The old frame stays in history as ` +
        'the audit trail; the live card re-bound to this payload. Keep editing with the same id, or ' +
        'call render_visual WITHOUT id to spawn a separate new card.',
    ),
    visual,
  };
}

/** The frontend-preview path: validates 1..3 candidates, builds the card payload. */
function renderPreview(args: Record<string, unknown>, rawVariants: unknown[], title: string): HarnessToolResult {
  const trimmed = rawVariants.slice(0, VISUAL_MAX_VARIANTS);
  const tooMany = rawVariants.length - trimmed.length;
  if (trimmed.length === 0) {
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: 'render_visual "variants" needs 1..3 candidate documents: [{ source, title?, height? }, …].',
    };
  }

  const variants: NonNullable<VisualPayload['variants']> = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    const entry = trimmed[index];
    if (!entry || typeof entry !== 'object') {
      return {
        ok: false,
        isError: true,
        errorCode: 'schema_error',
        text: `variants[${index}] must be an object { source, title?, height? }.`,
      };
    }
    const record = entry as Record<string, unknown>;
    const source = str(record, 'source').trim();
    if (!source) {
      return {
        ok: false,
        isError: true,
        errorCode: 'schema_error',
        text: `variants[${index}] needs "source": a COMPLETE standalone HTML document.`,
      };
    }
    const problem = variantError(source);
    if (problem) {
      return {
        ok: false,
        isError: true,
        errorCode: 'visual_too_large',
        text: `variants[${index}] "source" is ${problem}.`,
      };
    }
    visualSeq += 1;
    variants.push({
      id: `visual_${Date.now().toString(36)}_${visualSeq}`,
      html: source,
      title: (variantTitle(record).trim() || `Variant ${index + 1}`).slice(0, 120),
      height: clampHeight(variantHeight(record)),
    });
  }

  const cardTitle = (title || 'Frontend preview').slice(0, 120);
  const widthHeight = clampHeight(num(args, 'height'));
  visualSeq += 1;
  const visual: VisualPayload = {
    id: `visual_${Date.now().toString(36)}_${visualSeq}`,
    html: variants[0]!.html,
    title: cardTitle,
    height: widthHeight,
    variants,
  };

  void publishBusEvent(VISUAL_BUS_TOPICS.render, {
    visualId: visual.id,
    title: cardTitle,
  }, 'render_visual');

  return {
    ok: true,
    isError: false,
    text: truncateOutput(
      `Frontend preview rendered: ${variants.length} candidate${variants.length === 1 ? '' : 's'} in one card` +
        `${tooMany > 0 ? ` (${tooMany} extra candidates dropped — max ${VISUAL_MAX_VARIANTS})` : ''}. ` +
        `Card id: ${visual.id}. Candidate ids: ${variants.map((variant) => variant.id).join(', ')}. ` +
        'The user sees them side by side (or tabbed) and PICKS one — the pick arrives back as a ' +
        'tool_result-shaped event: "User picked <id>: <title>. Selected candidate: N of M." When the ' +
        'pick lands, refine ONLY the chosen candidate with render_visual + its id (edit-in-place).',
    ),
    visual,
  };
}

/**
 * The card's PICK handler — server side. The client posts the user's choice;
 * this broadcasts it to every other browser (card re-binds the chosen frame)
 * and returns the exact tool_result-shaped sentence the client turns into a
 * steer so the RUNNING model learns the decision. Returns null for unknown
 * shapes — the caller surfaces a schema error then.
 */
export function resolveVisualPick(args: {
  visualId?: unknown;
  variantId?: unknown;
  variantIndex?: unknown;
  title?: unknown;
}): { steerText: string } | null {
  const visualId = typeof args.visualId === 'string' ? args.visualId.trim() : '';
  const variantId = typeof args.variantId === 'string' ? args.variantId.trim() : '';
  const variantIndex = typeof args.variantIndex === 'number' && Number.isFinite(args.variantIndex)
    ? args.variantIndex
    : undefined;
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!visualId || !variantId) return null;
  const position = typeof variantIndex === 'number' ? `${variantIndex + 1}` : '?';
  return {
    steerText:
      `User picked ${variantId}${title ? `: ${title}` : ''}. ` +
      `Selected candidate ${position} of the preview card ${visualId}. ` +
      'Continue from that frontend; use render_visual with id="' + variantId + '" to refine it in place.',
  };
}
