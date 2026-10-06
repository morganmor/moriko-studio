/**
 * agent__spatial — Layout IR map / collision check / semantic diff (F1).
 *
 * Tier-1 static spatial harness (docs/plans/PLAN-SPATIAL-HARNESS.md). Three modes:
 *   map   — the workspace layout IR: absolutely positioned regions + collision
 *           candidates + warnings. Call BEFORE editing UI files: this is the
 *           "inilah medannya" context that stops blind coordinate edits (P1).
 *   check — same, but exit-shaped for gates: ok=false when collision
 *           candidates exist (after-edit verification, F3 feeds on this).
 *   diff  — semantic before/after: pass baselines captured via mode "map"
 *           (snapshot: true) or inline {before, after} JSON paths.
 *
 * Static honesty: overlaps are CANDIDATES (severity "soft") because static
 * coordinates are parent-relative; overlays (modal/tooltip/...) are exempt;
 * %/var()/calc() sizes are flagged, never faked into rects.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { callVisionModel, resolveImageSource } from '../vision.js';
import { getVisionConfig } from '../../visionConfig.js';
import { resolveCredentials } from '../../credentials.js';
import { providerStore } from '../../store.js';
import { fetchPublicImage } from './vision.js';
import { MOCKUP_PROMPT, parseMockupAnswer, parseImageDimensions, buildMockupMap } from '../spatial-mockup.js';
import {
  spatialMapForRoot,
  renderSpatialMap,
  diffSpatialMaps,
  renderSpatialDiff,
  type SpatialMap,
} from '../spatial.js';

/** Snapshot the CURRENT map as a diff baseline (returns the renderable IR). */
function snapshotPayload(map: SpatialMap): string {
  return JSON.stringify(
    {
      tier: map.tier,
      files: map.files,
      regions: map.regions,
      collisions: map.collisions,
      warnings: map.warnings,
      capturedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

function reviveMap(json: string): SpatialMap | null {
  try {
    const parsed = JSON.parse(json) as Partial<SpatialMap>;
    if (!parsed || !Array.isArray(parsed.regions)) return null;
    return {
      tier: parsed.tier === 'runtime' ? 'runtime' : 'static',
      url: parsed.url,
      viewport: parsed.viewport,
      files: parsed.files ?? [],
      regions: parsed.regions,
      collisions: parsed.collisions ?? [],
      warnings: parsed.warnings ?? [],
    };
  } catch {
    return null;
  }
}

export async function spatialTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = str(args, 'mode').trim().toLowerCase() || 'map';
  if (mode !== 'map' && mode !== 'check' && mode !== 'diff' && mode !== 'runtime' && mode !== 'mockup') {
    return {
      ok: false,
      isError: true,
      text: `Unknown mode "${mode}". Use mode: "map" (layout IR), "check" (collision gate), "diff" (before/after), or "runtime" (browser ground truth).`,
    };
  }
  const workspace = mode === 'diff' ? null : requireWorkspace(ctx);
  const root = workspace === null ? '' : workspace.root;

  if (mode === 'runtime') {
    const url = str(args, 'url').trim();
    if (!url) {
      return {
        ok: false,
        isError: true,
        text: 'runtime mode needs a "url" — the local dev server to measure, e.g. http://localhost:5173/.',
      };
    }
    try {
      const { captureRuntime, compareWithRuntime, renderRuntimeReport, readBaseline } = await import('../spatial-runtime.js');
      const allowPublic = args.allowPublic === true;
      const capture = await captureRuntime(url, {
        allowPublic,
        saveScreenshot: args.screenshot === false ? false : true,
        saveBaseline: args.saveBaseline === true,
      });
      let comparison;
      if (args.compareStatic === true) {
        const staticMap = spatialMapForRoot(root);
        comparison = compareWithRuntime(staticMap, capture.map);
      }
      const header = renderRuntimeReport(capture, comparison);
      const baselineNote =
        args.saveBaseline === true && readBaseline(url)
          ? `\n  · baseline persisted in the spatial-baselines dir (readable via the same capture)`
          : '';
      const shot = capture.screenshot ? `\n  · screenshot: ${capture.screenshot}` : '';
      const gateHint =
        capture.map.collisions.length > 0
          ? '\n\nHARD collisions are MEASURED FACTS from the real DOM — fix them before reporting done ' +
            '(agent__layout_edit computes the geometry; agent__spatial {mode:"check"} stays on the static tier).'
          : '';
      return {
        ok: true,
        isError: false,
        text: truncateOutput(`${header}${baselineNote}${shot}${gateHint}`),
      };
    } catch (error) {
      return {
        ok: false,
        isError: true,
        text: error instanceof Error ? error.message : 'runtime capture failed.',
      };
    }
  }

  if (mode === 'mockup') {
    const inputPath = str(args, 'path').trim();
    const url = str(args, 'url').trim();
    const dataUrl = str(args, 'dataUrl').trim();
    const source = inputPath || url || dataUrl;
    if (!source) {
      return {
        ok: false,
        isError: true,
        text: 'mockup mode needs ONE of: "path" (workspace image), "url" (public image URL), or "dataUrl" (a data: URL).',
      };
    }
    let resolvedSource: { buffer: Buffer; mime: string };
    try {
      if (inputPath) {
        const { absolute } = await resolveWithPermission('spatial', inputPath, ctx, 'read');
        const out = await resolveImageSource(absolute, fetchPublicImage);
        if (!out) {
          return { ok: false, isError: true, text: `"${inputPath}" is not a supported image (expected png/jpg/jpeg/gif/webp/bmp/tiff).` };
        }
        resolvedSource = out;
      } else {
        const out = await resolveImageSource(url || dataUrl, fetchPublicImage);
        if (!out) {
          return { ok: false, isError: true, text: 'The given url/dataUrl is not a supported image (expected an image content type).' };
        }
        resolvedSource = out;
      }
    } catch (error) {
      return { ok: false, isError: true, text: `mockup could not read the image: ${error instanceof Error ? error.message : 'unknown error.'}` };
    }

    const config = await getVisionConfig();
    if (!config.providerId || !config.model) {
      return {
        ok: false,
        isError: true,
        text: 'Vision is not configured. Ask the user to set it up: Configuration → Vision (provider + key + multimodal model). Then retry.',
      };
    }
    ctx.onProgress?.(`Segmenting the mockup with ${config.providerId}/${config.model}…`);
    let answerText: string;
    try {
      const result = await callVisionModel(
        { providerId: config.providerId, model: config.model, baseUrl: config.baseUrl },
        { buffer: resolvedSource.buffer, mime: resolvedSource.mime, question: MOCKUP_PROMPT },
        (providerId, browserKey) => resolveCredentials(providerStore, providerId, browserKey),
      );
      answerText = result.text;
    } catch (error) {
      return { ok: false, isError: true, text: `mockup segmentation failed: ${error instanceof Error ? error.message : 'vision call failed.'}` };
    }

    const parsed = parseMockupAnswer(answerText);
    if (typeof parsed === 'string') {
      return {
        ok: false,
        isError: true,
        text: `${parsed}\n\nThe raw answer starts with: "${answerText.slice(0, 200)}…"`,
      };
    }
    const intrinsic = parseImageDimensions(resolvedSource.buffer, resolvedSource.mime);
    const map = buildMockupMap(parsed, source, intrinsic);
    return {
      ok: true,
      isError: false,
      text: truncateOutput([
        renderSpatialMap(map),
        '',
        'This is the DESIGN TARGET. Implement it with flow/flex/grid first (the boxes are intent, not ' +
        'pixel verdicts), then verify with agent__spatial {mode:"runtime", url} against a live page.',
      ].join('\n')),
    };
  }

  if (mode === 'diff') {
    const beforeRaw = str(args, 'before');
    const afterRaw = str(args, 'after');
    if (!beforeRaw || !afterRaw) {
      return {
        ok: false,
        isError: true,
        text:
          'diff mode needs TWO baselines. Capture each with mode "map" + snapshot: true, then pass the JSON strings as before/after — ' +
          'or run spatial {mode:"diff", before:<baselineA>, after:<baselineB>} in one call after editing.',
      };
    }
    const before = reviveMap(beforeRaw);
    const after = reviveMap(afterRaw);
    if (!before || !after) {
      return {
        ok: false,
        isError: true,
        text: 'before/after must be SpatialMap JSON (capture with mode "map" + snapshot: true).',
      };
    }
    const diff = diffSpatialMaps(before, after);
    return { ok: true, isError: false, text: truncateOutput(renderSpatialDiff(diff)) };
  }

  const map = spatialMapForRoot(root);
  if (map.regions.length === 0) {
    return {
      ok: true,
      isError: false,
      text:
        'No absolutely-positioned regions found (static tier scans CSS rules + JSX inline styles only). ' +
        'Layout is flow/flex/grid based or out of static reach — nothing to collide at this tier.',
    };
  }

  if (str(args, 'snapshot').trim().toLowerCase() === 'true') {
    return { ok: true, isError: false, text: snapshotPayload(map) };
  }

  const header =
    mode === 'check'
      ? `SPATIAL CHECK (static tier) — ${map.collisions.length} collision candidate(s), ${map.warnings.length} warning(s)`
      : renderSpatialMap(map);

  const body =
    mode === 'check'
      ? [
          `SPATIAL CHECK (static tier) — ${map.collisions.length} collision candidate(s), ${map.warnings.length} warning(s)`,
          ...map.collisions.map(
            (c) =>
              `  ! candidate ${c.severity}: ${c.a} ∩ ${c.b} — overlap(${c.overlap.x},${c.overlap.y},${c.overlap.w},${c.overlap.h})`,
          ),
          ...map.warnings.map((w) => `  ~ ${w}`),
        ].join('\n')
      : header;

  const tail =
    mode === 'check' && map.collisions.length > 0
      ? '\n\nResolve these BEFORE reporting the edit done: adjust the overlapping boxes or convert to flow/flex/grid. ' +
        'Static overlaps are candidates (parent-relative coords) — agent__spatial {mode:"diff"} against a pre-edit baseline shows exactly what YOUR edit moved.'
      : '';

  const gateNote =
    mode === 'check' && map.collisions.length === 0
      ? '\n\nNo overlap candidates at static tier. For full truth (real boxes, media queries, stacking) the F4 runtime tier is pending.'
      : '';

  return {
    ok: mode === 'check' ? map.collisions.length === 0 : true,
    isError: mode === 'check' && map.collisions.length > 0,
    text: truncateOutput(`${body}${tail}${gateNote}`),
  };
}
