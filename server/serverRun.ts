

import { getStoredConversation, applyTurnPatches, listStoredConversationSummaries } from './conversationStore.js';


const WAKE_SETTINGS = {
  agentMode: true,
  webAccess: true,
  enforcement: { level: 0 },
};

type StoredTurn = { id?: unknown; role?: unknown; content?: unknown; createdAt?: unknown; attachments?: unknown };

interface StoredTurnShape {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  attachments?: Array<Record<string, unknown>>;
}


function toChatMessages(conversationId: string, injectedText: string): Array<{ role: string; content: string }> | null {
  const record = getStoredConversation(conversationId);
  if (!record) return null;
  const turns = (Array.isArray(record.turns) ? record.turns : []) as StoredTurn[];
  const out: Array<{ role: string; content: string }> = [];
  for (const turn of turns) {
    const role = typeof turn?.role === 'string' ? turn.role : null;
    const content = typeof turn?.content === 'string' ? turn.content : '';
    if (!role || !content.trim()) continue;
    if (role === 'tool' || role === 'tool_result') continue;
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
  }
  out.push({ role: 'user', content: injectedText });
  return out;
}


function appendUserTurn(conversationId: string, text: string): void {
  const turn: StoredTurnShape = {
    id: `turn_wake_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: text,
    createdAt: Date.now(),
  };
  applyTurnPatches([{ conversationId, turnId: turn.id, turn }]);
}


async function isGenerating(conversationId: string): Promise<boolean> {
  try {
    const { listLiveStreams } = await import('./streamRegistry.js');
    return listLiveStreams().some((s) => s.conversationId === conversationId);
  } catch {
    return false;
  }
}

export async function startServerRun(
  conversationId: string,
  text: string,
  opts: { providerId?: string; model?: string } = {},
): Promise<{ started: boolean; error?: string }> {
  if (!conversationId || !text.trim()) return { started: false, error: 'conversationId and text are required.' };
  if (await isGenerating(conversationId)) return { started: false, error: 'conversation already generating' };

  const summaries = listStoredConversationSummaries();
  const summary = summaries.find((s) => s.id === conversationId);
  const providerId = opts.providerId || summary?.providerId || '';
  const model = opts.model || summary?.model || '';
  if (!providerId || !model) return { started: false, error: 'conversation has no provider/model binding' };

  const messages = toChatMessages(conversationId, text);
  if (!messages) return { started: false, error: 'conversation not found in the server store (never synced)' };

  appendUserTurn(conversationId, text);

  const body = JSON.stringify({
    providerId,
    model,
    messages,
    settings: WAKE_SETTINGS,
    conversationId,
    assistantTurnId: `turn_${Date.now().toString(36)}`,
    harness: { sessionId: conversationId, refresh: true },
    operatorDirective: text,
  });

  return await keepRunAlive(body);
}


async function keepRunAlive(body: string): Promise<{ started: boolean; error?: string }> {
  const origin = `http://127.0.0.1:${process.env.PORT ?? 8826}`;
  const controller = new AbortController();
  const keeper = (async (): Promise<{ started: boolean; error?: string }> => {
    try {
      const res = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) return { started: false, error: `upstream ${res.status}` };
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      return { started: true };
    } catch (error) {
      return { started: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500));
  try {
    return await Promise.race([keeper, timeout]);
  } catch {
    void keeper.then((r) => { if (!r.started) console.error(`[serverRun] wake run failed: ${r.error}`); });
    return { started: true };
  }
}
