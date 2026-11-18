

export type RenderSite =
  | 'thread-sidebar'
  | 'composer-band'
  | 'right-dock'
  | 'floating'
  | 'tool-row'
  | 'spinner';


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
  
  loadError: string | null;
  status?: AddonStatus;
  apiVersion?: '1' | '2';
  shortName?: string;
  kind?: string;
  
  icon?: string;
  
  permissions?: string[];
  
  builtin?: boolean;
  
  permRecord?: { granted: string[]; denied: string[]; trust?: string };
  hasTools: boolean;
  hasWidgets: boolean;
  widgets: Array<{ site: RenderSite; component: string; label?: string }>;
  commands: Array<{ name: string; description: string; argumentHint?: string }>;
}


export interface AddonViewClientEntry {
  addonId: string;
  id: string;
  title: string;
  icon?: string;
  location: 'sidebar' | 'right-dock' | 'hub' | string;
  component: string;
  badge?: boolean;
}
