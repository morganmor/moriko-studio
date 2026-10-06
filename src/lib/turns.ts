import type { Turn } from '../types';

/**
 * An assistant turn that carries nothing observable — a stream that stopped
 * before its first token, or a reply whose output and reasoning were both
 * deleted. It must never count as "the model already answered", or the
 * Continue affordance hides behind an invisible husk. Shared by the Thread
 * renderer and the continue handler in useChatController so both agree on
 * exactly which trailing turns may be skipped.
 */
export function isGhostTurn(turn: Turn): boolean {
  return (
    turn.role === 'assistant' &&
    turn.kind !== 'compaction' &&
    turn.kind !== 'restore' &&
    !turn.content &&
    !turn.reasoning &&
    !turn.segments?.length &&
    !turn.error &&
    !turn.usage
  );
}
