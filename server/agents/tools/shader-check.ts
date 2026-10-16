/**
 * F5.3 — shader_check: compile GLSL (via headless Chromium WebGL) or WGSL
 * (via WebGPU when available) and report errors mapped to file lines.
 * Optional three.js ShaderMaterial prelude so three shaders pass without
 * their injected uniforms. Browser instance reused for ~60 s.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, truncateOutput, resolveWithPermission } from './shared.js';
import { loadPlaywright } from '../spatial-runtime.js';
import { defineTool } from './registry.js';

const LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** Browser-side GLSL compile check (runs as a string inside the page). */
const GLSL_CHECK_FN = `function (src, isVertex) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return { ok: false, backend: 'no-webgl', errors: [{ line: 0, message: 'WebGL not available in headless browser' }] };
  const shader = gl.createShader(isVertex ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  const log = gl.getShaderInfoLog(shader) || '';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return { ok: true, backend: 'webgl', errors: [], renderer };
  }
  const errors = [];
  for (const line of log.split('\\n')) {
    const m = line.match(/ERROR:\\s*\\d+:(\\d+):\\s*(.*)/);
    if (m) errors.push({ line: Number(m[1]), message: m[2] });
    else if (line.trim()) errors.push({ line: 0, message: line.trim() });
  }
  return { ok: false, backend: 'webgl', errors, renderer };
}`;

/** Browser-side WGSL compile check (async; runs as a string inside the page). */
const WGSL_CHECK_FN = `async function (src) {
  const nav = navigator;
  if (!nav.gpu) return { ok: false, backend: 'no-webgpu', errors: [{ line: 0, message: 'WebGPU not available headless' }] };
  try {
    const adapter = await nav.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: src });
    const info = await module.getCompilationInfo();
    const errors = info.messages
      .filter((m) => m.type === 'error')
      .map((m) => ({ line: m.lineNum, message: m.message }));
    return { ok: errors.length === 0, backend: 'webgpu', errors };
  } catch (e) {
    return { ok: false, backend: 'webgpu', errors: [{ line: 0, message: String(e) }] };
  }
}`;

/** three.js ShaderMaterial built-ins (vertex + fragment merged; unused = ok). */
const THREE_PRELUDE_VERT = `
precision highp float; precision highp int;
uniform mat4 modelMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
uniform mat4 viewMatrix; uniform mat3 normalMatrix; uniform vec3 cameraPosition;
attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
#ifdef USE_INSTANCING
attribute mat4 instanceMatrix;
#endif
`;
const THREE_PRELUDE_FRAG = `
precision highp float; precision highp int;
uniform mat4 viewMatrix; uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;

/** Cache: one browser kept alive ~60 s between shader checks. */
let cachedBrowser: import('playwright-core').Browser | null = null;
let cachedAt = 0;
const BROWSER_TTL_MS = 60_000;

async function getBrowser() {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('playwright-core is not installed. Run: pnpm add -D playwright-core.');
  if (cachedBrowser && cachedBrowser.isConnected() && Date.now() - cachedAt < BROWSER_TTL_MS) {
    cachedAt = Date.now();
    return cachedBrowser;
  }
  if (cachedBrowser) await cachedBrowser.close().catch(() => undefined);
  try {
    cachedBrowser = await pw.chromium.launch({ headless: true, channel: 'msedge', args: LAUNCH_ARGS });
  } catch {
    cachedBrowser = await pw.chromium.launch({ headless: true, args: LAUNCH_ARGS });
  }
  cachedAt = Date.now();
  setTimeout(() => {
    void cachedBrowser?.close().catch(() => undefined);
    cachedBrowser = null;
  }, BROWSER_TTL_MS).unref?.();
  return cachedBrowser;
}

/** Extract shader source from a .ts/.js template literal via exportName. */
function extractInlineShader(content: string, exportName: string): string | null {
  const re = new RegExp(`(?:const|let|var)\\s+${exportName}\\s*=\\s*\`([\\s\\S]*?)\``);
  const m = content.match(re);
  return m ? m[1] : null;
}

export interface ShaderCheckResult {
  ok: boolean;
  errors: Array<{ line: number; message: string }>;
  renderer: string | null;
  backend: string;
}

export async function checkGlsl(
  source: string,
  stage: 'vertex' | 'fragment',
  glslVersion: string,
  defines: Record<string, string | number>,
  prelude: string | null,
): Promise<ShaderCheckResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const defineLines = Object.entries(defines).map(([k, v]) => `#define ${k} ${v}\n`).join('');
    const stageHeader = glslVersion === '300 es' ? (stage === 'vertex' ? '#version 300 es\n' : '#version 300 es\n') : '';
    const fullSource = `${stageHeader}${defineLines}${prelude ?? ''}\n${source}`;
    const preludeLineCount = (stageHeader + defineLines + (prelude ?? '')).split('\n').length - 1;

    const outcome = JSON.parse(await page.evaluate(
      `(${GLSL_CHECK_FN})(${JSON.stringify(fullSource)}, ${stage === 'vertex'})`,
    )) as ShaderCheckResult & { renderer?: string | null };

    for (const err of outcome.errors) {
      if (err.line > 0) err.line = Math.max(err.line - preludeLineCount, 1);
    }
    return { ok: outcome.ok, errors: outcome.errors, renderer: outcome.renderer ?? null, backend: outcome.backend };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function checkWgsl(source: string): Promise<ShaderCheckResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const outcome = JSON.parse(await page.evaluate(
      `(${WGSL_CHECK_FN})(${JSON.stringify(source)})`,
    )) as ShaderCheckResult;
    return outcome;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function shaderCheckTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const filePath = str(args, 'path').trim();
  if (!filePath) return { ok: false, isError: true, text: 'shader_check needs a "path" (shader file, or .ts/.js with inline shader + "exportName").' };
  const resolved = await resolveWithPermission('shader_check', filePath, ctx);
  let content: string;
  try { content = readFileSync(resolved.absolute, 'utf8'); } catch {
    return { ok: false, isError: true, text: `Cannot read file: ${resolved.relative}.` };
  }
  const exportName = str(args, 'exportName').trim();
  const ext = path.extname(resolved.absolute).toLowerCase();
  let source = content;
  if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
    if (!exportName) {
      return { ok: false, isError: true, text: `"${resolved.relative}" is a TS/JS file — pass "exportName" (const holding the template literal).` };
    }
    const extracted = extractInlineShader(content, exportName);
    if (!extracted) {
      return { ok: false, isError: true, text: `No template literal \`${exportName}\` found in ${resolved.relative}.` };
    }
    source = extracted;
  }

  const lang = str(args, 'lang').trim().toLowerCase();
  const effectiveLang = lang || (ext === '.wgsl' ? 'wgsl' : 'glsl');
  const defines: Record<string, string | number> = {};
  if (args.defines && typeof args.defines === 'object') {
    for (const [k, v] of Object.entries(args.defines as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') defines[k] = v;
    }
  }
  const prelude = str(args, 'prelude').trim().toLowerCase();

  try {
    let result: ShaderCheckResult;
    if (effectiveLang === 'wgsl') {
      result = await checkWgsl(source);
    } else {
      const stage = (str(args, 'stage').trim().toLowerCase() || 'fragment') as 'vertex' | 'fragment';
      const glslVersion = str(args, 'glslVersion').trim() || '300 es';
      const preludeSrc = prelude === 'three'
        ? (stage === 'vertex' ? THREE_PRELUDE_VERT : THREE_PRELUDE_FRAG)
        : null;
      result = await checkGlsl(source, stage, glslVersion, defines, preludeSrc);
    }

    const header = `# shader_check — ${resolved.relative} (${effectiveLang}${prelude ? `, prelude ${prelude}` : ''}) via ${result.backend}${result.renderer ? ` (${result.renderer})` : ''}`;
    if (result.ok) {
      return { ok: true, isError: false, text: `${header}\n✓ compiled clean.` };
    }
    const lines = [header, `✗ ${result.errors.length} error(s):`];
    for (const err of result.errors.slice(0, 25)) {
      lines.push(`  ${err.line > 0 ? `${resolved.relative}:${err.line}: ` : ''}${err.message}`);
    }
    return { ok: false, isError: true, text: truncateOutput(lines.join('\n')) };
  } catch (error) {
    return { ok: false, isError: true, text: `shader_check failed: ${error instanceof Error ? error.message : 'unknown error'}.` };
  }
}

export const shaderCheckSpec = defineTool({
  def: {
    wireName: 'agent__shader_check',
    description: 'Compile a GLSL/WGSL shader headless and report errors with file line numbers; prelude "three" injects ShaderMaterial built-ins.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Shader file (or .ts/.js with inline shader).' },
        stage: { type: 'string', enum: ['vertex', 'fragment'], description: 'GLSL stage (default "fragment").' },
        lang: { type: 'string', enum: ['glsl', 'wgsl'], description: 'Language (default: from extension).' },
        glslVersion: { type: 'string', description: 'GLSL version (default "300 es").' },
        defines: { type: 'object', description: '#define map, e.g. { "USE_FOG": 1 }.' },
        prelude: { type: 'string', enum: ['three'], description: 'Inject library built-ins (three ShaderMaterial).' },
        exportName: { type: 'string', description: 'For .ts/.js: the const holding the template literal.' },
      },
      required: ['path'],
    },
  },
  handler: shaderCheckTool,
  readOnly: true,
  category: 'game',
});
