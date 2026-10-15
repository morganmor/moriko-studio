/**
 * NotificationHost (Addon v2, A5) — center-top viewport toasts for addon
 * notifications (`ui.toast` / achievement frames on the SSE bus).
 *
 * NOT the NoticeCenter stack at the bottom-right bell: addon achievements are
 * momentary, celebratory, and must be seen — hence center-top, portaled to
 * document.body (escapes the zoomed #root transform, 1:1 viewport pixels),
 * with its own queue, its own timing, and reduced-motion respect.
 *
 * Frames arrive as SSE topic `addon.notify` with payload.notification:
 * { kind: 'info'|'warn'|'error'|'achievement', title, subtitle?, icon?,
 *   openView?, ttlMs? }. Clicking a toast with openView navigates there.
 */

import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { isMotionReduced } from '../lib/appearance';
import { useStore } from '../store/useStore';
import { onAddonBusFrame } from '../addons/host';
import type { AddonBusPayload } from '../types/addonBus';

interface QueuedNotification {
  uid: number;
  addonId: string;
  kind: 'info' | 'warn' | 'error' | 'achievement';
  title: string;
  subtitle?: string;
  icon?: string;
  openView?: string;
  ttlMs: number;
}

let uid = 0;
const MAX_VISIBLE = 3;

function notificationFromFrame(frame: AddonBusPayload): QueuedNotification | null {
  if (frame.topic !== 'addon.notify') return null;
  const payload = frame.payload as { notification?: Record<string, unknown> } | undefined;
  const n = payload?.notification;
  if (!n || typeof n.title !== 'string' || n.title.trim() === '') return null;
  const kind = n.kind === 'warn' || n.kind === 'error' || n.kind === 'achievement' ? n.kind : 'info';
  return {
    uid: ++uid,
    addonId: frame.addonId,
    kind,
    title: n.title,
    subtitle: typeof n.subtitle === 'string' ? n.subtitle : undefined,
    icon: typeof n.icon === 'string' ? n.icon : undefined,
    openView: typeof n.openView === 'string' ? n.openView : undefined,
    ttlMs: typeof n.ttlMs === 'number' && Number.isFinite(n.ttlMs) ? Math.max(1500, Math.min(15000, n.ttlMs)) : kind === 'achievement' ? 6500 : 5000,
  };
}

export const AddonNotificationHost = memo(function AddonNotificationHost() {
  const [queue, setQueue] = useState<QueuedNotification[]>([]);
  const setView = useStore((state) => state.setView);

  useEffect(() => {
    return onAddonBusFrame((frame) => {
      const notification = notificationFromFrame(frame);
      if (!notification) return;
      setQueue((current) => [...current.slice(-(MAX_VISIBLE - 1)), notification]);
      const ttl = isMotionReduced(null) ? Math.max(notification.ttlMs, 8000) : notification.ttlMs;
      window.setTimeout(() => {
        setQueue((current) => current.filter((entry) => entry.uid !== notification.uid));
      }, ttl);
    });
  }, []);

  if (queue.length === 0) return null;

  return createPortal(
    <div className="addon-notify-stack" role="status" aria-live="polite">
      {queue.map((entry) => (
        <button
          key={entry.uid}
          type="button"
          className={`addon-notify addon-notify-${entry.kind}`}
          onClick={() => {
            if (entry.openView) setView(entry.openView as never);
            setQueue((current) => current.filter((item) => item.uid !== entry.uid));
          }}
        >
          <span className="addon-notify-icon" aria-hidden="true">{entry.icon ?? (entry.kind === 'achievement' ? '★' : '●')}</span>
          <span className="addon-notify-body">
            <span className="addon-notify-title">{entry.title}</span>
            {entry.subtitle ? <span className="addon-notify-sub">{entry.subtitle}</span> : null}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
});
