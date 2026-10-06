/**
 * Brand artwork pointers — the single place that decides which SVG files the
 * app's brand marks render.
 *
 * To swap a mark everywhere it appears, change its import below to any other
 * standalone SVG. Animations (SMIL or CSS keyframes) come along for free,
 * because each file is loaded as-is:
 *
 *   import catSvgUrl from '../../public/svg/moriko-landing.svg?url';
 *   import catSvgUrl from '../../public/svg/moriko-astro.svg?url';
 *   import catSvgUrl from '../../public/svg/moriko-miau.svg?url';
 */
import catSvgUrl from '../../public/svg/moriko-miau.svg?url';
import wordmarkSvgUrl from '../../public/svg/moriko-dither.svg?url';
import catHeadSvgUrl from '../../public/svg/moriko-miaw-head.svg?url';
import loadingSvgUrl from '../../public/svg/moriko-miau-loading.svg?url';
import reasoningLoopSvg from '../../public/svg/reasoning_loop.svg?raw';

/** URL of the animated cat artwork (currently: public/svg/moriko-miau.svg). */
export const brandCatSvgUrl: string = catSvgUrl;

/** URL of the dithered "MORIKO-LLM" wordmark (public/svg/moriko-dither.svg). */
export const brandWordmarkSvgUrl: string = wordmarkSvgUrl;

/** URL of the cat head mark — the miaw artwork cropped to its head
 *  (public/svg/moriko-miaw-head.svg, viewBox 52 72 152 100). */
export const brandCatHeadSvgUrl: string = catHeadSvgUrl;

/** URL of the animated loading cat, shown while the model is working
 *  (public/svg/moriko-miau-loading.svg). */
export const brandLoadingSvgUrl: string = loadingSvgUrl;

/** Raw markup of the reasoning loop mark (public/svg/reasoning_loop.svg) — inlined
 *  (not ?url) so document CSS can pause its built-in animation when the
 *  reasoning is no longer live; an <img> would run it forever untouchable. */
export const brandReasoningLoopSvg: string = reasoningLoopSvg;
