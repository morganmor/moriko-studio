
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


export function ratioToSize(ratio: string, longEdge?: number, squareEdge?: number): string | null {
  const wxh = ratioToWxH(ratio, longEdge, squareEdge);
  return wxh ? `${wxh.width}x${wxh.height}` : null;
}
