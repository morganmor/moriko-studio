/** Client-side addon types — mirrors server/addons/types.ts WITHOUT importing
 * it (a cross-project import would pull the whole server type graph into the
 * app tsconfig, whose bundler resolution cannot see node:* modules). */

export type RenderSite =
  | 'thread-sidebar'
  | 'composer-band'
  | 'right-dock'
  | 'floating'
  | 'tool-row'
  | 'spinner';

export interface AddonClientEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  hasTools: boolean;
  hasWidgets: boolean;
  widgets: Array<{ site: RenderSite; component: string; label?: string }>;
  commands: Array<{ name: string; description: string; argumentHint?: string }>;
}
