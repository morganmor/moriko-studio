import type { Turn, TurnSegment } from '../types';


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


export function legacySegmentId(index: number, type: TurnSegment['type']): string {
  return `legacy-${index}-${type}`;
}


const SEGMENT_NAMESPACE = Math.random().toString(36).slice(2, 8);
let segmentSeq = 0;


export function nextSegmentId(prefix: 'text' | 'reason' | 'tool'): string {
  segmentSeq += 1;
  return `${prefix}-${SEGMENT_NAMESPACE}-${segmentSeq}`;
}


export function reasoningDisclosureOpen(
  pinned: boolean | undefined,
  live: boolean,
  keepOpen: boolean,
): boolean {
  return pinned ?? (live || keepOpen);
}


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
