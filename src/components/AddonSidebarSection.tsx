

import { memo, useEffect, useState, type ReactNode } from 'react';

import { NavGroup, SubItem } from './ui-kit-exports';
import { CollapseSection, cx } from './ui';
import { DIcon } from './designIcons';
import { useStore } from '../store/useStore';
import type { AddonClientEntry, AddonViewClientEntry } from '../types/addon';
import type { ViewId } from '../types';

function statusDotClass(addon: AddonClientEntry): string {
  switch (addon.status) {
    case 'active': return addon.enabled ? 'ok' : 'muted';
    case 'needs-consent': return 'warn';
    case 'blocked': case 'invalid': case 'error': return 'danger';
    case 'disabled': return 'muted';
    default: return addon.enabled ? 'ok' : 'muted';
  }
}


function addonIcon(doc: AddonClientEntry): string {
  const id = doc.id.toLowerCase();
  const name = (doc.name + ' ' + doc.shortName + ' ' + (doc.kind ?? '') + ' ' + doc.description).toLowerCase();
  if (id.includes('rsat') || name.includes('quest') || name.includes('achievement') || name.includes('rsa/t')) return 'gem';
  if (doc.hasWidgets || name.includes('widget') || name.includes('panel') || name.includes('visual')) return 'layers';
  if (doc.commands.length > 0 || name.includes('command') || name.includes('shortcut')) return 'cmd';
  if ((doc.permissions ?? []).length > 0 || name.includes('perm') || name.includes('auth') || name.includes('guard') || name.includes('security')) return 'shield';
  if (name.includes('sync') || name.includes('git') || name.includes('pulse') || name.includes('watch') || name.includes('monitor')) return 'zap';
  if (name.includes('perf') || name.includes('lens') || name.includes('prof') || name.includes('metric')) return 'cpu';
  if (name.includes('notif') || name.includes('alert') || name.includes('bell')) return 'bell';
  if (name.includes('file') || name.includes('export') || name.includes('data') || name.includes('store')) return 'db';
  if (name.includes('image') || name.includes('paint') || name.includes('art') || name.includes('gallery')) return 'image';
  return 'puzzle';
}


function addonTail(addon: AddonClientEntry): ReactNode {
  if (addon.status === 'needs-consent') return <span className="addon-tail warn">Approve</span>;
  if (addon.status === 'error' || addon.status === 'invalid' || addon.status === 'blocked') return <span className="addon-tail danger">error</span>;
  if (addon.apiVersion === '1') return <span className="addon-tail legacy">legacy</span>;
  if (!addon.enabled || addon.status === 'disabled') return <span className="addon-tail off">off</span>;
  return null;
}


function addonSubtitle(addon: AddonClientEntry): string {
  if (addon.status === 'needs-consent') return 'Needs approval';
  if (addon.loadError) return 'Failed to load';
  if (addon.status === 'error') return 'Error';
  if (addon.status === 'blocked') return 'Blocked';
  if (!addon.enabled) return 'Disabled';
  return `v${addon.version}${addon.author ? ` · ${addon.author}` : ''}`;
}


function AddonLogo({ addon }: { addon: AddonClientEntry }) {
  const src = addon.icon && /\.svg$/i.test(addon.icon)
    ? `/api/addons/${addon.id}/client/${addon.icon.replace(/^\.?\//, '')}`
    : null;
  return (
    <span className="addon-ic">
      {src ? (
        <span
          className="addon-ic-img"
          aria-hidden="true"
          style={{ maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")` }}
        />
      ) : (
        <DIcon name={addonIcon(addon)} className="ic" aria-hidden="true" />
      )}
      <span className={cx('addon-ic-dot', `dot-${statusDotClass(addon)}`)} aria-hidden="true" />
    </span>
  );
}

export const AddonSidebarSection = memo(function AddonSidebarSection({ go }: { go: (view: ViewId, options?: { keepDrawer?: boolean }) => void }) {
  const [addons, setAddons] = useState<AddonClientEntry[]>([]);
  const [views, setViews] = useState<AddonViewClientEntry[]>([]);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [sectionOpen, setSectionOpen] = useState(true);
  const view = useStore((state) => state.view);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, v] = await Promise.all([
          fetch('/api/addons').then((resp) => (resp.ok ? resp.json() : null)),
          fetch('/api/addons/views').then((resp) => (resp.ok ? resp.json() : null)),
        ]);
        if (cancelled) return;
        if (a?.addons) setAddons(a.addons as AddonClientEntry[]);
        if (v?.views) setViews(v.views as AddonViewClientEntry[]);
      } catch {  }
    };
    void load();
    const onReload = () => void load();
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => {
      cancelled = true;
      window.removeEventListener('moriko:addons-reloaded', onReload);
    };
  }, []);

  if (addons.length === 0) return null;

  return (
    <div>
      {}
      <div className="sec-row">
        <button
          type="button"
          onClick={() => setSectionOpen((open) => !open)}
          aria-expanded={sectionOpen}
          className="sec-label tog"
        >
          <span>Addons</span>
          <DIcon name="chev-d" className="chev" aria-hidden="true" />
        </button>
        <div className="pop-host">
          <button
            type="button"
            onClick={() => go('addons')}
            aria-label="Open Addon Hub"
            aria-current={view === 'addons' ? 'page' : undefined}
            className="ib xs"
          >
            <DIcon name="addon" className="ic" aria-hidden="true" />
          </button>
        </div>
      </div>

      <CollapseSection open={sectionOpen}>
        {addons.map((addon) => {
          const addonViews = views.filter((v) => v.addonId === addon.id && v.location === 'sidebar');
          const open = openMap[addon.id] ?? true;
          const leaf = addonViews.length === 0;
          return (
            <NavGroup
              key={addon.id}
              icon={<AddonLogo addon={addon} />}
              label={addon.shortName ?? addon.name}
              subtitle={addonSubtitle(addon)}
              tail={addonTail(addon)}
              open={open}
              leaf={leaf}
              onToggle={leaf ? () => go(`addon:${addon.id}` as ViewId) : () => setOpenMap((current) => ({ ...current, [addon.id]: !open }))}
              count={addonViews.length > 0 ? addonViews.length : undefined}
            >
              {addonViews.map((entry) => (
                <SubItem
                  key={`${addon.id}/${entry.id}`}
                  icon={<DIcon name={entry.icon && entry.icon !== 'default' ? entry.icon : 'chev-r'} className="ic" />}
                  label={entry.title}
                  active={view === `addon:${addon.id}/${entry.id}`}
                  onClick={() => go(`addon:${addon.id}/${entry.id}` as ViewId)}
                />
              ))}
            </NavGroup>
          );
        })}
      </CollapseSection>
    </div>
  );
});