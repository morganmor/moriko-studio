import type { ReactNode } from 'react';

import { brandWordmarkSvgUrl } from '../lib/brandAssets';
import { MorikoCatMark } from './MorikoCatMark';

/**
 * Landing placeholder.
 *
 * Shown before a thread exists (and from the Gallery entry). The animated
 * pixel cat carries the brand here, with the dithered wordmark below it.
 * `children` (the composer in the empty state) renders under the brand block
 * so the prompt sits mid-screen like mainstream chat apps; once a turn
 * exists, the composer docks to the bottom instead (see App).
 *
 * The mode status line ('CHAT MODE ONLY' / 'AGENT MODE ACTIVE') + cat-eye
 * toggle are rendered by the Composer itself (above the panel) — Explore
 * does NOT duplicate them (double status line regression).
 */
export function Explore({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
      {}
      <MorikoCatMark className="h-[256px] w-[256px]" />
      <img
        src={brandWordmarkSvgUrl}
        alt="Moriko Studio"
        draggable={false}
        width={95}
        height={10}
        style={{ aspectRatio: '95 / 10' }}
        className="mt-5 h-[26px] w-auto"
      />
      <p className="mt-2 max-w-md text-sm text-muted">
        Start typing below to begin a new chat.
      </p>
      {children ? <div className="mt-10 flex w-full max-w-4xl flex-col items-stretch">{children}</div> : null}
    </div>
  );
}
