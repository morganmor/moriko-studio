/**
 * Aspect-ratio presets → concrete pixels, shared by every adapter that must
 * translate a preset into the size format its provider understands.
 *
 * The long edge keeps the provider-friendly default of 1280, a square uses
 * the standard 1024, and dimensions are rounded to even numbers (some
 * encoders reject odd sizes).
 */
export function ratioToWxH(
  ratio: string,
  longEdge = 1280,
  squareEdge = 1024,
): { width: number; height: number } | null {
  const [rawW, rawH] = ratio.split(':').map((part) => Number(part));
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) return null;
  let width: number;
  let height: number;
  if (rawW === rawH) {
    width = squareEdge;
    height = squareEdge;
  } else if (rawW > rawH) {
    width = longEdge;
    height = Math.round((longEdge * rawH) / rawW);
  } else {
    height = longEdge;
    width = Math.round((longEdge * rawW) / rawH);
  }
  if (width % 2 !== 0) width += 1;
  if (height % 2 !== 0) height += 1;
  return { width, height };
}

/** "1280x720" form of {@link ratioToWxH}, or null when the ratio is invalid. */
export function ratioToSize(ratio: string, longEdge?: number, squareEdge?: number): string | null {
  const wxh = ratioToWxH(ratio, longEdge, squareEdge);
  return wxh ? `${wxh.width}x${wxh.height}` : null;
}
