import type { Turn, TurnSegment } from '../types';

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

/**
 * IDENTITY FOR EVERY SEGMENT — the fix for panels that closed themselves.
 *
 * A segment used to be identified by its POSITION in `turn.segments`, so any
 * insertion (a reasoning block recovered at the end of a run, a steer landing
 * between rounds) shifted every later index and React remounted the subtree.
 * A remounted reasoning strip loses its local open state and snaps shut under
 * the reader. New segments carry the server's `blockId` (reasoning) or a
 * controller-minted id; turns persisted before ids existed get a DETERMINISTIC
 * one here, so the same stored turn always resolves to the same key.
 */
export function legacySegmentId(index: number, type: TurnSegment['type']): string {
  return `legacy-${index}-${type}`;
}

/** Page-scoped uniqueness; a reload starts a new namespace, which is fine. */
const SEGMENT_NAMESPACE = Math.random().toString(36).slice(2, 8);
let segmentSeq = 0;

/**
 * Mints an id for a LIVE segment (one the controller is about to append).
 * Server-sent reasoning blocks keep the server's `blockId` instead.
 */
export function nextSegmentId(prefix: 'text' | 'reason' | 'tool'): string {
  segmentSeq += 1;
  return `${prefix}-${SEGMENT_NAMESPACE}-${segmentSeq}`;
}

/**
 * Whether a reasoning strip reads as open.
 *
 * `pinned` is the user's explicit choice and ALWAYS wins — a panel they closed
 * stays closed, a panel they opened is never collapsed for them. With no
 * choice recorded, the policy applies: open while the block streams, and open
 * after a run that ended stopped/failed so its thinking can be audited.
 */
export function reasoningDisclosureOpen(
  pinned: boolean | undefined,
  live: boolean,
  keepOpen: boolean,
): boolean {
  return pinned ?? (live || keepOpen);
}

/**
 * Fills in ids for turns that predate them. Runs on every hydration door
 * (store `dedupeTurns`), never on segments the controller already stamped, and
 * is a no-op when everything has an id.
 */
export function withSegmentIds(turn: Turn): Turn {
  const segments = turn.segments;
  if (!segments?.length) return turn;
  let dirty = false;
  const normalized = segments.map((segment, index): TurnSegment => {
    const needsId = !segment.id;
    const needsStatus = segment.type === 'reasoning' && !segment.status;
    if (!needsId && !needsStatus) return segment;
    dirty = true;
    const base = {
      ...segment,
      id: segment.id || legacySegmentId(index, segment.type),
    };
    return (
      segment.type === 'reasoning'
        ? { ...base, type: 'reasoning', status: segment.status ?? 'done' }
        : base
    ) as TurnSegment;
  });
  return dirty ? { ...turn, segments: normalized } : turn;
}
