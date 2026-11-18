

import { randomUUID } from 'node:crypto';

export interface OperatorGateRequest {
  id: string;
  sessionId?: string;
  createdAt: number;
  kind: 'lockdown_ack' | 'apology' | 'seize_choice';
  
  enforcementLevel?: 3 | 4 | 5;
  
  noticePreview?: string;
  
  apologyText?: string;
  
  continueCount?: number;
  
  lastReasoningSnippet?: string;
}

export interface OperatorGateDecision {
  verdict: 'accept' | 'reject';
  
  operatorReason: string;
}

interface PendingGate {
  request: OperatorGateRequest;
  resolve: (decision: OperatorGateDecision) => void;
  onAbort?: () => void;
}

const pending = new Map<string, PendingGate>();


export interface OperatorGateContext {
  signal?: AbortSignal;
  
  onGateRequest?: (request: OperatorGateRequest) => void;
  
  onGateResolved?: (id: string, decision: OperatorGateDecision) => void;
}


const ABORT_DECISION: OperatorGateDecision = {
  verdict: 'reject',
  operatorReason: 'The run ended before the operator decided.',
};


export async function requestOperatorGate(
  request: Omit<OperatorGateRequest, 'id' | 'createdAt'>,
  ctx: OperatorGateContext = {},
): Promise<OperatorGateDecision> {
  const id = randomUUID();
  const full: OperatorGateRequest = { ...request, id, createdAt: Date.now() };

  return new Promise<OperatorGateDecision>((resolve) => {
    let settled = false;
    const entry: PendingGate = {
      request: full,
      resolve: () => undefined,
    };

    const settle = (decision: OperatorGateDecision): void => {
      if (settled) return;
      settled = true;
      if (entry.onAbort && ctx.signal) {
        ctx.signal.removeEventListener('abort', entry.onAbort);
      }
      pending.delete(id);
      ctx.onGateResolved?.(id, decision);
      resolve(decision);
    };

    entry.resolve = settle;
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        settle(ABORT_DECISION);
        return;
      }
      entry.onAbort = () => settle(ABORT_DECISION);
      ctx.signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    pending.set(id, entry);
    ctx.onGateRequest?.(full);
  });
}


export function decideGate(id: string, verdict: 'accept' | 'reject', operatorReason: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve({ verdict, operatorReason });
  return true;
}


export function listPendingGates(): OperatorGateRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}
