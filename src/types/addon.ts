/** Client-side addon types — mirrors server/addons/types.ts WITHOUT importing
 *  it (a cross-project import would pull the whole server type graph into the
 *  app tsconfig, whose bundler resolution cannot see node:* modules). */

export type RenderSite =
  | 'thread-sidebar'
  | 'composer-band'
  | 'right-dock'
  | 'floating'
  | 'tool-row'
  | 'spinner';

/** v2 lifecycle status (server/addons/types.ts AddonStatus). */
export type AddonStatus =
  | 'installed'
  | 'invalid'
  | 'blocked'
  | 'needs-consent'
  | 'active'
  | 'error'
  | 'disabled';

export interface AddonClientEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled: boolean;
  /** Non-null when the entry failed to load. */
  loadError: string | null;
  status?: AddonStatus;
  apiVersion?: '1' | '2';
  shortName?: string;
  kind?: string;
  /** Manifest icon: asset path relative to the addon root (resources/icon.svg). */
  icon?: string;
  /** Manifest-declared permissions (v2). */
  permissions?: string[];
  /** True when the addon is a builtin authored in addons-src/ (Remove also deletes the source). */
  builtin?: boolean;
  /** Consent state (v2). */
  permRecord?: { granted: string[]; denied: string[]; trust?: string };
  hasTools: boolean;
  hasWidgets: boolean;
  widgets: Array<{ site: RenderSite; component: string; label?: string }>;
  commands: Array<{ name: string; description: string; argumentHint?: string }>;
}

/** A sidebar view contributed by an addon (GET /api/addons/views). */
export interface AddonViewClientEntry {
  addonId: string;
  id: string;
  title: string;
  icon?: string;
  location: 'sidebar' | 'right-dock' | 'hub' | string;
  component: string;
  badge?: boolean;
}
