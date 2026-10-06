/**
 * agent__browser_* — the built-in browser tools (layer-1 actuator surface).
 *
 * Every handler delegates the real work to `browserManager`
 * (agents/browser/manager.ts): ONE persistent Edge context whose profile
 * (~/.moriko/browser-profile/) keeps cookies, localStorage and saved logins
 * alive across sessions. The tools are the ONLY way the agent touches the
 * browser — each call re-enters the tool pipeline (schema, audit, gates) like
 * every other agent tool, and each is callable as `tools.browser_*` inside
 * `agent__exec` for multi-step orchestration.
 *
 * Phase-1 tools (this file):
 *   browser_open        — navigate the active tab (assertAllowedTarget gate)
 *   browser_read        — page/element text
 *   browser_screenshot  — PNG of the viewport → inline image for the model
 *                         (vision gate: screenshot → judge → next step)
 *   browser_wait        — selector / load-state wait with timeout
 *   browser_eval        — JS in the page context (DOM extraction, positions)
 *   browser_url         — current URL + title
 *
 * Phase-2 tools (this file):
 *   browser_click       — click at coordinates (cursor moves first) or selector
 *   browser_type        — fill a selector, or click+type at the cursor position
 *   browser_cursor_move — move the harness cursor (visible state for Phase 3)
 *   browser_scroll      — mouse wheel / element scroll
 *
 * Phase-3 tools (this file):
 *   browser_handover    — hand control to the user (takeover starts)
 *   browser_release     — take control back after the user is done
 *   browser_tabs        — list tabs (ids for switch/close)
 *   browser_switch_tab  — make another tab active (capture follows)
 *   browser_close_tab   — close a tab
 *
 * TAKEOVER GUARD: every INPUT tool checks browserManager.isTakeover() first —
 * during a user takeover the agent must not act. Read-only tools (read /
 * screenshot / url / eval / wait) deliberately still work so the agent can
 * keep observing while the user drives.
 */
import type { HarnessToolResult, AgentToolContext, ToolImage } from './shared.js';
import { str, num, bool, truncateOutput, requireWorkspace } from './shared.js';
import { browserManager } from '../browser/manager.js';
import { requestApproval } from '../permissions.js';
import { lookupModelMetadata } from '../../modelMetadata.js';
import { htmlToMarkdown } from '../browser/markdown.js';
import { isInsideRoot } from '../workspace.js';
import fs from 'node:fs';
import path from 'node:path';

type Page = import('playwright-core').Page;

/** Uniform takeover refusal for every input tool. */
function takeoverRefusal(): HarnessToolResult {
  return {
    ok: false,
    isError: true,
    errorCode: 'browser_takeover',
    text: browserManager.takeoverNotice(),
  };
}


export async function browserOpenTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const raw = str(args, 'url');
  if (!raw.trim()) {
    return { ok: false, isError: true, text: 'browser_open needs a "url" (full http(s) URL).' };
  }
  requireWorkspace(ctx);

  let url: URL;
  try {
    url = browserManager.assertUrl(raw, bool(args, 'allowPublic') || true);
  } catch (error) {
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const newTab = bool(args, 'newTab');
    const page = newTab ? (await browserManager.openInNewTab()).page : await browserManager.getActivePage();
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
    try {
      await page.waitForLoadState('networkidle', { timeout: 4_000 });
    } catch {
    }
    const title = await page.title().catch(() => '');
    browserManager.logAction('open', `${page.url()}${newTab ? ' (new tab)' : ''} — "${title.slice(0, 60)}"`);
    const panelQuery = ctx.sessionId ? `?session=${encodeURIComponent(ctx.sessionId)}` : '';
    return {
      ok: true,
      isError: false,
      panelUrl: `/browser-view.html${panelQuery}`,
      text: `Opened ${page.url()} — title: "${title || '(untitled)'}"`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_open failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserReadTool(
  args: Record<string, unknown>,
  _ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  void _ctx;
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector');
    const frameSel = str(args, 'frame');
    // form previews and devtools-style pages DO echo them back; belt and
    const maskSensitive = args.maskSensitive === undefined ? true : args.maskSensitive === true;

    const cacheKey = `read:${selector || 'body'}:${maskSensitive ? 'm' : 'r'}`;
    const cached = browserManager.getCachedDom<string>(cacheKey, page.url());
    if (cached !== undefined) {
      return { ok: true, isError: false, text: truncateOutput(cached) };
    }

    const secrets = maskSensitive
      ? ((await page.evaluate(
          `(() => {
            const out = [];
            for (const el of document.querySelectorAll('input[type=password],input[autocomplete^="cc-"]')) {
              if (el.value && String(el.value).length >= 3) out.push(String(el.value));
            }
            return out;
          })()`,
        )) as unknown as string[]) ?? []
      : [];
    const text = frameSel
      ? await page.frameLocator(frameSel).locator(selector || 'body').innerText({ timeout: 15_000 })
      : selector
      ? await page.evaluate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fn serializes to the PAGE context, where DOM types exist
          ((sel: any) => ((globalThis as any).document?.querySelector(sel))?.innerText ?? '') as unknown as () => string,
          selector,
        )
      : await page.evaluate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (() => ((globalThis as any).document?.body?.innerText) ?? '') as unknown as () => string,
        );

    let masked = text;
    for (const secret of secrets) {
      masked = masked.split(secret).join('••••••••');
    }

    const trimmed = masked.trim();
    if (!trimmed) {
      return {
        ok: true,
        isError: false,
        text: selector
          ? `Element "${selector}" matched but has no visible text.`
          : 'Page body has no visible text yet — it may still be loading (call browser_wait first).',
      };
    }
    browserManager.putCachedDom(cacheKey, page.url(), trimmed);
    return { ok: true, isError: false, text: truncateOutput(trimmed) };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserScreenshotTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  const meta = ctx.modelId ? lookupModelMetadata(ctx.modelId) : undefined;
  if (meta && !meta.imageIn) {
    return {
      ok: false,
      isError: true,
      errorCode: 'vision_required',
      text:
        `browser_screenshot refused: model "${ctx.modelId}" has no native image input, so it cannot SEE the capture (the vision gate needs eyes). ` +
        'Judge the page from TEXT instead — browser_read / browser_eval / browser_url — ' +
        'or tell the user to switch to a vision-capable model. The user can always watch the page live in the browser panel.',
    };
  }
  try {
    const page = await browserManager.getActivePage();
    const fullPage = bool(args, 'fullPage');
    const selector = str(args, 'selector');

    const frameArg = str(args, 'frame');
    const buffer = frameArg
      ? await page.frameLocator(frameArg).locator('body').screenshot({ type: 'png', timeout: 10_000 })
      : selector
      ? await page.locator(selector).screenshot({ type: 'png', timeout: 10_000 })
      : await page.screenshot({ fullPage, type: 'png' });
    const image: ToolImage = {
      mime: 'image/png',
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    };
    return {
      ok: true,
      isError: false,
      text:
        `Screenshot captured (${frameArg ? `frame "${frameArg}"` : selector ? `element "${selector}"` : fullPage ? 'full page' : 'viewport'}). ` +
        'Use this image to decide the next step (vision gate: look → judge → act).',
      images: [image],
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


const WAIT_STATES = new Set(['attached', 'detached', 'hidden', 'visible']);

export async function browserWaitTool(
  args: Record<string, unknown>,
  _ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  void _ctx;
  try {
    const page = await browserManager.getActivePage();
    const timeoutMs = Math.min(Math.max(num(args, 'timeoutMs') ?? 15_000, 1_000), 60_000);
    const selector = str(args, 'selector');
    const loadState = str(args, 'loadState');
    const frameSel = str(args, 'frame');
    const urlPattern = str(args, 'url');
    const textWanted = str(args, 'text');
    const fnSource = str(args, 'function');

    if (urlPattern) {
      const predicate = urlPattern.startsWith('/') && urlPattern.endsWith('/') && urlPattern.length > 2
        ? new RegExp(urlPattern.slice(1, -1))
        : new RegExp(`^${urlPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[\\s\\S]*')}$`);
      await page.waitForURL(predicate, { timeout: timeoutMs });
      return { ok: true, isError: false, text: `URL now matches: ${page.url()}` };
    }
    if (textWanted) {
      await page.waitForFunction(
        ((t: string) => ((globalThis as unknown as { document?: { body?: { innerText: string } } }).document?.body?.innerText ?? '').includes(t)) as unknown as () => boolean,
        textWanted,
        { timeout: timeoutMs },
      );
      return { ok: true, isError: false, text: `Text "${textWanted.slice(0, 80)}" appeared.` };
    }
    if (fnSource) {
      await page.waitForFunction(`(() => { const fn = ${fnSource}; return typeof fn === 'function' ? fn() : Boolean(fn); })()`, { timeout: timeoutMs } as { timeout: number });
      return { ok: true, isError: false, text: 'Function predicate returned truthy.' };
    }
    if (selector) {
      const state = WAIT_STATES.has(str(args, 'state')) ? str(args, 'state') : 'visible';
      if (frameSel) {
        await page.frameLocator(frameSel).locator(selector).waitFor({ state: state as 'visible', timeout: timeoutMs });
        return { ok: true, isError: false, text: `Selector "${selector}" is ${state} inside frame "${frameSel}".` };
      }
      await page.waitForSelector(selector, { state: state as 'visible', timeout: timeoutMs });
      return { ok: true, isError: false, text: `Selector "${selector}" is ${state}.` };
    }
    if (loadState) {
      if (!['commit', 'domcontentloaded', 'load', 'networkidle'].includes(loadState)) {
        return {
          ok: false,
          isError: true,
          errorCode: 'schema_error',
          text: `loadState must be one of commit | domcontentloaded | load | networkidle (got "${loadState}").`,
        };
      }
      await page.waitForLoadState(loadState as 'load', { timeout: timeoutMs });
      return { ok: true, isError: false, text: `Load state "${loadState}" reached.` };
    }
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: 'browser_wait needs one of: selector | loadState | url | text | function.',
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_wait failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserEvalTool(
  args: Record<string, unknown>,
  _ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  void _ctx;
  try {
    const page = await browserManager.getActivePage();
    const script = str(args, 'script');
    const frameSel = str(args, 'frame');
    if (!script.trim()) {
      return { ok: false, isError: true, text: 'browser_eval needs a "script" (JS run in the page context).' };
    }
    let result: unknown;
    if (frameSel) {
      const handle = await page.$(frameSel);
      if (!handle) return { ok: false, isError: true, text: `No iframe matches "${frameSel}" on this page.` };
      const frame = await handle.contentFrame();
      if (!frame) return { ok: false, isError: true, text: `"${frameSel}" has no content frame (about:blank or cross-origin dead frame).` };
      result = await frame.evaluate(script);
    } else {
      result = await page.evaluate(script);
    }
    browserManager.invalidateDomCache();
    return {
      ok: true,
      isError: false,
      text: truncateOutput(typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? String(result)),
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_eval failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserUrlTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  void ctx;
  void args;
  try {
    const page = await browserManager.getActivePage();
    const url = page.url();
    const title = await page.title().catch(() => '');
    return { ok: true, isError: false, text: `${url}\nTitle: ${title || '(untitled)'}` };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_url failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserClickTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector');
    const hasCoords = args.x !== undefined || args.y !== undefined;

    if (hasCoords) {
      const x = num(args, 'x') ?? 0;
      const y = num(args, 'y') ?? 0;
      const buttonArg = str(args, 'button');
      const button = buttonArg === 'right' || buttonArg === 'middle' ? buttonArg : 'left';
      const clickCount = Math.max(1, Math.min(3, num(args, 'clickCount') ?? 1));
      await browserManager.moveCursor(x, y);
      await page.mouse.click(x, y, { button, clickCount });
      browserManager.broadcastClick(x, y);
      browserManager.logAction('click', `(${Math.round(x)}, ${Math.round(y)})${button !== 'left' ? ` [${button}]` : ''}${clickCount !== 1 ? ` ×${clickCount}` : ''}${selector ? ` on ${selector}` : ''}`);
      return {
        ok: true,
        isError: false,
        text: `Clicked (${Math.round(x)}, ${Math.round(y)})${button !== 'left' ? ` [${button}]` : ''}${clickCount !== 1 ? ` ×${clickCount}` : ''}.`,
      };
    }
    if (selector) {
      if (str(args, 'frame')) {
        const frameSel = str(args, 'frame') as string;
        await page.frameLocator(frameSel).locator(selector).click({ timeout: 15_000 });
        browserManager.logAction('click', `${selector} in frame "${frameSel}"`);
        return { ok: true, isError: false, text: `Clicked "${selector}" inside frame "${frameSel}".` };
      }
      await page.click(selector, { timeout: 15_000 });
      try {
        const box = await page.evaluate(
          ((sel: unknown) => {
            const el = (globalThis as unknown as { document?: { querySelector(sel: string): { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null } }).document?.querySelector(sel as string);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }) as unknown as (sel: string) => { x: number; y: number } | null,
          selector,
        );
        if (box) {
          browserManager.moveCursor(box.x, box.y).catch(() => undefined);
          browserManager.broadcastClick(box.x, box.y);
        }
      } catch {
      }
      return { ok: true, isError: false, text: `Clicked selector "${selector}".` };
    }
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: 'browser_click needs either { x, y } coordinates or a { selector }. Get positions via browser_eval + getBoundingClientRect.',
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_click failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserTypeTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  try {
    const page = await browserManager.getActivePage();
    const text = str(args, 'text');
    if (text.length === 0 && !bool(args, 'pressEnter')) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_type needs a "text" (or pressEnter: true).' };
    }
    const selector = str(args, 'selector');
    const pressEnter = bool(args, 'pressEnter');
    const delay = Math.min(Math.max(num(args, 'delayMs') ?? 0, 0), 250);

    if (selector) {
      await page.fill(selector, text, { timeout: 15_000 });
      if (pressEnter) await page.keyboard.press('Enter');
      browserManager.logAction('type', `${text.length} char(s) into "${selector}"${pressEnter ? ' + Enter' : ''}`);
      return { ok: true, isError: false, text: `Typed ${text.length} char(s) into "${selector}"${pressEnter ? ' + Enter' : ''}.` };
    }

    await page.keyboard.type(text, { delay });
    if (pressEnter) await page.keyboard.press('Enter');
    browserManager.logAction('type', `${text.length} char(s) at cursor${pressEnter ? ' + Enter' : ''}`);
    return { ok: true, isError: false, text: `Typed ${text.length} char(s) at the cursor position${pressEnter ? ' + Enter' : ''}.` };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_type failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserCursorMoveTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const x = num(args, 'x');
    const y = num(args, 'y');
    if (x === undefined || y === undefined) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_cursor_move needs both "x" and "y" (viewport coords, 0,0 = top-left).' };
    }
    const stepsArg = num(args, 'steps');
    const stepCount = stepsArg !== undefined ? Math.max(1, Math.min(100, Math.round(stepsArg))) : 1;
    const cursor = await browserManager.moveCursor(x, y, stepCount);
    return {
      ok: true,
      isError: false,
      text: `Cursor at (${Math.round(cursor.x)}, ${Math.round(cursor.y)}) — visible.`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_cursor_move failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export async function browserScrollTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  try {
    const page = await browserManager.getActivePage();
    const direction = str(args, 'direction') || 'down';
    const amount = Math.min(Math.max(num(args, 'amount') ?? 900, 50), 5000);
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'direction must be up | down | left | right.' };
    }

    const selector = str(args, 'selector');
    if (selector) {
      await page.hover(selector, { timeout: 10_000 });
    }

    await page.mouse.wheel(deltaX, deltaY);
    browserManager.broadcast({ type: 'scrolled', deltaX, deltaY });

    await page.evaluate('(() => { delete globalThis.__morikoScrollSettle; return true; })()').catch(() => undefined);
    await page
      .waitForFunction(
        '(() => { const el = document.scrollingElement; if (!el) return true; const cur = el.scrollTop; if (globalThis.__morikoScrollSettle === cur) return true; globalThis.__morikoScrollSettle = cur; return false; })()',
        undefined,
        { polling: 'raf', timeout: 1_000 },
      )
      .catch(() => undefined);

    const pos = await page.evaluate(
      (() => {
        const el = (globalThis as unknown as { document?: { scrollingElement?: { scrollTop: number; scrollLeft: number } } }).document?.scrollingElement;
        return el ? { top: el.scrollTop, left: el.scrollLeft } : null;
      }) as unknown as () => { top: number; left: number } | null,
    );
    return {
      ok: true,
      isError: false,
      text:
        `Scrolled ${direction} by ${amount}px${selector ? ` (over "${selector}")` : ''}.` +
        (pos ? ` Page scroll: top=${Math.round(pos.top)}, left=${Math.round(pos.left)}.` : ''),
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_scroll failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


export function browserStatusText(): string {
  const cursor = browserManager.getCursor();
  const live = browserManager.isLive();
  const vp = browserManager.getViewport();
  return [
    `Browser live: ${live ? 'yes' : 'no (launched on first use)'}`,
    `Mode: ${browserManager.isTakeover() ? 'TAKEOVER (user driving)' : 'agent'}`,
    `Cursor: (${Math.round(cursor.x)}, ${Math.round(cursor.y)}) ${cursor.visible ? 'visible' : 'hidden'}`,
    `Viewport: ${vp.width}×${vp.height}`,
  ].join('\n');
}


export async function browserHandoverTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) {
    return { ok: true, isError: false, text: 'Takeover is already active — the user is already in control.' };
  }
  browserManager.startTakeover(`agent:${ctx.sessionId ?? 'unknown'}`);
  const message = str(args, 'message');
  return {
    ok: true,
    isError: false,
    text:
      'Handed the browser to the user (takeover mode active). ' +
      (message ? `Message shown on the panel: "${message}". ` : '') +
      'Your input tools are now refused until browser_release. Read-only tools still work if you need to observe.',
  };
}

export async function browserReleaseTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void args;
  if (!browserManager.isTakeover()) {
    return { ok: true, isError: false, text: 'No takeover was active — you already have control.' };
  }
  browserManager.endTakeover();
  return {
    ok: true,
    isError: false,
    text: 'Control returned to the agent (takeover ended). Your input tools work again.',
  };
}


export async function browserTabsTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void args;
  try {
    const tabs = await browserManager.listTabs();
    if (tabs.length === 0) {
      return { ok: true, isError: false, text: 'No open tabs — call browser_open to start one.' };
    }
    const lines = tabs.map(
      (t) =>
        `${t.active ? '▶' : ' '} ${t.id}: ${t.url}${t.title ? ` — "${t.title}"` : ''}`,
    );
    return {
      ok: true,
      isError: false,
      text: `Open tabs (${tabs.length}):\n${lines.join('\n')}`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_tabs failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function browserSwitchTabTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  try {
    const tabId = str(args, 'tabId');
    if (!tabId) {
      return {
        ok: false,
        isError: true,
        errorCode: 'schema_error',
        text: 'browser_switch_tab needs a "tabId" — list them with browser_tabs first.',
      };
    }
    await browserManager.switchTo(tabId);
    const page = await browserManager.getActivePage();
    const title = await page.title().catch(() => '');
    return {
      ok: true,
      isError: false,
      text: `Active tab is now ${tabId} — ${page.url()}${title ? ` — "${title}"` : ''}. The panel stream follows it.`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_switch_tab failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function browserCloseTabTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  try {
    const tabId = str(args, 'tabId');
    const tabs = await browserManager.listTabs();
    if (tabs.length === 0) {
      return { ok: true, isError: false, text: 'No tabs are open.' };
    }
    const target = tabId || tabs.find((t) => t.active)?.id || tabs[0].id;
    await browserManager.closePage(target);
    const remaining = await browserManager.listTabs();
    return {
      ok: true,
      isError: false,
      text:
        `Closed ${target}. ${remaining.length > 0 ? `Remaining: ${remaining.map((t) => t.id).join(', ')}.` : 'No tabs remain — browser_open starts a fresh one.'}`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_close_tab failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function browserClearDataTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  try {
    const cookiesWanted = args.cookies === undefined ? true : args.cookies === true;
    const storageWanted = args.storage === undefined ? true : args.storage === true;
    const cacheWanted = args.cache === undefined ? true : args.cache === true;
    if (!cookiesWanted && !storageWanted && !cacheWanted) {
      return { ok: false, isError: true, text: 'browser_clear_data: nothing requested — pass cookies/storage/cache (default all true).' };
    }

    const session = await browserManager.ensureContext();
    const page = await browserManager.getActivePage();
    const origin = new URL(page.url()).origin;
    const cleared: string[] = [];

    if (cookiesWanted) {
      const before = await session.context.cookies().catch(() => [] as Array<{ name: string }>);
      await session.context.clearCookies();
      cleared.push(`${before.length} cookie(s)`);
    }
    if (storageWanted) {
      const stats = await page.evaluate(
        `(() => {
          const ls = window.localStorage.length, ss = window.sessionStorage.length;
          window.localStorage.clear();
          window.sessionStorage.clear();
          return { ls, ss };
        })()`,
      ) as unknown as { ls?: number; ss?: number };
      cleared.push(`storage for ${origin} (${stats?.ls ?? 0} local + ${stats?.ss ?? 0} session key(s))`);
    }
    if (cacheWanted) {
      const cdp = await session.context.newCDPSession(page);
      await cdp.send('Network.clearBrowserCache');
      await cdp.detach().catch(() => undefined);
      cleared.push('HTTP cache');
    }

    return {
      ok: true,
      isError: false,
      text:
        `Browser data cleared: ${cleared.join(', ')}. ` +
        'Logins on affected sites are gone — the next browser_open starts anonymous.',
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_clear_data failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


function parseButton(args: Record<string, unknown>): 'left' | 'right' | 'middle' {
  const b = str(args, 'button');
  return b === 'right' || b === 'middle' ? b : 'left';
}

/**
 * agent__browser_drag — interpolated drag: down → N× move → up.
 * Draws smooth lines on canvas apps (steps interpolate the stroke), drags
 * sliders, rearranges drag-drop lists. steps=24 default = smooth visible line.
 */
export async function browserDragTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const fromX = num(args, 'fromX');
    const fromY = num(args, 'fromY');
    const toX = num(args, 'toX');
    const toY = num(args, 'toY');
    if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
      return {
        ok: false,
        isError: true,
        errorCode: 'schema_error',
        text: 'browser_drag needs fromX, fromY, toX, toY (viewport CSS px, 0,0 = top-left).',
      };
    }
    if (browserManager.isMouseDown()) {
      return {
        ok: false,
        isError: true,
        errorCode: 'mouse_state',
        text: 'A stroke is in progress (mouse down from browser_mouse_down) — finish it with browser_mouse_up before starting a drag.',
      };
    }
    const steps = Math.max(1, Math.min(200, num(args, 'steps') ?? 24));
    const delayMs = Math.max(0, Math.min(100, num(args, 'delayMs') ?? 8));
    const button = parseButton(args);
    await browserManager.performDrag(fromX, fromY, toX, toY, steps, button, delayMs);
    browserManager.logAction('drag', `(${Math.round(fromX)}, ${Math.round(fromY)}) → (${Math.round(toX)}, ${Math.round(toY)}) ×${steps}`);
    return {
      ok: true,
      isError: false,
      text: `Dragged (${Math.round(fromX)}, ${Math.round(fromY)}) → (${Math.round(toX)}, ${Math.round(toY)}) in ${steps} step(s) [${button}].`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_drag failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** agent__browser_mouse_down — press-and-hold (start of a multi-segment stroke). */
export async function browserMouseDownTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const x = num(args, 'x');
    const y = num(args, 'y');
    if (x === undefined || y === undefined) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_mouse_down needs both "x" and "y".' };
    }
    const button = parseButton(args);
    await browserManager.performMouseDown(x, y, button);
    return {
      ok: true,
      isError: false,
      text: `Mouse [${button}] DOWN at (${Math.round(x)}, ${Math.round(y)}) — stroke started. Move with browser_cursor_move, finish with browser_mouse_up.`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_mouse_down failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** agent__browser_mouse_up — release the held button (ends a stroke). */
export async function browserMouseUpTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const button = parseButton(args);
    await browserManager.performMouseUp(num(args, 'x'), num(args, 'y'), button);
    return {
      ok: true,
      isError: false,
      text: `Mouse [${button}] UP — stroke finished.`,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_mouse_up failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** agent__browser_hover — move over a selector/point: :hover CSS + mouseenter JS fire. */
export async function browserHoverTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector');
    const x = num(args, 'x');
    const y = num(args, 'y');
    if (selector) {
      await page.hover(selector, { timeout: 10_000 });
      try {
        const box = await page.evaluate(
          ((sel: unknown) => {
            const el = (globalThis as unknown as { document?: { querySelector(sel: string): { getBoundingClientRect(): { x: number; y: number; width: number; height: number } } | null } }).document?.querySelector(sel as string);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }) as unknown as (sel: string) => { x: number; y: number } | null,
          selector,
        );
        if (box) await browserManager.moveCursor(box.x, box.y);
      } catch {
      }
      return { ok: true, isError: false, text: `Hovered "${selector}" — hover states and mouseenter handlers have fired.` };
    }
    if (x !== undefined && y !== undefined) {
      await browserManager.moveCursor(x, y);
      return { ok: true, isError: false, text: `Hovering (${Math.round(x)}, ${Math.round(y)}).` };
    }
    return {
      ok: false,
      isError: true,
      errorCode: 'schema_error',
      text: 'browser_hover needs either { selector } or { x, y }.',
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_hover failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * agent__browser_press — key press / chord / hold. 'Escape', 'Tab', 'Control+a',
 * 'Meta+s', 'ArrowDown' (Playwright key names; chord = modifier+key). holdMs
 * presses-and-holds (games, long-press UIs).
 */
export async function browserPressTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const key = str(args, 'key');
    if (!key) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_press needs "key" (e.g. Escape, Tab, Control+a, ArrowDown).' };
    }
    const holdMs = Math.max(0, Math.min(5000, num(args, 'holdMs') ?? 0));
    const page = await browserManager.getActivePage();
    if (holdMs > 0) {
      await page.keyboard.down(key);
      await new Promise((r) => setTimeout(r, holdMs));
      await page.keyboard.up(key);
    } else {
      await page.keyboard.press(key);
    }
    return { ok: true, isError: false, text: `Pressed ${key}${holdMs > 0 ? ` (held ${holdMs}ms)` : ''}.` };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_press failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


/** agent__browser_back — history back (page.goBack). */
export async function browserBackTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  void args;
  try {
    const page = await browserManager.getActivePage();
    const url = page.url();
    await page.goBack({ waitUntil: 'commit', timeout: 30_000 });
    return { ok: true, isError: false, text: `Navigated back: ${url} → ${page.url()}` };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_back failed (no history entry?): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** agent__browser_forward — history forward (page.goForward). */
export async function browserForwardTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  void args;
  try {
    const page = await browserManager.getActivePage();
    const url = page.url();
    await page.goForward({ waitUntil: 'commit', timeout: 30_000 });
    return { ok: true, isError: false, text: `Navigated forward: ${url} → ${page.url()}` };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_forward failed (no forward entry?): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** agent__browser_reload — reload the active page. */
export async function browserReloadTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const ignoreCache = bool(args, 'ignoreCache') === true;
    await page.reload({ waitUntil: 'commit', timeout: 30_000 });
    browserManager.logAction('reload', page.url());
    return { ok: true, isError: false, text: `Reloaded ${page.url()}${ignoreCache ? ' (cache kept — hard-reload needs CDP Page.reload with ignoreCache)' : ''}.` };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `browser_reload failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


/** agent__browser_inspect — "what is at (x,y)?" — reverse of a coordinate click. */
export async function browserInspectTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const x = num(args, 'x');
    const y = num(args, 'y');
    if (x === undefined || y === undefined) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_inspect needs both "x" and "y" (viewport CSS px).' };
    }
    const page = await browserManager.getActivePage();
    const info = (await page.evaluate(
      `(() => {
        const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value.slice(0, 120);
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          text: (el.textContent || '').trim().slice(0, 200),
          id: el.id || undefined,
          classes: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
          attrs,
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        };
      })()`,
    )) as unknown as {
      tag: string; role?: string; text?: string; id?: string; classes?: string;
      attrs?: Record<string, string>; rect?: { x: number; y: number; width: number; height: number };
    } | null;
    if (!info) {
      return { ok: false, isError: true, text: `Nothing at (${Math.round(x)}, ${Math.round(y)}) — outside the document or covered by nothing (empty area).` };
    }
    return { ok: true, isError: false, text: JSON.stringify(info, null, 2) };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_inspect failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_semantic — structured list of interactive elements + headings. */
export async function browserSemanticTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector') || undefined;
    const maxDepth = Math.max(1, Math.min(30, num(args, 'maxDepth') ?? 8));
    const maxElements = Math.max(1, Math.min(500, num(args, 'maxElements') ?? 200));
    const maskSensitive = args.maskSensitive === undefined ? true : args.maskSensitive === true;
    const secrets = maskSensitive
      ? ((await page.evaluate(
          `(() => {
            const out = [];
            for (const el of document.querySelectorAll('input[type=password],input[autocomplete^="cc-"]')) {
              if (el.value && String(el.value).length >= 3) out.push(String(el.value));
            }
            return out;
          })()`,
        )) as unknown as string[]) ?? []
      : [];
    const scope = selector ?? 'body';
    const out = (await page.evaluate(
      `(() => {
        const root = document.querySelector(${JSON.stringify(scope)}) || document.body;
        if (!root) return { error: 'selector not found: ${scope.replace(/'/g, '')}' };
        const INTERACTIVE = 'a,button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[onclick]';
        const items = [];
        const walk = (node, depth) => {
          if (depth > ${maxDepth} || items.length >= ${maxElements} + 1) return;
          for (const el of node.children) {
            if (items.length >= ${maxElements} + 1) return;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const isHeading = /^(H[1-6])$/.test(el.tagName);
            if (el.matches(INTERACTIVE) || isHeading) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                items.push({
                  tag: el.tagName.toLowerCase(),
                  ...(isHeading ? { level: Number(el.tagName[1]) } : {}),
                  text: (el.textContent || '').trim().slice(0, 80) || undefined,
                  href: el.getAttribute('href') || undefined,
                  type: el.getAttribute('type') || undefined,
                  name: el.getAttribute('name') || el.id || undefined,
                  role: el.getAttribute('role') || undefined,
                  disabled: el.disabled === true ? true : undefined,
                  rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                });
              }
            }
            walk(el, depth + 1);
          }
        };
        walk(root, 0);
        return { selector: ${JSON.stringify(selector)}, count: Math.min(items.length, ${maxElements}), truncated: Math.max(0, items.length - ${maxElements}), items: items.slice(0, ${maxElements}) };
      })()`,
    )) as unknown as { error?: string; selector: string; count: number; truncated: number; items: Array<Record<string, unknown>> };
    if (secrets.length) {
      let serialized = JSON.stringify(out);
      for (const secret of secrets) {
        serialized = serialized.split(secret).join('••••••••');
      }
      return { ok: true, isError: false, text: JSON.parse(serialized) && serialized } as unknown as HarnessToolResult;
    }
    if (out.error) {
      return { ok: false, isError: true, text: `browser_semantic: ${out.error}` };
    }
    const suffix = out.truncated > 0 ? `\n… ${out.truncated} more (raise maxElements or narrow the selector)` : '';
    return { ok: true, isError: false, text: JSON.stringify(out, null, 1) + suffix };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_semantic failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_form — structured form comprehension (fields, labels, options). */
export async function browserFormTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector') || undefined;
    const out = (await page.evaluate(
      `(() => {
        const forms = ${selector ? `Array.of(document.querySelector(${JSON.stringify(selector)}))` : 'Array.from(document.forms)'};
        const valid = forms.filter(Boolean);
        if (!valid.length) return { error: 'no form found' + (${selector} ? ' for selector' : ' on this page') };
        const fieldLabel = (el) => {
          if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.textContent.trim().slice(0, 60); }
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').slice(0, 60);
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) { const l = document.getElementById(labelledBy); if (l) return l.textContent.trim().slice(0, 60); }
          if (el.labels && el.labels[0]) return el.labels[0].textContent.trim().slice(0, 60);
          return el.getAttribute('placeholder') || undefined;
        };
        const result = valid.map((form, fi) => {
          const fields = Array.from(form.elements).filter((el) => el && el.tagName).map((el) => {
            const base = {
              name: el.name || el.id || undefined,
              tag: el.tagName.toLowerCase(),
              type: el.type || undefined,
              label: fieldLabel(el),
              required: el.required === true ? true : undefined,
              value: el.type === 'password' ? '••••••••' : String(el.value ?? '').slice(0, 60) || undefined,
              placeholder: el.getAttribute('placeholder') || undefined,
              checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
              disabled: el.disabled === true ? true : undefined,
            };
            if (el.tagName === 'SELECT') {
              base.options = Array.from(el.options).slice(0, 30).map((o) => o.value);
            }
            return base;
          });
          return { form: fi, id: form.id || undefined, action: form.getAttribute('action') || undefined, method: form.method || undefined, fieldCount: fields.length, fields };
        });
        return { forms: result };
      })()`,
    )) as unknown as { error?: string; forms: Array<Record<string, unknown>> };
    if (out.error) return { ok: false, isError: true, text: `browser_form: ${out.error}` };
    const total = out.forms.reduce((acc, f) => acc + Number((f as { fieldCount: number }).fieldCount), 0);
    const required = out.forms.flatMap((f) => (f as { fields: Array<Record<string, unknown>> }).fields).filter((f) => f.required).length;
    return {
      ok: true,
      isError: false,
      text: `${out.forms.length} form(s), ${total} field(s), ${required} required.\n${JSON.stringify(out, null, 1)}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_form failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_read_article — readability extraction: strips nav/footer/ads
 * and returns the MAIN content as clean markdown-ish text. Heuristic: prefer
 * <article>, [role=main], main, or score blocks by text/link density.
 */
export async function browserReadArticleTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector');
    const out = (await page.evaluate(
      `(() => {
        const pick = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
        const root = pick
          || document.querySelector('article')
          || document.querySelector('[role=main]')
          || document.querySelector('main')
          || (() => {
            // Density heuristic: score containers by paragraph text vs link noise.
            let best = null, bestScore = 0;
            for (const el of document.querySelectorAll('div,section')) {
              const ps = el.querySelectorAll('p').length;
              if (ps < 2) continue;
              const textLen = (el.textContent || '').length;
              const linkLen = Array.from(el.querySelectorAll('a')).reduce((a, l) => a + (l.textContent || '').length, 0);
              const score = textLen ? (textLen - linkLen) / Math.max(1, el.querySelectorAll('div,section').length) : 0;
              if (score > bestScore) { bestScore = score; best = el; }
            }
            return best;
          })();
        if (!root) return { error: 'no article-like content found' };
        const title = document.title || '';
        const parts = [];
        const walk = (node) => {
          for (const el of node.children) {
            const tag = el.tagName.toLowerCase();
            if (/^(SCRIPT|STYLE|NAV|ASIDE|FOOTER|FORM)$/.test(el.tagName)) continue;
            if (/^H([1-6])$/.test(el.tagName)) {
              const level = Number(el.tagName[1]);
              parts.push({ t: 'h', level, text: el.textContent.trim().slice(0, 120) });
            } else if (tag === 'p') {
              const txt = el.textContent.trim();
              if (txt) parts.push({ t: 'p', text: txt.slice(0, 500) });
            } else if (tag === 'ul' || tag === 'ol') {
              const items = Array.from(el.querySelectorAll(':scope > li')).map((li) => '- ' + li.textContent.trim().slice(0, 160));
              if (items.length) parts.push({ t: 'list', text: items.join('\\n') });
            } else if (tag === 'blockquote' || tag === 'pre') {
              const txt = el.textContent.trim();
              if (txt) parts.push({ t: 'code', text: txt.slice(0, 300) });
            } else {
              walk(el);
            }
          }
        };
        walk(root);
        if (!parts.length) return { error: 'content found but empty after stripping nav/footer/ads' };
        return { title, structure: parts };
      })()`,
    )) as unknown as { error?: string; title: string; structure: Array<{ t: string; level?: number; text: string }> };
    if (out.error) return { ok: false, isError: true, text: `browser_read_article: ${out.error}` };
    const md = out.structure
      .map((p) => (p.t === 'h' ? `${'#'.repeat(p.level ?? 2)} ${p.text}` : p.t === 'code' ? `> ${p.text}` : p.text))
      .join('\n\n');
    const body = `# ${out.title}\n\n${md}`;
    return {
      ok: true,
      isError: false,
      text: truncateOutput(`${body}\n\n(${out.structure.length} content blocks after stripping nav/footer/ads)`),
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_read_article failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_watch — snapshot an element's state (call BEFORE the action). */
export async function browserWatchTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector');
    if (!selector) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_watch needs a "selector" to monitor.' };
    }
    const snapshot = (await page.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return { html: el.innerHTML.slice(0, 4000), text: (el.textContent || '').trim().slice(0, 2000), cls: el.className, exists: true };
      })()`,
    )) as unknown as { html: string; text: string; cls: string; exists: boolean } | null;
    if (snapshot) {
      browserManager.setWatchSnapshot(selector, snapshot);
      return {
        ok: true,
        isError: false,
        text: `Watching "${selector}" — snapshot stored (${snapshot.text.length} chars of text). Perform your action, then call browser_watch_result to see what changed.`,
      };
    }
    browserManager.setWatchSnapshot(selector, null);
    return {
      ok: true,
      isError: false,
      text: `Watching "${selector}" — element does NOT exist yet. If it appears, browser_watch_result reports elementAppeared.`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_watch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_watch_result — diff the current state against the snapshot. */
export async function browserWatchResultTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  void args;
  try {
    const watched = browserManager.listWatched();
    const selector = str(args, 'selector') || watched?.selector;
    const before = watched?.snapshot;
    if (selector === undefined) {
      return { ok: false, isError: true, text: 'No watch snapshot — call browser_watch({ selector }) first, then act, then this.' };
    }
    const page = await browserManager.getActivePage();
    const current = (await page.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return { html: el.innerHTML.slice(0, 4000), text: (el.textContent || '').trim().slice(0, 2000), cls: el.className, exists: true };
      })()`,
    )) as unknown as { html: string; text: string; cls: string; exists: boolean } | null;
    const changed: Record<string, unknown> = { selector };
    let any = false;
    if (!before && current) { changed.elementAppeared = true; any = true; }
    if (before && !current) { changed.elementGone = true; any = true; }
    if (before && current) {
      if (before.cls !== current.cls) { changed.classChanged = { from: before.cls, to: current.cls }; any = true; }
      if (before.text !== current.text) {
        const bWords = new Set(before.text.split(/\s+/).filter(Boolean));
        const aWords = new Set(current.text.split(/\s+/).filter(Boolean));
        const added = [...aWords].filter((w) => !bWords.has(w)).slice(0, 20);
        const removed = [...bWords].filter((w) => !aWords.has(w)).slice(0, 20);
        if (added.length) changed.textAdded = added;
        if (removed.length) changed.textRemoved = removed;
        any = true;
      }
      if (before.html !== current.html && !changed.textAdded && !changed.textRemoved) {
        changed.structureChanged = true;
        any = true;
      }
    }
    browserManager.setWatchSnapshot(selector, undefined);
    if (!any) {
      return { ok: true, isError: false, text: `No change in "${String(selector)}" since the snapshot.` };
    }
    return { ok: true, isError: false, text: JSON.stringify(changed, null, 1) };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_watch_result failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_metadata — meta tags, OpenGraph, JSON-LD, canonical, favicon. */
export async function browserMetadataTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  void args;
  try {
    const page = await browserManager.getActivePage();
    const out = (await page.evaluate(
      `(() => {
        const meta = {};
        for (const m of document.querySelectorAll('meta')) {
          const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop');
          const content = m.getAttribute('content');
          if (name && content) meta[name.slice(0, 60)] = content.slice(0, 300);
        }
        let jsonLd = null;
        try {
          const raw = document.querySelector('script[type="application/ld+json"]')?.textContent;
          if (raw) jsonLd = JSON.parse(raw);
        } catch { jsonLd = '(unparseable JSON-LD)' }
        const canonical = document.querySelector('link[rel=canonical]')?.getAttribute('href') || undefined;
        const favicon = document.querySelector('link[rel*=icon]')?.getAttribute('href') || undefined;
        const microdata = {};
        for (const el of document.querySelectorAll('[itemprop]')) {
          const prop = el.getAttribute('itemprop');
          if (prop && !microdata[prop]) microdata[prop] = (el.getAttribute('content') || el.textContent || '').trim().slice(0, 120);
        }
        return { title: document.title, meta, jsonLd, canonical, favicon, microdata };
      })()`,
    )) as unknown as Record<string, unknown>;
    return { ok: true, isError: false, text: truncateOutput(JSON.stringify(out, null, 1)) };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_metadata failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}


/** agent__browser_block_requests — abort matching requests (speed + privacy). */
export async function browserBlockRequestsTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const patterns = Array.isArray(args.patterns)
      ? args.patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [];
    if (!patterns.length) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_block_requests needs "patterns" — URL glob(s) to abort, e.g. ["**/*.woff2", "**/google-analytics.com/**"].' };
    }
    const page = await browserManager.getActivePage();
    for (const pattern of patterns) {
      await page.route(pattern, (route) => void route.abort());
    }
    browserManager.logAction('block_requests', patterns.join(', '));
    return {
      ok: true,
      isError: false,
      text:
        `Blocking ${patterns.length} request pattern(s): ${patterns.join(', ')}. ` +
        'Loads get 3-10× faster for text-focused work; images/fonts/analytics never arrive. ' +
        'Call browser_unblock_requests to clear them.',
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_block_requests failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_unblock_requests — clears every route registered on the page. */
export async function browserUnblockRequestsTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  void args;
  try {
    const page = await browserManager.getActivePage();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    browserManager.logAction('unblock_requests', 'all patterns cleared');
    return { ok: true, isError: false, text: 'All request blocks cleared — pages load fully again.' };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_unblock_requests failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_audit_log — the session's browser action trail (oldest first). */
export async function browserAuditLogTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  void args;
  try {
    const log = browserManager.getAuditLog();
    if (!log.length) {
      return { ok: true, isError: false, text: 'Audit log is empty — no browser actions recorded yet this session.' };
    }
    const lines = log.map((e, i) => {
      const t = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
      return `${String(i + 1).padStart(3, '0')}  ${t}  ${e.action.padEnd(18)}  ${e.detail.slice(0, 160)}`;
    });
    return {
      ok: true,
      isError: false,
      text: truncateOutput(`Browser audit log (${log.length} entr${log.length === 1 ? 'y' : 'ies'}, oldest first):\n${lines.join('\n')}`),
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_audit_log failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_request_approval — ask the USER before a destructive browser
 * action ("click Delete Account", "submit the payment form"). Uses the same
 * permission pipeline as out-of-workspace file ops: the request rides the
 * stream to the UI, the user approves/denies, timeout = denied (fail closed).
 */
export async function browserRequestApprovalTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  try {
    const action = str(args, 'action');
    if (!action) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_request_approval needs "action" — a human-readable description of what you are about to do.' };
    }
    let pageUrl = '';
    try {
      pageUrl = (await browserManager.getActivePage()).url();
    } catch {
    }
    browserManager.logAction('approval_requested', action);
    const granted = await requestApproval(
      {
        tool: 'browser_action',
        paths: [],
        root: requireWorkspace(ctx).root,
        command: `${action}${pageUrl ? ` — on ${pageUrl}` : ''}`,
      },
      ctx,
    );
    if (granted) {
      browserManager.logAction('approval_granted', action);
      return { ok: true, isError: false, text: `APPROVED: the user consented to "${action}". Proceed with the action now.` };
    }
    browserManager.logAction('approval_denied', action);
    return {
      ok: false,
      isError: true,
      errorCode: 'approval_denied',
      text: `DENIED: the user did not approve "${action}". Do NOT perform it — ask what they would like instead.`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_request_approval failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_plan — plan-then-act: submit the numbered step list you
 * intend to run; the user approves/edits/rejects BEFORE anything executes.
 * The user sees the plan as a permission card in the UI.
 */
export async function browserPlanTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  try {
    const steps = Array.isArray(args.steps)
      ? args.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 20)
      : [];
    if (!steps.length) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_plan needs "steps" — the ordered list of actions you intend to take, e.g. ["Click Login","Fill email","Fill password","Click Submit"].' };
    }
    const planText = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    browserManager.logAction('plan_submitted', `${steps.length} step(s)`);
    const granted = await requestApproval(
      {
        tool: 'browser_plan',
        paths: [],
        root: requireWorkspace(ctx).root,
        command: planText,
      },
      ctx,
    );
    if (granted) {
      browserManager.logAction('plan_approved', `${steps.length} step(s)`);
      return { ok: true, isError: false, text: `PLAN APPROVED — execute the steps in order:\n${planText}` };
    }
    browserManager.logAction('plan_rejected', `${steps.length} step(s)`);
    return {
      ok: false,
      isError: true,
      errorCode: 'plan_rejected',
      text: `PLAN REJECTED — do not execute this plan. Ask the user what to change.\nPlan was:\n${planText}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_plan failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Phase 9 — agent-native innovation: self-debug, persistent scripting, visual

/**
 * agent__browser_debug — the diagnostic bundle SINCE the last agent action:
 * console errors/warnings, pageerrors, HTTP 4xx/5xx, DOM mutation count, and
 * (optionally) what sits on top at a click point ("why did my click miss?").
 */
export async function browserDebugTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const diag = browserManager.getDiagnostics();
    const url = page.url();

    const mutations = (await page.evaluate(
      '(() => { const s = (globalThis).__morikoMutations; return s ? { count: s.count, lastAdded: s.lastText } : { count: -1, lastAdded: null }; })()',
    )) as unknown as { count: number; lastAdded: string | null };

    let obscured: Record<string, unknown> | undefined;
    const x = num(args, 'x');
    const y = num(args, 'y');
    if (x !== undefined && y !== undefined) {
      const top = (await page.evaluate(
        `(() => {
          const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { tag: el.tagName.toLowerCase(), id: el.id || undefined, text: (el.textContent || '').trim().slice(0, 80), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
        })()`,
      )) as unknown as Record<string, unknown> | null;
      obscured = top ?? { nothing: 'no element at that point' };
    }

    const total = diag.console.length + diag.pageErrors.length + diag.http.length;
    const bundle = {
      url,
      sinceLastAction: new Date(diag.sinceTs).toISOString(),
      quiet: total === 0,
      console: diag.console.slice(-20),
      pageErrors: diag.pageErrors.slice(-20),
      httpFailures: diag.http.slice(-20),
      domMutations: mutations,
      ...(obscured ? { onTopAtClickPoint: obscured } : {}),
    };
    return {
      ok: true,
      isError: false,
      text:
        (total === 0 ? 'Diagnostics quiet since the last action — no console errors, page errors, or HTTP failures.' : `${total} diagnostic event(s) since the last action.`) +
        `\n${JSON.stringify(bundle, null, 1)}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_debug failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_install_script — PERSISTENT automation: the script injects on
 * EVERY matching page load (this session AND future sessions — it persists in
 * ~/.moriko/browser-scripts.json). The agent doesn't just USE the browser, it
 * PROGRAMS it. Scripts are wrapped in a matches-glob guard and a try/catch.
 */
export async function browserInstallScriptTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const name = str(args, 'name');
    const matches = str(args, 'matches');
    const script = str(args, 'script');
    if (!name || !matches || !script) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_install_script needs "name", "matches" (URL glob like "https://mail.google.com/*") and "script" (JS source).' };
    }
    if (script.length > 20_000) {
      return { ok: false, isError: true, text: `browser_install_script: script is ${script.length} chars — cap is 20,000. Keep injected automation small.` };
    }
    await browserManager.installScript({ name, matches, script });
    browserManager.logAction('install_script', `${name} on ${matches}`);
    return {
      ok: true,
      isError: false,
      text:
        `Script "${name}" installed — it runs on every page load matching "${matches}", starting with the NEXT navigation ` +
        '(addInitScript runs before page scripts). It persists in ~/.moriko/browser-scripts.json across restarts. ' +
        'browser_list_scripts / browser_remove_script manage the registry.',
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_install_script failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_list_scripts — the persistent userscript registry. */
export async function browserListScriptsTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  void args;
  try {
    const scripts = browserManager.listScripts();
    if (!scripts.length) {
      return { ok: true, isError: false, text: 'No persistent scripts installed (browser_install_script adds one).' };
    }
    const lines = scripts.map((s, i) => `${i + 1}. ${s.name} — matches "${s.matches}" — ${s.script.length} chars`);
    return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_list_scripts failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_remove_script — drop from the registry (active contexts keep it until relaunch). */
export async function browserRemoveScriptTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const name = str(args, 'name');
    if (!name) return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_remove_script needs "name".' };
    const removed = browserManager.removeScript(name);
    browserManager.logAction('remove_script', name);
    return removed
      ? { ok: true, isError: false, text: `Script "${name}" removed from the registry — already-loaded contexts keep it until the next relaunch (addInitScript cannot be un-installed); new sessions will not load it.` }
      : { ok: false, isError: true, text: `No script named "${name}" in the registry (browser_list_scripts shows what exists).` };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_remove_script failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_baseline — save the current page as a PNG baseline in the
 * workspace for later visual regression diffs.
 */
export async function browserBaselineTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const rel = str(args, 'path');
    if (!rel) return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_baseline needs "path" — a workspace-relative .png path for the baseline image.' };
    const { root, abs } = resolveBridgePath(ctx, rel);
    const page = await browserManager.getActivePage();
    const buffer = await page.screenshot({ type: 'png' });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    browserManager.logAction('baseline', `${path.relative(root, abs)} (${buffer.length} bytes)`);
    return { ok: true, isError: false, text: `Baseline saved: **${path.relative(root, abs).replace(/\\/g, '/')}** (${buffer.length} bytes). Compare later with browser_visual_diff against the same path.` };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_baseline failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_visual_diff — screenshot now, load the baseline, pixel-compare
 * BOTH INSIDE THE BROWSER (canvas — no Node PNG dependency), return diff % +
 * a red-highlighted diff image (vision-capable models see it inline).
 */
export async function browserVisualDiffTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const rel = str(args, 'path');
    if (!rel) return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_visual_diff needs "path" — the workspace .png baseline to compare against (browser_baseline saved it).' };
    const { root, abs } = resolveBridgePath(ctx, rel);
    if (!fs.existsSync(abs)) {
      return { ok: false, isError: true, text: `Baseline "${rel}" does not exist in the workspace — save one first with browser_baseline.` };
    }
    const page = await browserManager.getActivePage();
    const current = await page.screenshot({ type: 'png' });
    const baseline = fs.readFileSync(abs);

    const result = (await page.evaluate(
      `(async (aUrl, bUrl) => {
        const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image decode failed')); i.src = src; });
        const A = await load(aUrl);
        const B = await load(bUrl);
        if (A.naturalWidth !== B.naturalWidth || A.naturalHeight !== B.naturalHeight) {
          return { resized: { baseline: { w: A.naturalWidth, h: A.naturalHeight }, current: { w: B.naturalWidth, h: B.naturalHeight } }, diff: -1, total: 0, diffPng: null };
        }
        const w = A.naturalWidth, h = A.naturalHeight;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        if (!g) throw new Error('canvas unavailable');
        g.drawImage(A, 0, 0);
        const da = g.getImageData(0, 0, w, h).data;
        g.clearRect(0, 0, w, h);
        g.drawImage(B, 0, 0);
        const db = g.getImageData(0, 0, w, h).data;
        const out = g.createImageData(w, h);
        let diff = 0;
        for (let i = 0; i < da.length; i += 4) {
          const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
          if (d > 30) { diff += 1; out.data[i] = 255; out.data[i + 1] = 40; out.data[i + 2] = 40; out.data[i + 3] = 255; }
          else { out.data[i] = da[i] >> 1; out.data[i + 1] = da[i + 1] >> 1; out.data[i + 2] = da[i + 2] >> 1; out.data[i + 3] = 255; }
        }
        g.putImageData(out, 0, 0);
        return { resized: null, diff, total: w * h, diffPng: c.toDataURL('image/png') };
      })('data:image/png;base64,${baseline.toString('base64')}', 'data:image/png;base64,${current.toString('base64')}')`,
    )) as unknown as { resized: { baseline: { w: number; h: number }; current: { w: number; h: number } } | null; diff: number; total: number; diffPng: string | null };

    browserManager.logAction('visual_diff', `${path.relative(root, abs)} — ${result.resized ? 'RESIZED' : `${result.diff}/${result.total} px differ`}`);
    if (result.resized) {
      return { ok: true, isError: false, text: `Page size CHANGED since the baseline — baseline ${result.resized.baseline.w}×${result.resized.baseline.h}, current ${result.resized.current.w}×${result.resized.current.h}. Re-baseline if the new size is correct.` };
    }
    const pct = result.total ? (result.diff / result.total) * 100 : 0;
    const verdict = pct === 0 ? 'IDENTICAL — not a pixel differs.' : pct < 0.5 ? `Minor drift: ${result.diff} px (${pct.toFixed(3)}%).` : `CHANGED: ${result.diff} px (${pct.toFixed(2)}%) differ.`;
    const images = result.diffPng
      ? [{ mime: 'image/png', dataUrl: result.diffPng } as ToolImage]
      : undefined;
    return {
      ok: true,
      isError: false,
      text: `${verdict} Baseline: ${path.relative(root, abs).replace(/\\/g, '/')} vs current page ${page.url()}.${images ? ' The diff image rides inline (red = changed, dimmed = unchanged) — vision-capable models can see exactly what moved.' : ''}`,
      ...(images ? { images } : {}),
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_visual_diff failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_merge_tabs — run one extractor across MULTIPLE open tabs. */
export async function browserMergeTabsTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const extract = str(args, 'extract');
    if (!extract) return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_merge_tabs needs "extract" — a JS function string applied to each tab (e.g. "(() => ({ title: document.title, price: document.querySelector(\'.price\')?.textContent }))()").' };
    const tabIds = Array.isArray(args.tabIds) ? args.tabIds.filter((t): t is string => typeof t === 'string') : undefined;

    const tabs = await browserManager.listTabs();
    const targets = tabIds?.length ? tabs.filter((t) => tabIds.includes(t.id)) : tabs;
    if (!targets.length) return { ok: false, isError: true, text: 'No tabs to merge — open them first (browser_tabs lists what exists).' };

    const results: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const tab of targets) {
      try {
        const page = await browserManager.getTabPage(tab.id);
        const value = (await page.evaluate(`(() => { const fn = ${extract}; return typeof fn === 'function' ? fn() : fn; })()`)) as unknown;
        results.push({ tabId: tab.id, url: tab.url, ...(typeof value === 'object' && value !== null ? value as Record<string, unknown> : { value }) });
      } catch (err) {
        errors.push(`${tab.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let savedNote = '';
    const rel = str(args, 'path');
    if (rel) {
      const { root, abs } = resolveBridgePath(ctx, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify({ mergedAt: Date.now(), tabs: results.length, results }, null, 1));
      savedNote = ` Merged dataset saved to **${path.relative(root, abs).replace(/\\/g, '/')}**.`;
    }

    browserManager.logAction('merge_tabs', `${results.length} tab(s)${errors.length ? `, ${errors.length} failed` : ''}`);
    return {
      ok: results.length > 0,
      isError: results.length === 0,
      text:
        `Merged ${results.length}/${targets.length} tab(s).${savedNote}` +
        (errors.length ? `\nFailed: ${errors.join(' | ')}` : '') +
        `\n${JSON.stringify(results, null, 1)}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_merge_tabs failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_fan_out — open N tabs, run an extractor on each, merge. */
export async function browserFanOutTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).slice(0, 10) : [];
    const extract = str(args, 'extract');
    if (!urls.length || !extract) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_fan_out needs "urls" (1-10) and "extract" (JS function string applied per tab).' };
    }
    const session = await browserManager.ensureContext();

    const results: Array<{ url: string; ok: boolean; data?: unknown; error?: string }> = [];
    const tempPages: Array<Page> = [];
    try {
      await Promise.all(
        urls.map(async (rawUrl) => {
          let page: Page | null = null;
          try {
            const url = browserManager.assertUrl(rawUrl.trim());
            page = await session.context.newPage();
            tempPages.push(page);
            await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
            const value = (await page.evaluate(`(() => { const fn = ${extract}; return typeof fn === 'function' ? fn() : fn; })()`)) as unknown;
            results.push({ url: url.toString(), ok: true, data: value });
          } catch (err) {
            results.push({ url: rawUrl, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }),
      );
    } finally {
      for (const p of tempPages) await p.close().catch(() => undefined);
    }
    results.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));

    let savedNote = '';
    const rel = str(args, 'path');
    if (rel) {
      const { root, abs } = resolveBridgePath(ctx, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify({ fannedOutAt: Date.now(), results }, null, 1));
      savedNote = ` Results saved to **${path.relative(root, abs).replace(/\\/g, '/')}**.`;
    }

    const okCount = results.filter((r) => r.ok).length;
    browserManager.logAction('fan_out', `${okCount}/${urls.length} url(s) extracted`);
    return {
      ok: okCount > 0,
      isError: okCount === 0,
      text: `Fan-out: ${okCount}/${urls.length} url(s) extracted in parallel (ephemeral tabs, already closed).${savedNote}\n${JSON.stringify(results, null, 1)}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_fan_out failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_mark — invisible annotation memory: attach a note to an
 * element (dataset.morikoNote) and/or persist it per-URL in localStorage so a
 * future session "remembers" ("this form was already filled yesterday").
 */
export async function browserMarkTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const selector = str(args, 'selector');
    const note = str(args, 'note');
    if (!selector || !note) return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_mark needs "selector" and "note".' };
    const persistent = bool(args, 'persistent') === true;
    const page = await browserManager.getActivePage();
    const applied = (await page.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.dataset.morikoNote = ${JSON.stringify(note.slice(0, 300))};
        ${persistent ? `try {
          const key = 'moriko:notes:' + location.href;
          const list = JSON.parse(localStorage.getItem(key) || '[]');
          const filtered = list.filter((n) => n.sel !== ${JSON.stringify(selector)});
          filtered.push({ sel: ${JSON.stringify(selector)}, note: ${JSON.stringify(note.slice(0, 300))}, ts: Date.now() });
          localStorage.setItem(key, JSON.stringify(filtered.slice(-50)));
        } catch { /* storage may be unavailable */ }` : ''}
        return { tag: el.tagName.toLowerCase(), id: el.id || undefined };
      })()`,
    )) as unknown as { tag: string; id?: string } | null;
    if (!applied) return { ok: false, isError: true, text: `No element matches "${selector}" — nothing marked.` };
    browserManager.logAction('mark', `${selector}: ${note.slice(0, 60)}${persistent ? ' (persistent)' : ''}`);
    return { ok: true, isError: false, text: `Marked ${applied.tag}${applied.id ? `#${applied.id}` : ''} — "${note.slice(0, 120)}"${persistent ? ' + persisted in localStorage for THIS url across sessions.' : ' (page-lifetime only; persistent: true survives navigation).'}` };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_mark failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_marks — read every note on the page (+ persisted ones for this URL). */
export async function browserMarksTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  void args;
  try {
    const page = await browserManager.getActivePage();
    const out = (await page.evaluate(
      `(() => {
        const live = [];
        for (const el of document.querySelectorAll('[data-moriko-note]')) {
          live.push({ where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), note: el.dataset.morikoNote });
        }
        let persisted = [];
        try {
          persisted = JSON.parse(localStorage.getItem('moriko:notes:' + location.href) || '[]');
        } catch { /* none */ }
        return { url: location.href, live, persisted };
      })()`,
    )) as unknown as { url: string; live: Array<{ where: string; note: string }>; persisted: Array<{ sel: string; note: string; ts: number }> };
    const total = out.live.length + out.persisted.length;
    return {
      ok: true,
      isError: false,
      text:
        (total === 0 ? `No marks on ${out.url}.` : `${total} mark(s) on ${out.url}:`) +
        (total ? `\n${JSON.stringify(out, null, 1)}` : ''),
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_marks failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_record — record the USER's takeover actions into a replayable
 * macro (~/.moriko/browser-macros/<name>.json). Start recording, let the user
 * (or agent via takeover) drive, then record:false to save.
 */
export async function browserRecordTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const name = str(args, 'name');
    const record = bool(args, 'record');
    if (!name || record === undefined) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_record needs "name" and "record" (true to start, false to stop+save).' };
    }
    if (record) {
      if (browserManager.isRecording()) {
        return { ok: false, isError: true, text: 'Already recording — call browser_record({ name, record: false }) first to save the current macro.' };
      }
      browserManager.startRecording(name);
      browserManager.logAction('record_start', name);
      return {
        ok: true,
        isError: false,
        text:
          `Recording macro "${name}". Actions are captured while the USER drives the panel (takeover): clicks, typing, key presses, scrolls — each with inter-action timing. ` +
          'When done, call browser_record({ name, record: false }) to save, then browser_replay({ name }) replays it anytime.',
      };
    }
    const saved = browserManager.stopRecording();
    if (!saved) return { ok: false, isError: true, text: `Not recording — start with browser_record({ name: "${name}", record: true }).` };
    browserManager.logAction('record_stop', `${name}: ${saved.steps} step(s)`);
    return { ok: true, isError: false, text: `Macro "${name}" saved: ${saved.steps} step(s) → ${saved.file}. Replay with browser_replay({ name: "${name}" }).` };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_record failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** agent__browser_replay — re-execute a saved macro's steps on the live page. */
export async function browserReplayTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const name = str(args, 'name');
    if (!name) return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_replay needs "name".' };
    const speed = Math.max(0.1, Math.min(10, num(args, 'speed') ?? 1));
    const steps = browserManager.loadMacro(name);
    if (!steps?.length) return { ok: false, isError: true, text: `No macro named "${name}" (~/.moriko/browser-macros/<name>.json) — record one first.` };

    const page = await browserManager.getActivePage();
    let executed = 0;
    const skipped: string[] = [];
    for (const raw of steps) {
      const step = raw as { type?: string; x?: number; y?: number; button?: string; text?: string; key?: string; deltaX?: number; deltaY?: number; dt?: number };
      const wait = Math.min(1500, Math.max(0, step.dt ?? 0)) / speed;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        if (step.type === 'click' && typeof step.x === 'number' && typeof step.y === 'number') {
          await browserManager.moveCursor(step.x, step.y);
          await page.mouse.click(step.x, step.y, { button: (step.button as 'left' | 'right' | 'middle') ?? 'left' });
          browserManager.broadcastClick(step.x, step.y);
        } else if (step.type === 'type' && typeof step.text === 'string') {
          await page.keyboard.type(step.text, { delay: 8 });
        } else if (step.type === 'press' && typeof step.key === 'string') {
          await page.keyboard.press(step.key);
        } else if (step.type === 'scroll' && (typeof step.deltaX === 'number' || typeof step.deltaY === 'number')) {
          await page.mouse.wheel(step.deltaX ?? 0, step.deltaY ?? 0);
        } else {
          skipped.push(`unknown step type: ${String(step.type)}`);
          continue;
        }
        executed += 1;
      } catch (err) {
        skipped.push(`step ${executed + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    browserManager.logAction('replay', `${name}: ${executed}/${steps.length} step(s)`);
    return {
      ok: executed > 0,
      isError: executed === 0,
      text: `Replayed "${name}": ${executed}/${steps.length} step(s) at ${speed}×.${skipped.length ? `\nSkipped/failed:\n- ${skipped.join('\n- ')}` : ''}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_replay failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}


/**
 * agent__browser_touch_tap — taps at (x,y) with the TOUCHSCREEN (not the
 * mouse). Mobile-emulated sites and touch-only handlers (touchstart) need
 * this; the context launches with hasTouch so it works out of the box.
 */
export async function browserTouchTapTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const x = num(args, 'x');
    const y = num(args, 'y');
    if (x === undefined || y === undefined) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_touch_tap needs both "x" and "y" (viewport CSS px).' };
    }
    const page = await browserManager.getActivePage();
    await browserManager.moveCursor(x, y);
    await page.touchscreen.tap(x, y);
    browserManager.broadcastClick(x, y);
    browserManager.logAction('touch_tap', `(${Math.round(x)}, ${Math.round(y)})`);
    return { ok: true, isError: false, text: `Tapped (${Math.round(x)}, ${Math.round(y)}) via touchscreen.` };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_touch_tap failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_dialog — set the session dialog policy BEFORE the action
 * that triggers a JS alert/confirm/prompt: 'accept' (+ prompt text),
 * 'dismiss', or 'default' (clears back to auto-dismiss). The in-page listener
 * applies it to every dialog; each handling lands in the diagnostics log.
 */
export async function browserDialogTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const action = str(args, 'action') ?? 'default';
    if (!['accept', 'dismiss', 'default'].includes(action)) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_dialog: "action" must be accept | dismiss | default.' };
    }
    const text = str(args, 'text');
    browserManager.setDialogPolicy(action === 'default' ? null : { action: action as 'accept' | 'dismiss', text });
    browserManager.logAction('dialog_policy', action);
    return {
      ok: true,
      isError: false,
      text:
        action === 'accept'
          ? `Dialogs will be ACCEPTED${text ? ' (prompt text provided)' : ''} until you change the policy. Trigger the dialog now (click/eval), then read the outcome from the page.`
          : action === 'dismiss'
          ? 'Dialogs will be DISMISSED until you change the policy. Trigger the dialog now.'
          : 'Dialog policy reset — dialogs are auto-dismissed (the harness default) and logged to the diagnostics.',
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_dialog failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_annotations — the user drew rectangles on the PANEL (Draw
 * mode) to point at things. Returns the pending shapes with viewport coords
 * and CLEARS them — the visual conversation channel: agent looks, agent acts.
 */
export async function browserAnnotationsTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  void args;
  try {
    const shapes = browserManager.takeAnnotations();
    const cursor = browserManager.getUserCursor();
    if (!shapes.length && !cursor.visible) {
      return { ok: true, isError: false, text: 'No pending annotations or user-cursor hints — the user has not pointed at anything since you last checked.' };
    }
    const lines = [
      ...(cursor.visible ? [`User cursor hint: (${cursor.x}, ${cursor.y}) — they parked the orange dot here.`] : []),
      ...shapes.map((s, i) => `Rect ${i + 1}: x=${s.x}, y=${s.y}, w=${s.w}, h=${s.h} (viewport CSS px; center: ${Math.round(s.x + s.w / 2)}, ${Math.round(s.y + s.h / 2)})`),
    ];
    return { ok: true, isError: false, text: `${shapes.length} annotation(s)${cursor.visible ? ' + 1 cursor hint' : ''}:\n${lines.join('\n')}\nUse browser_inspect / browser_eval at these coordinates to see WHAT the user pointed at.` };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_annotations failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}


/** Resolves a workspace-relative path against the session's workspace root
 *  and refuses anything that escapes it (same safety as the file tools). */
function resolveBridgePath(ctx: AgentToolContext, rel: string): { root: string; abs: string } {
  const { root } = requireWorkspace(ctx);
  const abs = path.resolve(root, rel);
  if (!isInsideRoot(abs, root)) {
    throw new Error(`Path "${rel}" escapes the active workspace root — refused.`);
  }
  return { root, abs };
}

/** Sanitizes a filename for the filesystem: keeps dots/dashes, drops the rest. */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 80) || 'file';
}

/**
 * agent__browser_save_page — extract the main content (Phase 6 readability
 * walker) → convert to Markdown → write to the workspace. Returns a diff-style
 * confirmation like the file tools (created vs updated + size).
 */
export async function browserSavePageTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const rel = str(args, 'path');
    if (!rel) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_save_page needs "path" — a workspace-relative path for the .md file (e.g. "notes/article.md").' };
    }
    const { abs } = resolveBridgePath(ctx, rel);
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector');
    const out = (await page.evaluate(
      `(() => {
        const pick = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
        const root = pick
          || document.querySelector('article')
          || document.querySelector('[role=main]')
          || document.querySelector('main')
          || (() => {
            let best = null, bestScore = 0;
            for (const el of document.querySelectorAll('div,section')) {
              const ps = el.querySelectorAll('p').length;
              if (ps < 2) continue;
              const textLen = (el.textContent || '').length;
              const linkLen = Array.from(el.querySelectorAll('a')).reduce((a, l) => a + (l.textContent || '').length, 0);
              const score = textLen ? (textLen - linkLen) / Math.max(1, el.querySelectorAll('div,section').length) : 0;
              if (score > bestScore) { bestScore = score; best = el; }
            }
            return best;
          })();
        if (!root) return { error: 'no article-like content found' };
        const parts = [];
        const walk = (node) => {
          for (const el of node.children) {
            const tag = el.tagName.toLowerCase();
            if (/^(SCRIPT|STYLE|NAV|ASIDE|FOOTER|FORM)$/.test(el.tagName)) continue;
            if (/^H([1-6])$/.test(el.tagName)) {
              parts.push({ t: 'h', level: Number(el.tagName[1]), text: el.textContent.trim().slice(0, 200) });
            } else if (tag === 'p') {
              const txt = el.textContent.trim();
              if (txt) parts.push({ t: 'p', text: txt.slice(0, 1000) });
            } else if (tag === 'ul' || tag === 'ol') {
              const items = Array.from(el.querySelectorAll(':scope > li')).map((li) => '- ' + li.textContent.trim().slice(0, 200));
              if (items.length) parts.push({ t: 'list', text: items.join('\\n') });
            } else if (tag === 'blockquote' || tag === 'pre') {
              const txt = el.textContent.trim();
              if (txt) parts.push({ t: 'code', text: txt.slice(0, 500) });
            } else {
              walk(el);
            }
          }
        };
        walk(root);
        return { title: document.title || 'Untitled', url: location.href, structure: parts };
      })()`,
    )) as unknown as { error?: string; title: string; url: string; structure: Array<{ t: string; level?: number; text: string }> };
    if (out.error) return { ok: false, isError: true, text: `browser_save_page: ${out.error}` };

    const markdown = [`# ${out.title}`, '', `> Source: ${out.url}`, '', htmlToMarkdown(out.structure), '', `_${out.structure.length} content blocks — saved from the browser._`].join('\n');
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, markdown, 'utf8');
    const size = Buffer.byteLength(markdown, 'utf8');
    return {
      ok: true,
      isError: false,
      diff: `${existed ? 'M' : 'A'}\t${rel}`,
      text:
        `${existed ? 'Updated' : 'Created'} **${rel}** (${size} bytes, ${out.structure.length} content blocks).\n` +
        `Title: "${out.title}" — from ${out.url}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_save_page failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_save_images — collect <img> srcs (relative resolved against
 * the page URL), fetch each server-side, save into a workspace directory with
 * sanitized filenames. minWidth filters icons/tracking pixels.
 */
export async function browserSaveImagesTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const dir = str(args, 'dir');
    if (!dir) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_save_images needs "dir" — a workspace-relative directory (e.g. "assets/").' };
    }
    const minWidth = Math.max(0, num(args, 'minWidth') ?? 100);
    const limit = Math.max(1, Math.min(100, num(args, 'limit') ?? 30));
    const { root, abs: absDir } = resolveBridgePath(ctx, dir);
    const page = await browserManager.getActivePage();
    const pageUrl = page.url();
    const srcs = (await page.evaluate(
      `(() => {
        const out = [];
        for (const img of document.querySelectorAll('img')) {
          const src = img.currentSrc || img.src;
          if (!src) continue;
          // Report BOTH widths for debugging: naturalWidth (intrinsic) and
          // the layout width. The Node side decides the filter.
          const w = img.naturalWidth || img.width || 0;
          out.push({ src: src.slice(0, 2000), naturalWidth: img.naturalWidth, layoutWidth: Math.round(img.getBoundingClientRect().width), w });
          if (out.length >= ${limit}) break;
        }
        return { pageUrl: location.href, srcs: out };
      })()`,
    )) as unknown as { pageUrl: string; srcs: Array<{ src: string; naturalWidth: number; layoutWidth: number; w: number }> };
    // Debug: report what the walker saw (naturalWidth vs layout width).
    const seen = srcs.srcs.map((s) => `${s.src.split('/').pop()} natural=${s.naturalWidth} layout=${s.layoutWidth}`).join('; ');
    const passing = srcs.srcs.filter((s) => s.naturalWidth >= minWidth);
    if (!passing.length) {
      return { ok: false, isError: true, text: `No images ≥${minWidth}px wide found on ${pageUrl}. Seen: ${seen || '(none)'}` };
    }
    fs.mkdirSync(absDir, { recursive: true });
    const saved: string[] = [];
    const errors: string[] = [];
    let index = 0;
    for (const entry of passing) {
      const src = entry.src;
      index += 1;
      try {
        const abs = new URL(src, srcs.pageUrl).href;
        if (!/^https?:/i.test(abs)) {
          if (!/^data:/i.test(abs)) {
            errors.push(`${src} (skipped: ${abs.split(':')[0]}: URL)`);
            continue;
          }
        }
        const response = await fetch(abs, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
          errors.push(`${src} (HTTP ${response.status})`);
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const urlPath = (() => {
          try {
            return new URL(abs).pathname;
          } catch {
            return '';
          }
        })();
        const ext = path.extname(urlPath) || '.png';
        const base = sanitizeFilename(path.basename(urlPath, ext)) || `image-${index}`;
        const filename = `${base}${ext}`;
        const target = path.join(absDir, filename);
        fs.writeFileSync(target, buffer);
        saved.push(`${path.relative(root, target)} (${buffer.length} bytes)`);
      } catch (err) {
        errors.push(`${src} (${err instanceof Error ? err.message.slice(0, 80) : String(err)})`);
      }
    }
    const lines = [
      `Saved ${saved.length} image(s) to ${dir} (workspace):`,
      ...saved.map((s) => `  + ${s}`),
      ...(errors.length ? ['', `Skipped/failed ${errors.length}:`, ...errors.slice(0, 8).map((e) => `  ! ${e}`)] : []),
    ];
    return { ok: saved.length > 0, isError: saved.length === 0, text: lines.join('\n') };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_save_images failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_upload — set a workspace file into a page file input.
 * Takeover-guarded (it mutates page state) and workspace-jail-checked.
 */
export async function browserUploadTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const selector = str(args, 'selector');
    const rel = str(args, 'path');
    if (!selector || !rel) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_upload needs "selector" (the <input type=file>) and "path" (workspace-relative file to upload).' };
    }
    const { abs } = resolveBridgePath(ctx, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, isError: true, text: `File not found in the workspace: ${rel}` };
    }
    const page = await browserManager.getActivePage();
    await page.setInputFiles(selector, abs, { timeout: 15_000 });
    const size = fs.statSync(abs).size;
    return {
      ok: true,
      isError: false,
      text: `Uploaded **${rel}** (${size} bytes) into "${selector}" — the page now holds the file; submit the form to finish.`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_upload failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_download — atomic click+capture: races the click against
 * page.waitForEvent('download'), saves into the workspace, returns path+size.
 */
export async function browserDownloadTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const selector = str(args, 'selector');
    const x = num(args, 'x');
    const y = num(args, 'y');
    if (!selector && (x === undefined || y === undefined)) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_download needs either { selector } or { x, y } — the element that TRIGGERS the download.' };
    }
    const dir = str(args, 'dir');
    const { root, abs: absDir } = dir ? { ...resolveBridgePath(ctx, dir) } : { root: requireWorkspace(ctx).root, abs: requireWorkspace(ctx).root };
    const page = await browserManager.getActivePage();
    fs.mkdirSync(absDir, { recursive: true });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    if (selector) {
      await page.click(selector, { timeout: 15_000 });
    } else {
      await browserManager.moveCursor(x!, y!);
      await page.mouse.click(x!, y!);
      browserManager.broadcastClick(x!, y!);
    }
    const download = await downloadPromise;
    const filename = sanitizeFilename(download.suggestedFilename() || 'download.bin');
    const target = path.join(absDir, filename);
    await download.saveAs(target);
    const size = fs.statSync(target).size;
    return {
      ok: true,
      isError: false,
      text:
        `Downloaded **${path.relative(root, target).replace(/\\/g, '/')}** (${size} bytes) from ${page.url()}.`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_download failed (no download started within 30s?): ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_table — extract <table> (or [role=grid]) content as
 * JSON / CSV / TSV. Best-effort for report-style pages.
 */
export async function browserTableTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  void ctx;
  try {
    const page = await browserManager.getActivePage();
    const selector = str(args, 'selector') || 'table';
    const format = (str(args, 'format') || 'json').toLowerCase();
    if (!['json', 'csv', 'tsv'].includes(format)) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_table format must be json (default), csv, or tsv.' };
    }
    const out = (await page.evaluate(
      `(() => {
        const table = document.querySelector(${JSON.stringify(selector)});
        if (!table) return { error: 'no <table> found for ${selector.replace(/'/g, '')}' };
        const rows = Array.from(table.querySelectorAll('tr')).slice(0, 500);
        const grid = rows.map((tr) => Array.from(tr.querySelectorAll('th,td')).map((cell) => (cell.textContent || '').trim().slice(0, 200)));
        const headers = grid.length ? grid[0] : [];
        const data = grid.slice(1).filter((r) => r.some(Boolean));
        return { headers, data, rowCount: data.length };
      })()`,
    )) as unknown as { error?: string; headers: string[]; data: string[][]; rowCount: number };
    if (out.error) return { ok: false, isError: true, text: `browser_table: ${out.error}` };
    // NOTE: /\t/ and /\n/ (real control chars) — the old /\\t/ /\\n/ escaped
    const esc = (v: string, d: string) => (/[",\t\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v) + d;
    let body: string;
    if (format === 'json') {
      const objects = out.data.map((row) => Object.fromEntries(row.map((v, i) => [out.headers[i] ?? `col${i}`, v])));
      body = JSON.stringify({ headers: out.headers, rowCount: out.rowCount, rows: objects }, null, 1);
    } else {
      const delim = format === 'csv' ? ',' : '\t';
      body = [out.headers.map((h) => esc(h, '')).join(delim), ...out.data.map((r) => r.map((v) => esc(v, '')).join(delim))].join('\n');
    }
    return { ok: true, isError: false, text: truncateOutput(`${out.rowCount} data row(s) × ${out.headers.length} column(s):\n${body}`) };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_table failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_pdf — print the current page to a workspace PDF.
 * page.pdf() works in headless Chromium/Edge (which this harness runs).
 */
export async function browserPdfTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const rel = str(args, 'path');
    if (!rel) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: 'browser_pdf needs "path" — a workspace-relative .pdf destination.' };
    }
    const format = (str(args, 'format') || 'A4').toUpperCase();
    if (!['A4', 'LETTER', 'LEGAL', 'A3', 'A5'].includes(format)) {
      return { ok: false, isError: true, errorCode: 'schema_error', text: `browser_pdf format "${format}" not supported — use A4 (default), Letter, Legal, A3, or A5.` };
    }
    const { root, abs } = resolveBridgePath(ctx, rel);
    const page = await browserManager.getActivePage();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await page.pdf({ path: abs, format: format as 'A4', printBackground: true });
    const size = fs.statSync(abs).size;
    return { ok: true, isError: false, text: `Saved **${path.relative(root, abs)}** (${size} bytes, ${format}) from ${page.url()}.` };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_pdf failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * agent__browser_crawl — paginated collection: extract items, click next,
 * repeat until no next / maxPages. Saves the dataset to the workspace.
 */
export async function browserCrawlTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  if (browserManager.isTakeover()) return takeoverRefusal();
  void ctx;
  try {
    const itemSelector = str(args, 'itemSelector');
    const nextSelector = str(args, 'nextSelector');
    const extract = str(args, 'extract');
    if (!itemSelector || !nextSelector || !extract) {
      return {
        ok: false,
        isError: true,
        errorCode: 'schema_error',
        text:
          'browser_crawl needs: itemSelector (what to collect per page), nextSelector (the next-page control), extract ' +
          '(JS function string: (el) => ({...fields}) applied to each item element).',
      };
    }
    const maxPages = Math.max(1, Math.min(50, num(args, 'maxPages') ?? 10));
    const rel = str(args, 'path');
    const { abs } = rel ? resolveBridgePath(ctx, rel) : { abs: '' };
    const page = await browserManager.getActivePage();
    new Function(`return (${extract})`)();
    const seenUrls = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    const pages: Array<{ url: string; count: number }> = [];

    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const url = page.url();
      if (seenUrls.has(url)) break;
      seenUrls.add(url);

      const elements = page.locator(itemSelector);
      const count = Math.min(await elements.count(), 200);
      const pageItems: Array<Record<string, unknown>> = [];
      for (let i = 0; i < count; i += 1) {
        const row = (await elements.nth(i).evaluate(
          ((el: unknown, fn: string) => {
            const userFn = new Function(`return (${fn})`)() as (e: unknown) => Record<string, unknown>;
            return userFn(el);
          }) as unknown as (el: never, fn: string) => Record<string, unknown>,
          extract,
        )) as unknown as Record<string, unknown>;
        if (row && typeof row === 'object') pageItems.push(row);
      }
      items.push(...pageItems);
      pages.push({ url, count: pageItems.length });

      const next = page.locator(nextSelector).first();
      if ((await next.count()) === 0) break;
      await next.click({ timeout: 10_000 });
      try {
        await page.waitForLoadState('load', { timeout: 10_000 });
      } catch {
      }
    }

    const summary = { pages: pages.length, items: items.length, perPage: pages, savedTo: rel || undefined };
    if (rel) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify({ crawledAt: new Date().toISOString(), ...summary, items }, null, 1), 'utf8');
    }
    return {
      ok: true,
      isError: false,
      text:
        `Crawled ${pages.length} page(s), collected ${items.length} item(s).` +
        (rel ? ` Dataset saved to **${rel.replace(/\\/g, '/')}**.` : ' No "path" given — dataset in memory only (pass path to save).') +
        `\n${JSON.stringify(summary, null, 1)}`,
    };
  } catch (error) {
    return { ok: false, isError: true, text: `browser_crawl failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
