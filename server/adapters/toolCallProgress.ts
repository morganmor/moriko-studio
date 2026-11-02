/**
 * LIVE TOOL-CALL ASSEMBLY PROGRESS — ported from Chuze's
 * `ToolCallStreamAssembler.progress()` (server/src/adapters/toolCallStream.ts).
 *
 * THE GAP THIS CLOSES: `tool_call` only exists once a call's arguments are
 * COMPLETE and parseable, so a panel that waits for it is blank for the entire
 * payload build — minutes on a large edit. The adapter sees every argument
 * fragment as it arrives; this tracker turns that private buffer into a
 * publication: per-call name, UTF-8 byte size, and the element a half-written
 * payload already names.
 *
 * Throttling matters as much as the data: fragments land every few
 * milliseconds and each frame is journaled, so an unthrottled counter would
 * write thousands of lines to say the same thing.
 */

import type { StreamHandler } from '../sse.js';

/** ~120 ms — Chuze's BUILD_PROGRESS_INTERVAL_MS. */
export const BUILD_PROGRESS_INTERVAL_MS = 120;

export interface BuildingTool {
  /** Position in the batch the model is emitting. */
  index?: number;
  /** Tool name, as soon as the provider has announced it. */
  name: string;
  /** UTF-8 bytes of the JSON argument text received so far. */
  bytes: number;
  /** The element this call already names, when the partial JSON reveals it. */
  target?: string;
}

export interface ToolBuildProgress {
  count: number;
  /** Sum of `tools[].bytes` — the number the settled row repeats. */
  bytes: number;
  tools: BuildingTool[];
}

/** Bytes, not characters: the wire is what the user is watching grow. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * The element a half-written call already names.
 *
 * Deliberately a light scan over the PARTIAL text instead of a JSON parse: the
 * document is incomplete by definition, and waiting for one that parses would
 * show nothing during exactly the phase this label exists for.
 */
export function previewTarget(args: string): string | undefined {
  const match = /"(?:path|file_path|target|pattern|query|command|name|text|id|relPath)"\s*:\s*"([^"\\]{1,80})/.exec(args);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  const collapsed = value.replace(/\s+/g, ' ');
  return collapsed.length > 44 ? `${collapsed.slice(0, 44)}…` : collapsed;
}

/**
 * Tracks the argument buffers of every call in the round being assembled.
 *
 * Callers feed the raw fragment the provider just emitted; the tracker keys
 * them exactly like the adapter's own accumulator (`index` from the fragment,
 * name concatenated across frames) so a live row and its later settled row can
 * never describe different calls.
 */
export class ToolBuildTracker {
  private readonly slots = new Map<number, { name: string; args: string }>();
  private lastEmitAt = 0;
  private emitted = false;

  /** True once any fragment has been seen for the current phase. */
  get sawAnyFragment(): boolean {
    return this.emitted;
  }

  reset(): void {
    this.slots.clear();
    this.lastEmitAt = 0;
    this.emitted = false;
  }

  /** Append one fragment. Returns false when the call had no argument text. */
  ingest(index: number, name: string, argsFragment: string): boolean {
    const slot = this.slots.get(index) ?? { name: '', args: '' };
    if (name) slot.name += name;
    if (argsFragment) slot.args += argsFragment;
    this.slots.set(index, slot);
    return Boolean(argsFragment || name);
  }

  /** What is being assembled right now, sized as it arrives. */
  progress(): ToolBuildProgress {
    const tools: BuildingTool[] = [];
    for (const [index, slot] of [...this.slots.entries()].sort((a, b) => a[0] - b[0])) {
      const target = previewTarget(slot.args);
      tools.push({
        index,
        name: slot.name || 'tool',
        bytes: utf8Bytes(slot.args),
        ...(target ? { target } : {}),
      });
    }
    return {
      count: tools.length,
      bytes: tools.reduce((sum, tool) => sum + tool.bytes, 0),
      tools,
    };
  }

  /**
   * Publish the current build state, throttled to ~120 ms.
   *
   * `force` is used for the FIRST fragment of a phase: the strip must appear
   * the instant the model starts writing, not after the throttle window.
   */
  maybeEmit(onEvent: StreamHandler, force = false): void {
    const now = Date.now();
    if (!force && this.emitted && now - this.lastEmitAt < BUILD_PROGRESS_INTERVAL_MS) return;
    this.lastEmitAt = now;
    this.emitted = true;
    onEvent({ type: 'tool_building', at: now, ...this.progress() });
  }
}
