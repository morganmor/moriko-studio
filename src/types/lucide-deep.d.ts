/**
 * P4 ICON SPIKE — lucide 0.469 ships no per-icon declarations (no exports map
 * in its package.json), so the deep imports in src/components/icons.ts would
 * be untyped without this wildcard. Every generated icon re-export is the
 * LucideIcon component shape, same as the barrel exports.
 */
declare module 'lucide-react/dist/esm/icons/*' {
  import type { LucideIcon } from 'lucide-react';

  const icon: LucideIcon;
  export default icon;
}