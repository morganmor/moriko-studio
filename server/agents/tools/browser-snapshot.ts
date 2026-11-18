
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { bool, checkWebAccessUrl, str } from './shared.js';
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
  const canSee = meta ? meta.imageIn : true;
  const sid = ctx.sessionId;

  const navigate = str(args, 'url').trim();
  if (navigate) {
    if (browserManager.isTakeover(sid)) {
      return { ok: false, isError: true, errorCode: 'browser_takeover', text: browserManager.takeoverNotice(sid) };
    }
    try {
      const target = browserManager.assertUrl(navigate, true, sid);
      const blocked = checkWebAccessUrl(target.toString(), ctx, 'agent__browser_snapshot');
      if (blocked) {
        return { ok: false, isError: true, errorCode: 'web_access_off', text: blocked };
      }
      const page = await browserManager.getActivePage(sid);
      await page.goto(target.toString(), { waitUntil: 'commit', timeout: 30_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(150);
      browserManager.logAction('open', `snapshot-navigate → ${page.url()}`, sid);
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
    const page = await browserManager.getActivePage(sid);
    const fullPage = bool(args, 'fullPage');
    const selector = str(args, 'selector');
    const wantElements = bool(args, 'full') ? MAX_ELEMENTS_FULL : MAX_ELEMENTS;

    const capture = (await page.evaluate(CAPTURE_SCRIPT)) as CaptureReport;
    const shotBuffer = selector
      ? await page.locator(selector).screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 10_000 })
      : await page.screenshot({ fullPage, type: 'jpeg', quality: JPEG_QUALITY });

    const diag = browserManager.getDiagnostics(undefined, sid);
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
