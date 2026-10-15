/**
 * DESIGN ICONS — path data copied VERBATIM from moriko-design-1 (const P).
 * Renders the reference's exact SVG shapes; sizing/stroke come from the shared
 * `.ic` rule in sidebar.css (16px, stroke-width 1.8, round caps — design line 79).
 */
import type { SVGProps } from 'react';

import { cx } from './ui';

import chatDotsSvgRaw from '../assets/svg/chat-dots.svg?raw';
import dashboardSvgRaw from '../assets/svg/dashboard.svg?raw';
import gallerySvgRaw from '../assets/svg/gallery.svg?raw';
import historySvgRaw from '../assets/svg/history.svg?raw';
import providerSvgRaw from '../assets/svg/provider.svg?raw';
import settingsSvgRaw from '../assets/svg/settings.svg?raw';

export const DESIGN_PATHS: Record<string, string> = { 'panel-l': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>', 'panel-r': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>', plus: '<path d="M12 5v14M5 12h14"/>', history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>', image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>', gallery: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>', wand: '<path d="m15 4 5 5L9 20H4v-5z"/><path d="M13 6l5 5"/>', 'chev-d': '<path d="m6 9 6 6 6-6"/>', 'chev-l': '<path d="m15 18-6-6 6-6"/>', 'chev-r': '<path d="m9 18 6-6-6-6"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', dash: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>', keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>', folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>', more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', 'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>', plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>', send: '<path d="M12 19V5M5 12l7-7 7 7"/>', stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>', upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>', download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>', trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>', layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>', braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>', eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>', retry: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>', check: '<path d="M20 6 9 17l-5-5"/>', globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>', link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>', term: '<path d="m4 17 6-6-6-6M12 19h8"/>', cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>', puzzle: '<path d="M14 4a2 2 0 1 0-4 0v2H6v4h2a2 2 0 1 1 0 4H6v4h4v-2a2 2 0 1 1 4 0v2h4v-4h-2a2 2 0 1 1 0-4h2V6h-4z"/>', clip: '<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15.8 7"/>', cmd: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z"/>', copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>', db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>', file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', pin: '<path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z"/>', tree: '<path d="M5 3v12a2 2 0 0 0 2 2h4M5 8h6"/><rect x="13" y="5" width="8" height="6" rx="1.5"/><rect x="13" y="14" width="8" height="6" rx="1.5"/>', diff: '<path d="M12 3v14M5 10h14M5 21h14"/>', heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>', up: '<path d="M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.4 21H7V10l4-8a3 3 0 0 1 4 3.9z"/>', down: '<path d="M17 14V3M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5.6 3H17v11l-4 8a3 3 0 0 1-4-3.9z"/>', info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>', gem: '<path d="M12 3l6 6-6 9-6-9zM6 9h12"/>', trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>', grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>', activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', nodes: '<circle cx="5" cy="5" r="2.2"/><circle cx="19" cy="7" r="2.2"/><circle cx="7" cy="19" r="2.2"/><circle cx="18" cy="17" r="2.2"/><path d="M7.2 5.6 16.8 6.9M6 7.1 6.8 16.8M17.9 8.9 17.2 14.8M9.2 18.2 15.8 17.4"/>' };

/**
 * Design icon — renders `<svg class="ic …" viewBox="0 0 24 24">` exactly like the
 * reference's `icon(name, extraClass)` helper.
 */
export function DIcon({
  name,
  className,
  ...rest
}: { name: string; className?: string } & SVGProps<SVGSVGElement>) {
  const body = DESIGN_PATHS[name];
  if (!body) return null;
  return (
    <svg
      {...rest}
      className={cx('ic', className)}
      viewBox="0 0 24 24"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

/**
 * ASSET ICONS — the nav glyphs that come from src/assets/svg/*.svg instead of
 * DESIGN_PATHS: gallery, dashboard, chat-dots, settings, history, provider. Each file was adapted
 * to Moriko: 24×24 root, optically tuned viewBox (solid shapes sit at ~75%,
 * outline shapes at ~83% of the box, matching the other `.ic` icons), and
 * currentColor fills/strokes so the glyphs follow the theme (muted → ink →
 * accent on active). Filled paths carry stroke="none" so the shared `.ic`
 * rule (fill:none, stroke:currentColor 1.8) never double-draws them — the one
 * stroked path (chat-dots' three dots) keeps its own stroke-width and round
 * caps from the file.
 *
 * The files are the single source of truth: their inner markup is inlined at
 * build time via `?raw` (same pattern as brandAssets' reasoning loop).
 */
function parseAssetIcon(raw: string): { viewBox: string; body: string } {
  return {
    viewBox: raw.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 24 24',
    body: raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').trim(),
  };
}

const ASSET_ICONS = {
  gallery: parseAssetIcon(gallerySvgRaw),
  dashboard: parseAssetIcon(dashboardSvgRaw),
  chat: parseAssetIcon(chatDotsSvgRaw),
  settings: parseAssetIcon(settingsSvgRaw),
  history: parseAssetIcon(historySvgRaw),
  provider: parseAssetIcon(providerSvgRaw),
} as const;

function AssetIcon({
  asset,
  className,
  ...rest
}: { asset: keyof typeof ASSET_ICONS } & SVGProps<SVGSVGElement>) {
  const { viewBox, body } = ASSET_ICONS[asset];
  return (
    <svg
      viewBox={viewBox}
      aria-hidden="true"
      {...rest}
      className={cx('ic', className)}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

/** Nav icons rendered from the adapted SVG assets — see parseAssetIcon. */
export const GalleryIcon = (props: SVGProps<SVGSVGElement>) => <AssetIcon asset="gallery" {...props} />;
export const DashboardIcon = (props: SVGProps<SVGSVGElement>) => <AssetIcon asset="dashboard" {...props} />;
export const ChatIcon = (props: SVGProps<SVGSVGElement>) => <AssetIcon asset="chat" {...props} />;
export const SettingsIcon = (props: SVGProps<SVGSVGElement>) => <AssetIcon asset="settings" {...props} />;
export const HistoryIcon = (props: SVGProps<SVGSVGElement>) => <AssetIcon asset="history" {...props} />;
export const ProviderIcon = (props: SVGProps<SVGSVGElement>) => <AssetIcon asset="provider" {...props} />;
