

import type { ImageSizeMode } from '../types';


export const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];


export const SIZE_MODE_OPTIONS = [
  { value: 'off', label: 'Default' },
  { value: 'ratio', label: 'Aspect ratio' },
  { value: 'pixels', label: 'Pixels' },
] as const;


export const PX_MIN = 64;
export const PX_MAX = 4096;


export function allowedSizeModes(caps: { sizeParam?: string } | undefined | null): ImageSizeMode[] {
  if (!caps || caps.sizeParam === 'none') return caps ? ['off'] : ['off', 'ratio', 'pixels'];
  return ['off', 'ratio', 'pixels'];
}


export function pixelsValid(width: string, height: string): boolean {
  const w = Number(width);
  const h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w >= PX_MIN && h >= PX_MIN && w <= PX_MAX && h <= PX_MAX;
}
