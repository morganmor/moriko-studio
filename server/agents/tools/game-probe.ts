/**
 * F5.2 — agent__game_probe: run a LOCAL game/3D app headless and report
 * runtime facts (fps, WebGL, errors, canvas blank detection, screenshots).
 * Localhost/private ONLY — deliberately NOT gated by Web Access (B10).
 */
import { readFileSync } from 'node:fs';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, truncateOutput } from './shared.js';
import { runGameProbe, renderGameProbeReport, type GameProbeAction } from '../game-probe.js';
import { defineTool } from './registry.js';

async function gameProbeTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const url = str(args, 'url').trim();
  if (!url) {
    return { ok: false, isError: true, text: 'game_probe needs a "url" (localhost or private network only — this tool never reaches the public web).' };
  }
  const actions: GameProbeAction[] = Array.isArray(args.actions)
    ? (args.actions as unknown[]).slice(0, 20).flatMap((a): GameProbeAction[] => {
        if (!a || typeof a !== 'object') return [];
        const rec = a as Record<string, unknown>;
        if (rec.type === 'key' && typeof rec.key === 'string') {
          return [{ type: 'key', key: rec.key, holdMs: typeof rec.holdMs === 'number' ? rec.holdMs : undefined }];
        }
        if (rec.type === 'click') {
          return [{ type: 'click', x: typeof rec.x === 'number' ? rec.x : undefined, y: typeof rec.y === 'number' ? rec.y : undefined }];
        }
        return [];
      })
    : [];

  const viewportW = num(args, 'viewportW');
  const viewportH = num(args, 'viewportH');

  try {
    const result = await runGameProbe(url, {
      durationMs: num(args, 'durationMs'),
      viewport: viewportW && viewportH ? { w: viewportW, h: viewportH } : undefined,
      actions,
      screenshots: num(args, 'screenshots'),
    });
    const report = renderGameProbeReport(result);
    const errors = result.consoleErrors.length + result.pageErrors.length;
    return {
      ok: errors === 0,
      isError: errors > 0,
      text: truncateOutput(`# game_probe — ${url}\n\n${report}\n\nNext: fix reported errors; for vision verification pass a screenshot path to agent__vision.`),
    };
  } catch (error) {
    return { ok: false, isError: true, text: `game_probe failed: ${error instanceof Error ? error.message : 'unknown error'}. Start the dev server first, or check the URL.` };
  }
  void ctx; void readFileSync;
}

export const gameProbeSpec = defineTool({
  def: {
    wireName: 'agent__game_probe',
    description: 'Run a LOCAL game/3D app headless: fps, WebGL info, console/page errors, canvas blank detection, screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'App URL (localhost/private only).' },
        durationMs: { type: 'number', description: 'Sample duration (default 4000, max 30000).' },
        viewportW: { type: 'number', description: 'Viewport width (default 1280).' },
        viewportH: { type: 'number', description: 'Viewport height (default 720).' },
        screenshots: { type: 'number', description: 'Screenshot count (default 3, max 6).' },
        actions: {
          type: 'array',
          description: 'Input actions [{ type: "key", key, holdMs } | { type: "click", x, y }].',
          items: { type: 'object' },
        },
      },
      required: ['url'],
    },
  },
  handler: gameProbeTool,
  readOnly: true,
  category: 'game',
});
