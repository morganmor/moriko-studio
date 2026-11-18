
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, resolveWithPermission, checkWebAccessUrl } from './shared.js';
import { visionPolicyFor, noteVisionCall } from './vision-policy.js';
import { callVisionModel, resolveImageSource } from '../vision.js';
import { getVisionConfig } from '../../visionConfig.js';
import { resolveCredentials } from '../../credentials.js';
import { resolveWithoutProvider } from '../../modelCapability.js';
import { providerStore } from '../../store.js';
import { boundedGet } from '../net.js';


function visionUnconfigured(): HarnessToolResult {
  return {
    ok: false,
    isError: true,
    text:
      'Vision is not configured. Ask the user to set it up in the app: Configuration → Vision ' +
      '(choose a provider, paste its key, and pick a multimodal model). Then retry this call.',
  };
}

export async function visionStatusTool(_args: Record<string, unknown>, _ctx: AgentToolContext): Promise<HarnessToolResult> {
  const config = await getVisionConfig();
  if (!config.providerId || !config.model) return visionUnconfigured();
  try {
    await resolveCredentials(providerStore, config.providerId);
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text:
        `Vision is configured for ${config.providerId}/${config.model} but its key is not usable: ` +
        `${error instanceof Error ? error.message : 'credential resolution failed.'}`,
    };
  }
  return {
    ok: true,
    isError: false,
    text:
      `Vision is configured: ${config.providerId}/${config.model} answers agent__vision calls. ` +
      'Provide a workspace path, a public image URL, or a data: URL.',
  };
}

export async function visionTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const caps = ctx.modelId ? (ctx.capability ?? resolveWithoutProvider(ctx.modelId)) : undefined;
  const policy = visionPolicyFor(ctx.sessionId);
  if (ctx.sessionId && caps?.imageIn && (policy?.readImages.size ?? 0) === 0) {
    return {
      ok: false,
      isError: true,
      text:
        'FORBIDDEN: this model accepts images natively (imageIn), so delegating to agent__vision is not allowed ' +
        'before you have looked with your own eyes. Call read_file { path } on the image first — read_file returns ' +
        'the image inline and you see it directly. If read_file also failed (not an image, or over the 20 MB inline ' +
        'cap), explain that to the user instead of delegating.',
    };
  }
  noteVisionCall(ctx.sessionId);

  const question = str(args, 'question').trim();
  const inputPath = str(args, 'path').trim();
  const url = str(args, 'url').trim();
  const dataUrl = str(args, 'dataUrl').trim();
  const source = inputPath || url || dataUrl;
  if (!source) {
    return {
      ok: false,
      isError: true,
      text: 'vision needs ONE of: "path" (workspace image), "url" (public image URL), or "dataUrl" (a data: URL).',
    };
  }
  if (!inputPath && url) {
    const blocked = checkWebAccessUrl(url, ctx, 'agent__vision');
    if (blocked) {
      return { ok: false, isError: true, errorCode: 'web_access_off', text: blocked };
    }
  }

  const config = await getVisionConfig();
  if (!config.providerId || !config.model) return visionUnconfigured();

  let resolvedSource: { buffer: Buffer; mime: string };
  try {
    if (inputPath) {
      const { absolute } = await resolveWithPermission('vision', inputPath, ctx, 'read');
      const out = await resolveImageSource(absolute, fetchPublicImage);
      if (!out) {
        return {
          ok: false,
          isError: true,
          text: `"${inputPath}" is not a supported image (expected png/jpg/jpeg/gif/webp/bmp/tiff).`,
        };
      }
      resolvedSource = out;
    } else {
      if (url) {
        const blocked = checkWebAccessUrl(url, ctx, 'agent__vision');
        if (blocked) {
          return { ok: false, isError: true, errorCode: 'web_access_off', text: blocked };
        }
      }
      const out = await resolveImageSource(url || dataUrl, fetchPublicImage);
      if (!out) {
        return {
          ok: false,
          isError: true,
          text: 'The given url/dataUrl is not a supported image (expected an image content type).',
        };
      }
      resolvedSource = out;
    }
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `vision could not read the image: ${error instanceof Error ? error.message : 'unknown error.'}`,
    };
  }

  ctx.onProgress?.(`Asking ${config.providerId}/${config.model}…`);
  try {
    const result = await callVisionModel(
      { providerId: config.providerId, model: config.model, baseUrl: config.baseUrl },
      { buffer: resolvedSource.buffer, mime: resolvedSource.mime, question },
      (providerId, browserKey) => resolveCredentials(providerStore, providerId, browserKey),
    );
    return {
      ok: true,
      isError: false,
      text: [
        `SECONDHAND DESCRIPTION — ${result.by} reports:`,
        '',
        result.text,
        '',
        "[Delegated description from the vision model above, NOT the agent's own perception. Relay it with attribution (\"<model> reports…\"), never as \"I see…\", and verify claims that matter before presenting them as fact.]",
      ].join('\n'),
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `vision failed: ${error instanceof Error ? error.message : 'unknown error.'}`,
    };
  }
}


export async function fetchPublicImage(rawUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  const result = await boundedGet(rawUrl);
  return { buffer: result.buffer, contentType: result.contentType };
}
