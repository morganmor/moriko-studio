/**
 * Image Studio output-size controls — shared by the composer gate
 * (ImageStudio) and the right-dock Configuration section (SettingsPanel),
 * so both UIs read one table of presets and one validator.
 */

import type { ImageSizeMode } from '../types';

/** Presets offered for the aspect-ratio override. */
export const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];

/** The three output-size modes; per provider, some may be unavailable. */
export const SIZE_MODE_OPTIONS = [
  { value: 'off', label: 'Default' },
  { value: 'ratio', label: 'Aspect ratio' },
  { value: 'pixels', label: 'Pixels' },
] as const;

/** Hard bounds for the pixel override, matching the proxy's checks. */
export const PX_MIN = 64;
export const PX_MAX = 4096;

/** Which size modes the selected provider's adapter accepts. */
export function allowedSizeModes(caps: { sizeParam?: string } | undefined | null): ImageSizeMode[] {
  if (!caps || caps.sizeParam === 'none') return caps ? ['off'] : ['off', 'ratio', 'pixels'];
  return ['off', 'ratio', 'pixels'];
}

/** True when both pixel inputs hold a value inside the proxy's bounds. */
export function pixelsValid(width: string, height: string): boolean {
  const w = Number(width);
  const h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w >= PX_MIN && h >= PX_MIN && w <= PX_MAX && h <= PX_MAX;
}
