

import type { StreamHandler } from '../sse.js';


export const BUILD_PROGRESS_INTERVAL_MS = 120;

export interface BuildingTool {
  
  index?: number;
  
  name: string;
  
  bytes: number;
  
  target?: string;
}

export interface ToolBuildProgress {
  count: number;
  
  bytes: number;
  tools: BuildingTool[];
}


export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}


export function previewTarget(args: string): string | undefined {
  const match = /"(?:path|file_path|target|pattern|query|command|name|text|id|relPath)"\s*:\s*"([^"\\]{1,80})/.exec(args);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  const collapsed = value.replace(/\s+/g, ' ');
  return collapsed.length > 44 ? `${collapsed.slice(0, 44)}…` : collapsed;
}


export class ToolBuildTracker {
  private readonly slots = new Map<number, { name: string; args: string }>();
  private lastEmitAt = 0;
  private emitted = false;

  
  get sawAnyFragment(): boolean {
    return this.emitted;
  }

  reset(): void {
    this.slots.clear();
    this.lastEmitAt = 0;
    this.emitted = false;
  }

  
  ingest(index: number, name: string, argsFragment: string): boolean {
    const slot = this.slots.get(index) ?? { name: '', args: '' };
    if (name) slot.name += name;
    if (argsFragment) slot.args += argsFragment;
    this.slots.set(index, slot);
    return Boolean(argsFragment || name);
  }

  
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

  
  maybeEmit(onEvent: StreamHandler, force = false): void {
    const now = Date.now();
    if (!force && this.emitted && now - this.lastEmitAt < BUILD_PROGRESS_INTERVAL_MS) return;
    this.lastEmitAt = now;
    this.emitted = true;
    onEvent({ type: 'tool_building', at: now, ...this.progress() });
  }
}
