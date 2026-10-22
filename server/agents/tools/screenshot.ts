/**
 * agent__screenshot — STANDALONE headless page capture for Moriko.
 *
 * Deliberately INDEPENDENT of the built-in browser toolkit and its Web Access
 * kill-switch (owner decision 2026-10-21): this is an ephemeral, read-only,
 * profile-less capture — navigate (localhost or any http/https URL), shoot,
 * collect a text-first page report, close. It never touches the persistent
 * browser context, its cookies, or its panel, and writes nothing to disk —
 * the JPEG returns inline.
 *
 *   url (required) — http/https target
 *   fullPage?      — capture beyond the viewport
 *   selector?      — photograph ONE element
 *   full?          — widen the interactive-element map (40 vs 20)
 *
 * Result = text report (URL/title/viewport, FCP/TTFB/LCP, numbered
 * interactive-element map for click targeting) + inline JPEG for
 * vision-capable models; text-only models still get the full report.
 */
import { chromium, type Browser } from 'playwright-core';

import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { bool, str } from './shared.js';
import { lookupModelMetadata } from '../../modelMetadata.js';
import { CAPTURE_SCRIPT, type CaptureReport } from './page-report.js';

const JPEG_QUALITY = 72;
const MAX_ELEMENTS = 20;
const MAX_ELEMENTS_FULL = 40;
/** Idle headless browser is torn down on the next call after this. */
const IDLE_CLOSE_MS = 5 * 60_000;

let sharedBrowser: { browser: Browser; lastUsed: number } | null = null;

/** Reuses a healthy headless browser across calls; relaunches when dead. */
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.browser.isConnected()) {
    sharedBrowser.lastUsed = Date.now();
    return sharedBrowser.browser;
  }
  if (sharedBrowser) {
    await sharedBrowser.browser.close().catch(() => undefined);
    sharedBrowser = null;
  }
  const browser = await chromium.launch({ headless: true });
  sharedBrowser = { browser, lastUsed: Date.now() };
  return browser;
}

async function shutdownIdleBrowser(): Promise<void> {
  if (sharedBrowser && Date.now() - sharedBrowser.lastUsed > IDLE_CLOSE_MS) {
    await sharedBrowser.browser.close().catch(() => undefined);
    sharedBrowser = null;
  }
}

export async function screenshotTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const meta = ctx.modelId ? lookupModelMetadata(ctx.modelId) : undefined;
  const url = str(args, 'url').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, isError: true, errorCode: 'schema_error', text: 'screenshot needs "url" (http/https).' };
  }

  await shutdownIdleBrowser();
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    return { ok: false, isError: true, text: `screenshot failed to launch a headless browser: ${error instanceof Error ? error.message : String(error)}` };
  }

  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);

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
  }
}
