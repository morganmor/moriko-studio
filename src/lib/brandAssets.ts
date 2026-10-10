/**
 * Brand artwork pointers — the single place that decides which SVG files the
 * app's brand marks render.
 *
 * To swap a mark everywhere it appears, change its import below to any other
 * standalone SVG. Animations (SMIL or CSS keyframes) come along for free,
 * because each file is loaded as-is:
 *
 *   import catSvgUrl from '../assets/svg/moriko-landing.svg?url';
 *   import catSvgUrl from '../assets/svg/moriko-astro.svg?url';
 *   import catSvgUrl from '../assets/svg/moriko-miau.svg?url';
 */
import catSvgUrl from '../assets/svg/moriko-miau.svg?url';
import wordmarkSvgUrl from '../assets/svg/moriko-dither.svg?url';
import catHeadSvgUrl from '../assets/svg/moriko-miaw-head.svg?url';
import loadingSvgUrl from '../assets/svg/moriko-miau-loading.svg?url';
import reasoningLoopSvg from '../assets/svg/reasoning_loop.svg?raw';
import emptyDownloadSvg from '../assets/svg/download.svg?raw';
import emptyHistorySvg from '../assets/svg/history.svg?raw';

/** URL of the animated cat artwork (currently: src/assets/svg/moriko-miau.svg). */
export const brandCatSvgUrl: string = catSvgUrl;

/** URL of the dithered "MORIKO-LLM" wordmark (src/assets/svg/moriko-dither.svg). */
export const brandWordmarkSvgUrl: string = wordmarkSvgUrl;

/** URL of the cat head mark — the miaw artwork cropped to its head
 *  (src/assets/svg/moriko-miaw-head.svg, viewBox 52 72 152 100). */
export const brandCatHeadSvgUrl: string = catHeadSvgUrl;

/** URL of the animated loading cat, shown while the model is working
 *  (src/assets/svg/moriko-miau-loading.svg). */
export const brandLoadingSvgUrl: string = loadingSvgUrl;

/** Raw markup of the reasoning loop mark (src/assets/svg/reasoning_loop.svg) — inlined
 *  (not ?url) so document CSS can pause its built-in animation when the
 *  reasoning is no longer live; an <img> would run it forever untouchable. */
export const brandReasoningLoopSvg: string = reasoningLoopSvg;

/** Raw inline marks for the Gallery / Image History empty-state icon chips
 *  (src/assets/svg/download.svg, history.svg) — inlined like the reasoning
 *  loop so their strokes follow the theme accent via currentColor. */
export const brandEmptyDownloadSvg: string = emptyDownloadSvg;
export const brandEmptyHistorySvg: string = emptyHistorySvg;
