import { brandCatSvgUrl } from '../lib/brandAssets';

/**
 * Moriko cat mark — the brand cat logo and its animation, loaded from a
 * standalone SVG file instead of inlined JSX.
 *
 * The artwork is whatever `src/lib/brandAssets.ts` points at. Swapping the
 * pointed-to SVG (e.g. `public/svg/moriko-landing.svg` → `public/svg/moriko-miau.svg`)
 * swaps the logo and its animation without touching this component.
 *
 * Rendered as an `<img>` so the SVG runs in its own document: its SMIL or
 * CSS-keyframe animations play untouched, and its `<style>` blocks and
 * element ids never leak into the app's CSS. `className` controls the box;
 * the artwork keeps its 256×256 view box, so render at 256px to keep pixel
 * rows snapped to whole device pixels (see Explore's note).
 */
export function MorikoCatMark({ className }: { className?: string }) {
  return (
    <img
      src={brandCatSvgUrl}
      alt="Moriko cat logo"
      draggable={false}
      width={256}
      height={256}
      style={{ aspectRatio: '1 / 1' }}
      className={className}
    />
  );
}
