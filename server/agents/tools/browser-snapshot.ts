/**
 * agent__browser_snapshot — ONE-call page observer for Moriko's built-in
 * browser. Replaces the chromedev-MCP screenshot role with a TEXT-FIRST,
 * image-second design: the result ALWAYS carries page context any model can
 * act on (URL/title/viewport/timing, console errors + warnings, failed
 * 4xx/5xx requests, a numbered interactive-element map), while the JPEG
 * capture rides along inline for vision-capable models.
 *
 *   url?      — navigate first (same assertUrl gate + load waits as browser_open)
 *   selector? — photograph ONE element (the interactive map still covers the page)
 *   fullPage? — capture beyond the viewport (default false)
 *   full?     — widen the text map (40 vs 20 interactive elements)
 *
 * Click targeting: "#n → browser_click { x: box[0]+box[2]/2, y: box[1]+box[3]/2 }".
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { bool, requireWorkspace, str } from './shared.js';
import { browserManager } from '../browser/manager.js';
import { lookupModelMetadata } from '../../modelMetadata.js';
import { CAPTURE_SCRIPT, type CaptureReport } from './page-report.js';

const MAX_ELEMENTS = 20;
const MAX_ELEMENTS_FULL = 40;
const JPEG_QUALITY = 72;

export async function browserSnapshotTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const meta = ctx.modelId ? lookupModelMetadata(ctx.modelId) : undefined;
  const canSee = meta ? meta.imageIn : true; // unknown model → attach anyway

  const navigate = str(args, 'url').trim();
  if (navigate) {
    requireWorkspace(ctx);
    try {
      const target = browserManager.assertUrl(navigate, true);
      const page = await browserManager.getActivePage();
      await page.goto(target.toString(), { waitUntil: 'commit', timeout: 30_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      browserManager.logAction('open', `snapshot-navigate → ${page.url()}`);
    } catch (error) {
      return {
        ok: false,
        isError: true,
        errorCode: 'schema_error',
        text: `browser_snapshot navigate failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  try {
    const page = await browserManager.getActivePage();
    const fullPage = bool(args, 'fullPage');
    const selector = str(args, 'selector');
    const wantElements = bool(args, 'full') ? MAX_ELEMENTS_FULL : MAX_ELEMENTS;

    const capture = (await page.evaluate(CAPTURE_SCRIPT)) as CaptureReport;
    const shotBuffer = selector
      ? await page.locator(selector).screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 10_000 })
      : await page.screenshot({ fullPage, type: 'jpeg', quality: JPEG_QUALITY });

    const diag = browserManager.getDiagnostics();
    const fmt = (list: Array<{ text: string }>) => list.slice(-8).map((e) => `    ${e.text.slice(0, 160)}`);
    const failed = diag.http.filter((h) => /\b[45]\d\d\b/.test(h.text));
    const elements = capture.interactive.slice(0, wantElements);

    const lines = [
      `Page: ${page.url()}`,
      `Title: "${capture.title}"`,
      `Viewport: ${capture.viewport.w}×${capture.viewport.h} @dpr ${capture.viewport.dpr} · scrollY ${capture.scrollY}`,
      `Perf: FCP ${capture.timing.fcp}ms · TTFB ${capture.timing.ttfb}ms · LCP ${capture.timing.lcp}ms`,
      `Console: ${diag.console.length} entry(ies)${diag.console.length ? '\n' + fmt(diag.console).join('\n') : ''}`,
      `Page errors: ${diag.pageErrors.length}${diag.pageErrors.length ? '\n' + fmt(diag.pageErrors).join('\n') : ''}`,
      `HTTP 4xx/5xx: ${failed.length}${failed.length ? '\n' + fmt(failed).join('\n') : ''}`,
      `Screenshot: ${selector ? `element "${selector}"` : fullPage ? 'full page' : 'viewport'} (JPEG q${JPEG_QUALITY}${meta && !meta.imageIn ? ' — NOT attached: model has no image input' : ' attached inline'})`,
      elements.length
        ? 'Interactive elements (click #n via browser_click { x: box[0]+box[2]/2, y: box[1]+box[3]/2 }):'
        : 'No interactive elements visible.',
      ...elements.map((el) => `  #${el.n} ${el.role} "${el.text}" box=[${el.box.join(',')}] sel=${el.sel}`),
    ];
    void canSee;
    return {
      ok: true,
      isError: false,
      text: lines.join('\n'),
      images:
        meta && !meta.imageIn
          ? undefined
          : [{ mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${shotBuffer.toString('base64')}` }],
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
