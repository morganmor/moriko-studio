/**
 * RSA/T notifications (R6) — achievement toasts ride the platform's
 * addon.notify channel (center-top NotificationHost renders them with the
 * achievement styling and opens the board on click).
 */

export function toastAchievement(api, event) {
  try {
    api.ui.notify({
      kind: 'achievement',
      title: `${event.target} complete!`,
      subtitle: `${event.title ?? ''} · +${event.points ?? '?'} pts`.trim(),
      icon: event.tier ?? 'bronze',
      openView: 'addon:rsat/board',
      ttlMs: 6500,
    });
  } catch {  }
}
