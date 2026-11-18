

import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, truncateOutput } from './shared.js';
import { defineTool } from './registry.js';
import { requestApproval } from '../permissions.js';
import { getActiveWorkspace } from '../workspace.js';
import { listSessions } from '../sessionRegistry.js';
import { listLiveStreams, abortStream } from '../../streamRegistry.js';
import { getStoredConversation } from '../../conversationStore.js';
import { startServerRun } from '../../serverRun.js';


function resolveTarget(raw: string): { conversationId: string; label: string; model?: string; providerId?: string } | { error: string } {
  const target = raw.trim();
  if (!target) return { error: 'A "sessionId" is required — use the id from council_status or the session list.' };

  try {
    const reg = listSessions().find((s) => s.sessionId === target || s.conversationId === target);
    if (reg) {
      const convId = reg.conversationId ?? reg.sessionId;
      return { conversationId: convId, label: convId, model: reg.model };
    }
  } catch {  }

  const stored = getStoredConversation(target);
  if (stored) {
    const meta = stored as { model?: unknown; providerId?: unknown };
    return {
      conversationId: target,
      label: typeof stored.title === 'string' ? stored.title : target,
      model: typeof meta.model === 'string' ? meta.model : undefined,
      providerId: typeof meta.providerId === 'string' ? meta.providerId : undefined,
    };
  }

  let known: string[] = [];
  try { known = listSessions().map((s) => s.conversationId ?? s.sessionId); } catch {  }
  return {
    error:
      `Unknown session "${target}". Known live sessions: ${known.slice(0, 8).join(', ') || 'none'}. ` +
      'Council sub-session ids look like "chat_…" — get them from council_status (agent id ≠ session id).',
  };
}

async function callSubAgent(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const resolved = resolveTarget(str(args, 'sessionId'));
  if ('error' in resolved) return { ok: false, isError: true, errorCode: 'schema_error', text: resolved.error };

  const text = str(args, 'text').trim();
  if (!text) return { ok: false, isError: true, errorCode: 'schema_error', text: 'A non-empty "text" is required — it is delivered as the sub-agent\'s next user turn.' };

  const root = getActiveWorkspace(ctx.sessionId)?.path ?? '';
  const { granted, reason } = await requestApproval(
    {
      tool: 'call-sub-agent',
      paths: [],
      root,
      intent: 'exec',
      command: `Send message to sub-agent "${resolved.label}" (${resolved.conversationId}): ${text.slice(0, 140)}`,
    },
    ctx,
  );
  if (!granted) {
    return {
      ok: false,
      isError: true,
      errorCode: 'approval_denied',
      text: `The user did not approve messaging "${resolved.label}".${reason ? ` Reason: "${reason}".` : ''}`,
    };
  }

  const report = await startServerRun(resolved.conversationId, text, {
    providerId: str(args, 'providerId') || resolved.providerId,
    model: str(args, 'model') || resolved.model,
  });
  if (!report.started) {
    return {
      ok: false,
      isError: true,
      text:
        `Message NOT delivered to ${resolved.label}: ${report.error ?? 'unknown error'}.` +
        (report.error === 'conversation already generating'
          ? ' The session is busy — your text would interleave mid-run. Retry after it finishes, or use steer if available.'
          : ''),
    };
  }
  return {
    ok: true,
    isError: false,
    text: `Message delivered to "${resolved.label}" (${resolved.conversationId}) as a user turn — its generation is starting server-side now.`,
  };
}

async function stopSubAgent(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const target = str(args, 'sessionId').trim();
  if (!target) return { ok: false, isError: true, errorCode: 'schema_error', text: 'A "sessionId" is required.' };

  let stream: { id: string; conversationId: string | null } | undefined;
  try {
    const live = listLiveStreams();
    stream = live.find((s) => s.conversationId === target) ?? live.find((s) => s.id === target);
  } catch {  }
  if (!stream) {
    return { ok: false, isError: true, text: `No live generation found for "${target}" — nothing to stop. (call-sub-agent starts runs; a finished/queued session has no stream.)` };
  }

  const root = getActiveWorkspace(ctx.sessionId)?.path ?? '';
  const { granted, reason } = await requestApproval(
    { tool: 'stop-sub-agent', paths: [], root, command: `Stop the running response of session ${stream.conversationId ?? stream.id}` },
    ctx,
  );
  if (!granted) {
    return { ok: false, isError: true, text: `The user did not approve stopping ${stream.conversationId ?? stream.id}.${reason ? ` Their reason: "${reason}".` : ''} The run continues.` };
  }

  const stopped = abortStream(stream.id);
  return stopped
    ? { ok: true, isError: false, text: `Stopped: the generation of ${stream.conversationId ?? stream.id} was aborted (user approved).` }
    : { ok: false, isError: true, text: `Abort signal failed for ${stream.id} — the stream may have finished between the approval and the abort.` };
}

export const callSubAgentSpec = defineTool({
  def: {
    wireName: 'agent__call-sub-agent',
    description:
      'Send a message to ANOTHER chat session in this harness (e.g. a council sub-agent) as if the user typed it: the text becomes a user turn and its generation starts server-side. Pass the target session/conversation id (council sub-sessions expose theirs via council_status).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session/conversation id (council sub-sessions use their unique chat id).' },
        text: { type: 'string', description: 'The message — delivered exactly like a user input.' },
        providerId: { type: 'string', description: 'Optional provider override (defaults to the target conversation binding).' },
        model: { type: 'string', description: 'Optional model override.' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  handler: callSubAgent,
  category: 'orchestration',
});

export const stopSubAgentSpec = defineTool({
  def: {
    wireName: 'agent__stop-sub-agent',
    description:
      'Stop the RUNNING generation of another session in this harness. REQUIRES explicit user approval — the tool pauses and shows a permission card; without an approve it fails and the run continues.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session/conversation id (or live stream id).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  handler: stopSubAgent,
  category: 'orchestration',
});

export function subAgentSummary(): string {
  return truncateOutput(`call-sub-agent/stop-sub-agent registered; live streams: ${listLiveStreams().length}`);
}
