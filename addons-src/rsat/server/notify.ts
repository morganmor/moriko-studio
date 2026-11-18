

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
