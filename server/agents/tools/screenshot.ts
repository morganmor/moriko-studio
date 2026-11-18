
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { bool, checkWebAccessUrl, str } from './shared.js';
import { lookupModelMetadata } from '../../modelMetadata.js';
import { CAPTURE_SCRIPT, type CaptureReport } from './page-report.js';
import { acquireEphemeralContext } from '../browser/engine.js';

const JPEG_QUALITY = 72;
const MAX_ELEMENTS = 20;
const MAX_ELEMENTS_FULL = 40;

export async function screenshotTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const meta = ctx.modelId ? lookupModelMetadata(ctx.modelId) : undefined;
  const url = str(args, 'url').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, isError: true, errorCode: 'schema_error', text: 'screenshot needs "url" (http/https).' };
  }
  const blocked = checkWebAccessUrl(url, ctx, 'agent__screenshot');
  if (blocked) {
    return { ok: false, isError: true, errorCode: 'web_access_off', text: blocked };
  }

  let context: import('playwright-core').BrowserContext;
  try {
    context = await acquireEphemeralContext();
  } catch (error) {
    return { ok: false, isError: true, text: `screenshot failed to launch a headless browser: ${error instanceof Error ? error.message : String(error)}` };
  }

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(150);

    const fullPage = bool(args, 'fullPage');
    const selector = str(args, 'selector');
    const wantElements = bool(args, 'full') ? MAX_ELEMENTS_FULL : MAX_ELEMENTS;

    const capture = (await page.evaluate(CAPTURE_SCRIPT)) as CaptureReport;
    const shotBuffer = selector
      ? await page.locator(selector).screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 10_000 })
      : await page.screenshot({ fullPage, type: 'jpeg', quality: JPEG_QUALITY });

    const elements = capture.interactive.slice(0, wantElements);
    const lines = [
      `Page: ${page.url()}`,
      `Title: "${capture.title}"`,
      `Viewport: ${capture.viewport.w}×${capture.viewport.h} @dpr ${capture.viewport.dpr} · scrollY ${capture.scrollY}`,
      `Perf: FCP ${capture.timing.fcp}ms · TTFB ${capture.timing.ttfb}ms · LCP ${capture.timing.lcp}ms`,
      `Screenshot: ${selector ? `element "${selector}"` : fullPage ? 'full page' : 'viewport'} (JPEG q${JPEG_QUALITY}${meta && !meta.imageIn ? ' — NOT attached: model has no image input' : ' attached inline'})`,
      elements.length
        ? 'Interactive elements (click #n via browser_click { x: box[0]+box[2]/2, y: box[1]+box[3]/2 } in the BUILT-IN browser, or read them textually):'
        : 'No interactive elements visible.',
      ...elements.map((el) => `  #${el.n} ${el.role} "${el.text}" box=[${el.box.join(',')}] sel=${el.sel}`),
    ];
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
      text: `screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}
