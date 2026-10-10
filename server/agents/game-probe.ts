/**
 * F5.2 — game-probe: runs a LOCAL game/3D app in headless Chromium and
 * reports runtime facts: console/page errors, failed requests, WebGL context
 * info, FPS sampling (rAF), canvas blank detection, three.js probe hook,
 * memory. Localhost/private hosts ONLY (never gated by Web Access).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright, assertAllowedTarget } from './spatial-runtime.js';
import { getActiveWorkspace } from './workspace.js';

const LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** Probe data dir: <workspace>/.moriko-dat/probe/ — User decision: probe
 *  screenshots live INSIDE the workspace (agent can read them back).
 *  No workspace bound → screenshots are skipped, other facts still report. */
function probeDataDir(): string | null {
  const root = getActiveWorkspace()?.path;
  return root ? path.join(root, '.moriko-dat', 'probe') : null;
}

export interface GameProbeAction {
  type: 'key' | 'click';
  key?: string;
  x?: number;
  y?: number;
  holdMs?: number;
}

export interface GameProbeResult {
  url: string;
  fps: { average: number; p95FrameMs: number; longFrames: number; renderer: string | null } | null;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
  canvases: Array<{
    context: string;
    width: number;
    height: number;
    dpr: number;
    glError: string | null;
    blank: boolean;
  }>;
  threeStats: { drawCalls: number; triangles: number; geometries: number; textures: number; sceneObjects: number } | null;
  memory: { usedJsHeapMbStart: number | null; usedJsHeapMbEnd: number | null } | null;
  screenshots: string[];
  notes: string[];
}

/** rAF sampler injected BEFORE page scripts run. */
const FPS_INIT_SCRIPT = `
window.__MORIKO_FPS__ = { frames: [], last: performance.now() };
(function () {
  function sample(now) {
    var f = window.__MORIKO_FPS__;
    f.frames.push(now - f.last);
    f.last = now;
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();
`;

const CANVAS_INSPECT_SCRIPT = `
(() => {
  const out = [];
  for (const canvas of document.querySelectorAll('canvas')) {
    let context = 'none'; let glError = null; let blank = true;
    try {
      const gl2 = canvas.getContext('webgl2');
      const gl1 = canvas.getContext('webgl');
      const ctx2d = canvas.getContext('2d');
      if (gl2 || gl1) {
        const gl = gl2 || gl1;
        context = gl2 ? 'webgl2' : 'webgl';
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        window.__MORIKO_RENDERER__ = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
        glError = gl.getError() === 0 ? null : ('gl error ' + gl.getError());
        // sample 16 pixels
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        try {
          const px = new Uint8Array(4);
          let variance = 0;
          for (let i = 0; i < 16; i++) {
            gl.readPixels(Math.floor((i % 4) * w / 4), Math.floor(Math.floor(i / 4) * h / 4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            variance += px[0] + px[1] + px[2];
          }
          blank = variance === 0;
        } catch (e) { blank = false; }
      } else if (ctx2d) {
        context = '2d';
        try {
          const data = ctx2d.getImageData(0, 0, Math.min(canvas.width, 64), Math.min(canvas.height, 64)).data;
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
          blank = sum === 0;
        } catch (e) { blank = false; }
      }
    } catch (e) { /* keep defaults */ }
    out.push({
      context,
      width: canvas.width,
      height: canvas.height,
      dpr: Math.round((canvas.width / Math.max(canvas.clientWidth, 1)) * 100) / 100,
      glError,
      blank,
    });
  }
  return {
    canvases: out,
    renderer: window.__MORIKO_RENDERER__ || null,
    three: window.__MORIKO_PROBE__ && window.__MORIKO_PROBE__.renderer && window.__MORIKO_PROBE__.renderer.info ? {
      drawCalls: window.__MORIKO_PROBE__.renderer.info.render.calls,
      triangles: window.__MORIKO_PROBE__.renderer.info.render.triangles,
      geometries: window.__MORIKO_PROBE__.renderer.info.memory.geometries,
      textures: window.__MORIKO_PROBE__.renderer.info.memory.textures,
      sceneObjects: window.__MORIKO_PROBE__.scene ? window.__MORIKO_PROBE__.scene.children.length : 0,
    } : null,
    memory: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
})();
`;

export async function runGameProbe(
  rawUrl: string,
  opts: {
    durationMs?: number;
    viewport?: { w: number; h: number };
    actions?: GameProbeAction[];
    screenshots?: number;
  } = {},
): Promise<GameProbeResult> {
  const url = assertAllowedTarget(rawUrl, false); // localhost/private ONLY
  const pw = await loadPlaywright();
  if (!pw) {
    throw new Error('playwright-core is not installed. Run: pnpm add -D playwright-core.');
  }
  const durationMs = Math.min(Math.max(opts.durationMs ?? 4000, 1000), 30_000);
  const viewport = {
    width: Math.min(Math.max(opts.viewport?.w ?? 1280, 320), 3840),
    height: Math.min(Math.max(opts.viewport?.h ?? 720, 240), 2160),
  };
  const screenshotCount = Math.min(Math.max(opts.screenshots ?? 3, 0), 6);
  const actions = opts.actions ?? [];

  let browser;
  try {
    try {
      browser = await pw.chromium.launch({ headless: true, channel: 'msedge', args: LAUNCH_ARGS });
    } catch {
      browser = await pw.chromium.launch({ headless: true, args: LAUNCH_ARGS });
    }
  } catch (error) {
    throw new Error(`Could not launch headless browser: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result: GameProbeResult = {
    url: url.toString(),
    fps: null,
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    canvases: [],
    threeStats: null,
    memory: null,
    screenshots: [],
    notes: [],
  };
  const consoleSeen = new Set<string>();

  try {
    const page = await browser.newPage({ viewport });
    await page.addInitScript(FPS_INIT_SCRIPT);

    page.on('console', (msg) => {
      const text = msg.text().slice(0, 300);
      if (msg.type() === 'error') {
        if (!consoleSeen.has(text) && result.consoleErrors.length < 30) {
          consoleSeen.add(text);
          result.consoleErrors.push(text);
        }
      } else if (msg.type() === 'warning') {
        if (!consoleSeen.has(text) && result.consoleWarnings.length < 30) {
          consoleSeen.add(text);
          result.consoleWarnings.push(text);
        }
      }
    });
    page.on('pageerror', (error) => {
      if (result.pageErrors.length < 20) result.pageErrors.push(String(error).slice(0, 400));
    });
    page.on('requestfailed', (request) => {
      if (result.failedRequests.length < 20) {
        result.failedRequests.push(`${request.url().slice(0, 160)} — ${request.failure()?.errorText ?? 'failed'}`);
      }
    });

    const memoryStart = (await page.evaluate('performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null').catch(() => null)) as number | null;

    await page.goto(url.toString(), { waitUntil: 'commit', timeout: 20_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
    try {
      await page.waitForLoadState('networkidle', { timeout: 3_000 });
    } catch { /* games keep polling */ }

    // Run actions while sampling.
    const actionTasks: Array<Promise<void>> = [];
    for (const action of actions.slice(0, 20)) {
      actionTasks.push((async () => {
        if (action.type === 'key' && action.key) {
          await page.keyboard.down(action.key);
          await page.waitForTimeout(Math.min(action.holdMs ?? 300, 2_000));
          await page.keyboard.up(action.key);
        } else if (action.type === 'click') {
          await page.mouse.click(action.x ?? viewport.width / 2, action.y ?? viewport.height / 2);
        }
      })());
    }
    await Promise.all(actionTasks);
    await page.waitForTimeout(durationMs);

    const inspected = (await page.evaluate(CANVAS_INSPECT_SCRIPT).catch(() => null)) as {
      canvases: GameProbeResult['canvases'];
      renderer: string | null;
      three: GameProbeResult['threeStats'];
      memory: number | null;
    } | null;
    if (inspected) {
      result.canvases = inspected.canvases ?? [];
      result.threeStats = inspected.three;
      result.memory = {
        usedJsHeapMbStart: memoryStart,
        usedJsHeapMbEnd: inspected.memory,
      };
    }

    const fpsData = (await page.evaluate('window.__MORIKO_FPS__ ? window.__MORIKO_FPS__.frames : []').catch(() => null)) as number[] | null;
    if (fpsData && fpsData.length > 5) {
      const sorted = [...fpsData].sort((a, b) => a - b);
      const total = fpsData.reduce((s, v) => s + v, 0);
      const p95 = sorted[Math.floor(sorted.length * 0.95) - 1] ?? sorted[sorted.length - 1];
      result.fps = {
        average: Math.round((1000 / (total / fpsData.length)) * 10) / 10,
        p95FrameMs: Math.round(p95 * 10) / 10,
        longFrames: fpsData.filter((v) => v > 50).length,
        renderer: inspected?.renderer ?? null,
      };
    }

    if (screenshotCount > 0) {
      const dir = probeDataDir();
      if (!dir) {
        result.notes.push('no workspace bound — screenshots not persisted (probe data lives in <workspace>/.moriko-dat/probe)');
      } else {
        fs.mkdirSync(dir, { recursive: true });
        const slug = url.host.replace(/[^a-z0-9]/gi, '_') + '-' + Date.now().toString(36);
        for (let i = 0; i < screenshotCount; i += 1) {
          await page.waitForTimeout(Math.max(durationMs / screenshotCount, 200));
          const p = path.join(dir, `${slug}-${i}.png`);
          try {
            await page.screenshot({ path: p });
            result.screenshots.push(p);
          } catch (error) {
            result.notes.push(`screenshot ${i} failed: ${error instanceof Error ? error.message : 'error'}`);
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return result;
}

export function renderGameProbeReport(result: GameProbeResult): string {
  const lines: string[] = [];
  const fps = result.fps;
  const canvas = result.canvases[0];
  const errorCount = result.consoleErrors.length + result.pageErrors.length;
  const status = errorCount === 0 ? '✓ running' : `⚠ running with ${errorCount} error(s)`;
  lines.push(
    `${status} · ${fps ? `${fps.average} fps (p95 ${fps.p95FrameMs} ms, ${fps.longFrames} long frame(s))` : 'no fps samples'} · ` +
      `${errorCount} error(s) · ${canvas ? `canvas ${canvas.context} ${canvas.width}×${canvas.height} (DPR ${canvas.dpr})${canvas.blank ? ' — BLANK ⚠' : ''}` : 'no canvas'}` +
      (result.threeStats ? ` · ${result.threeStats.drawCalls} draw calls · ${result.threeStats.triangles} tris` : ''),
  );
  if (fps?.renderer) {
    lines.push(`GPU renderer: ${fps.renderer}${/swiftshader|software/i.test(fps.renderer) ? ' (software GPU — fps is NOT a real-performance measure)' : ''}`);
  }
  if (result.consoleErrors.length > 0) {
    lines.push('');
    lines.push(`console errors (${result.consoleErrors.length}):`);
    for (const e of result.consoleErrors.slice(0, 10)) lines.push(`  ${e}`);
  }
  if (result.pageErrors.length > 0) {
    lines.push(`page errors (${result.pageErrors.length}):`);
    for (const e of result.pageErrors.slice(0, 10)) lines.push(`  ${e}`);
  }
  if (result.failedRequests.length > 0) {
    lines.push(`failed requests (${result.failedRequests.length}):`);
    for (const r of result.failedRequests.slice(0, 10)) lines.push(`  ${r}`);
  }
  if (result.canvases.length > 1) {
    lines.push(`other canvases: ${result.canvases.slice(1).map((c) => `${c.context} ${c.width}×${c.height}${c.blank ? ' (blank)' : ''}`).join(', ')}`);
  }
  if (result.memory?.usedJsHeapMbStart != null && result.memory.usedJsHeapMbEnd != null) {
    lines.push(`JS heap: ${result.memory.usedJsHeapMbStart} MB → ${result.memory.usedJsHeapMbEnd} MB`);
  }
  if (result.screenshots.length > 0) {
    lines.push(`screenshots: ${result.screenshots.map((p) => path.basename(p)).join(', ')} (in <workspace>/.moriko-dat/probe)`);
  }
  return lines.join('\n');
}
