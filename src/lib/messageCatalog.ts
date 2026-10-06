/**
 * MESSAGE CATALOG — the single source of truth for every harness/user-facing
 * message the app can emit (Fase A #4.2).
 *
 * THE RULE: a feature that wants to show a message MUST register it here
 * first. This is enforced mechanically, not by convention:
 *   - `showNotice(id, ...)` in the store only accepts `MessageId` — a raw
 *     string literal is a TYPE ERROR (see useStore.ts).
 *   - The Notice Center (TopBar) renders only catalog entries: tone, ttl and
 *     dedupe behavior come from the spec, never from the call site.
 *
 * Surfaces:
 *   - 'notice'      → the Notice Center stack under the session title
 *                     (opaque card, auto-expire, dedupe, history trail).
 *   - 'thread-card' → a persistent card inside the thread (finish notes);
 *                     the TEXT lives here so the catalog stays complete,
 *                     rendering stays in Thread.tsx.
 *
 * Interpolation: `{param}` placeholders in `text` are filled by the call site
 * via `params` (see formatMessage). Unknown placeholders render verbatim, so a
 * missing param is visible rather than silently blank.
 */

export type MessageTone = 'info' | 'success' | 'error' | 'warn' | 'danger';

export type MessageSurface = 'notice' | 'thread-card';

export interface MessageSpec {
  /** Message template with optional {param} placeholders. */
  text: string;
  tone: MessageTone;
  surface: MessageSurface;
  /** ms before the notice auto-dismisses. Default: 7000 for error/danger,
   *  4200 for everything else (the old Toast/HarnessPop lifetimes). */
  ttl?: number;
  /** Collapsing behavior while the notice is on screen. Default true —
   *  a second emission of the same id does not stack. Set false when the
   *  params differ per emission and each must be seen (retry ladder). */
  dedupe?: boolean;
}

export const MESSAGE_CATALOG = {
  'share.nothing': { text: 'There is nothing to share yet.', tone: 'info', surface: 'notice' },
  'share.copied': { text: 'Link copied to clipboard.', tone: 'success', surface: 'notice' },
  'share.clipboardFailed': { text: 'Could not access the clipboard.', tone: 'error', surface: 'notice' },
  'workspace.bound': { text: 'Agent workspace: {label}.', tone: 'success', surface: 'notice' },
  'workspace.pickFailed': { text: 'Native picker failed.', tone: 'error', surface: 'notice' },
  'workspace.removed': { text: 'Workspace unregistered — files on disk are untouched.', tone: 'info', surface: 'notice' },
  'workspace.removeFailed': { text: 'Could not unregister the workspace.', tone: 'error', surface: 'notice' },

  'tree.refreshFailed': { text: 'Could not refresh the project tree.', tone: 'error', surface: 'notice' },
  'tree.rulesSaved': {
    text: 'Ignore rules saved — rebuilding the tree index.',
    tone: 'success',
    surface: 'notice',
  },
  'tree.rulesSaveFailed': { text: 'Could not save the ignore rules.', tone: 'error', surface: 'notice' },

  'run.steeredAsNew': {
    text: 'The run just finished — sending it as a new message instead.',
    tone: 'info',
    surface: 'notice',
  },
  'run.reminderQueued': {
    text: 'System-rules reminder queued — the model receives it at the next round boundary.',
    tone: 'success',
    surface: 'notice',
  },
  'run.steerFailed': {
    text: 'Could not queue the reminder: {detail}. If the detail mentions an unknown preset, restart the harness server — it is still running the pre-preset code.',
    tone: 'error',
    surface: 'notice',
  },
  'attachments.tooMany': { text: 'At most {max} attachments per message.', tone: 'error', surface: 'notice' },
  'attachments.imageNotSupported': {
    text: '{model} may not accept image input (models.dev).',
    tone: 'info',
    surface: 'notice',
  },
  'attachments.tooLarge': {
    text: '{name} is larger than 10 MB and was skipped.',
    tone: 'error',
    surface: 'notice',
  },
  'attachments.readFailed': { text: 'Could not read {name}.', tone: 'error', surface: 'notice' },

  'appearance.textSizeSet': { text: 'Text size set to {label}.', tone: 'success', surface: 'notice' },

  'goal.updateFailed': { text: 'Could not update the goal.', tone: 'error', surface: 'notice' },
  'goal.deleted': { text: 'Goal deleted.', tone: 'success', surface: 'notice' },
  'goal.reminderCancelFailed': { text: 'Could not cancel the reminder.', tone: 'error', surface: 'notice' },

  'conversations.cleared': { text: 'All conversations cleared.', tone: 'success', surface: 'notice' },

  'storage.saved': { text: 'Storage location saved — press Reload harness to apply.', tone: 'success', surface: 'notice' },

  'image.notAnImage': { text: '{name} is not an image.', tone: 'error', surface: 'notice' },
  'image.tooLarge': { text: '{name} is larger than 3 MB and was skipped.', tone: 'error', surface: 'notice' },
  'image.readFailed': { text: '{name} could not be read.', tone: 'error', surface: 'notice' },
  'image.tooManyRefs': {
    text: '{model} accepts at most {max} reference image(s).',
    tone: 'error',
    surface: 'notice',
  },
  'image.extraRefsSkipped': {
    text: 'Only {room} more reference image(s) allowed — extra skipped.',
    tone: 'error',
    surface: 'notice',
  },
  'image.trayFull': {
    text: 'The tray holds {max} image(s) — remove one to add another.',
    tone: 'error',
    surface: 'notice',
  },
  'image.refAttached': {
    text: 'Attached as a reference — write the edit instruction below.',
    tone: 'success',
    surface: 'notice',
  },
  'image.refFetchFailed': { text: 'That image could not be read.', tone: 'error', surface: 'notice' },
  'image.editApplied': { text: 'Image updated — added to the reference tray.', tone: 'success', surface: 'notice' },
  'image.editEncodeFailed': {
    text: 'Could not encode the edited image — try a smaller crop.',
    tone: 'error',
    surface: 'notice',
  },
  'image.cleanupDone': { text: 'Cleaned {removed} image(s).', tone: 'success', surface: 'notice' },
  'image.cleanupDoneKept': {
    text: 'Cleaned {removed} image(s); {kept} kept (in Gallery).',
    tone: 'success',
    surface: 'notice',
  },
  'image.cleanupFailed': { text: 'Cleanup failed.', tone: 'error', surface: 'notice' },

  'provider.saved': { text: '{label} saved.', tone: 'success', surface: 'notice' },
  'provider.updated': { text: '{message}', tone: 'success', surface: 'notice' },
  'provider.saveFailed': { text: 'Could not save the provider.', tone: 'error', surface: 'notice' },
  'provider.updateFailed': { text: 'Could not update the provider.', tone: 'error', surface: 'notice' },
  'provider.keySavedFor': { text: 'Key saved for {label}.', tone: 'success', surface: 'notice' },
  'provider.keyRemovedFor': { text: 'Stored key removed from {label}.', tone: 'success', surface: 'notice' },
  'provider.keyStored': { text: 'Key saved on this device.', tone: 'success', surface: 'notice' },
  'provider.keySaved': { text: 'Key saved on this device.', tone: 'success', surface: 'notice' },
  'provider.keyRemoved': { text: 'Key removed.', tone: 'success', surface: 'notice' },
  'provider.keyRemoveFailed': { text: 'Could not remove the stored key.', tone: 'error', surface: 'notice' },
  'provider.modelsAddedTo': {
    text: '{count} model id(s) added to {label}.',
    tone: 'success',
    surface: 'notice',
  },
  'provider.modelsAdded': { text: 'Model ids added.', tone: 'success', surface: 'notice' },
  'provider.fetchNone': { text: 'The provider returned no chat models.', tone: 'error', surface: 'notice' },
  'provider.fetchAllKnown': {
    text: 'All {count} live models are already in the catalogue.',
    tone: 'info',
    surface: 'notice',
  },
  'provider.fetchFailed': { text: 'Could not fetch models.', tone: 'error', surface: 'notice' },
  'provider.fetchEmpty': { text: 'The provider returned an empty model list.', tone: 'info', surface: 'notice' },
  'provider.fetchAllAdded': {
    text: 'All {count} fetched models are already added.',
    tone: 'info',
    surface: 'notice',
  },
  'provider.labelUrlRequired': { text: 'A label and a base URL are required.', tone: 'error', surface: 'notice' },
  'provider.imageConfigObject': {
    text: 'Image configuration must be a JSON object.',
    tone: 'error',
    surface: 'notice',
  },
  'provider.imageConfigJson': { text: 'Image configuration is not valid JSON.', tone: 'error', surface: 'notice' },
  'provider.imageConfigRequired': {
    text: 'The declarative adapter needs an image configuration JSON.',
    tone: 'error',
    surface: 'notice',
  },
  'provider.deleted': { text: 'Provider deleted.', tone: 'success', surface: 'notice' },
  'provider.deleteFailed': { text: 'Could not delete the provider.', tone: 'error', surface: 'notice' },
  'provider.saveFirst': { text: 'Save the provider first, then fetch its models.', tone: 'info', surface: 'notice' },
  'provider.discoveryFailed': { text: 'Model discovery failed.', tone: 'error', surface: 'notice' },
  'provider.modelsAddedUnsaved': {
    text: '{count} model id(s) added — save the provider to keep them.',
    tone: 'success',
    surface: 'notice',
  },
  'provider.nowUsing': { text: 'Now using {label}.', tone: 'success', surface: 'notice' },
  'provider.modelSetTo': { text: 'Model set to {model}.', tone: 'success', surface: 'notice' },

  'settings.reset': { text: 'Settings reset to defaults.', tone: 'success', surface: 'notice' },
  'settings.presetApplied': { text: 'Applied "{label}".', tone: 'success', surface: 'notice' },
  'settings.modelSelected': { text: '{model} selected.', tone: 'success', surface: 'notice' },
  'settings.modelSelectedImage': { text: '{model} selected for Image Studio.', tone: 'success', surface: 'notice' },
  'settings.promptEmpty': { text: 'Write a system prompt first, then save it.', tone: 'info', surface: 'notice' },
  'settings.promptSaved': { text: 'Prompt saved as "{name}".', tone: 'success', surface: 'notice' },
  'settings.promptApplied': { text: 'Applied "{name}".', tone: 'success', surface: 'notice' },
  'settings.keySaveFailed': { text: 'Could not save the key.', tone: 'error', surface: 'notice' },
  'settings.visionSaved': { text: 'Vision configuration saved.', tone: 'success', surface: 'notice' },
  'settings.visionCleared': { text: 'Vision configuration cleared.', tone: 'info', surface: 'notice' },
  'settings.visionSaveFailed': { text: 'Failed to save vision configuration.', tone: 'error', surface: 'notice' },
  'settings.retentionSaveFailed': { text: 'Could not save the retention setting.', tone: 'error', surface: 'notice' },

  'export.conversationDone': {
    text: 'Conversation exported — import the file on any Moriko instance.',
    tone: 'success',
    surface: 'notice',
  },
  'export.done': { text: 'Exported {count} conversation(s).', tone: 'success', surface: 'notice' },
  'export.notBundle': { text: 'That file is not a Moriko export bundle.', tone: 'error', surface: 'notice' },
  'export.notConversation': {
    text: 'That file is not a Moriko conversation export.',
    tone: 'error',
    surface: 'notice',
  },
  'export.noConversation': {
    text: 'The file contains no importable conversation.',
    tone: 'error',
    surface: 'notice',
  },
  'export.imported': { text: 'Imported "{title}".', tone: 'success', surface: 'notice' },
  'export.importDone': { text: 'Imported {count} conversation(s).', tone: 'success', surface: 'notice' },
  'export.importFailed': { text: 'Import failed.', tone: 'error', surface: 'notice' },
  'export.keysMoved': {
    text: 'Moved {count} provider key(s) into the device vault.',
    tone: 'success',
    surface: 'notice',
  },
  'export.keysFailed': {
    text: '{count} key(s) could not be saved — check the provider list.',
    tone: 'error',
    surface: 'notice',
  },

  'send.noProvider': { text: 'Pick a provider in Configuration first.', tone: 'error', surface: 'notice' },
  'send.noModel': { text: 'Pick a model in Configuration first.', tone: 'error', surface: 'notice' },
  'send.noProviderModel': { text: 'Pick a provider and model first.', tone: 'error', surface: 'notice' },
  'send.conversationGone': { text: 'That conversation no longer exists.', tone: 'error', surface: 'notice' },
  'send.loadFailed': {
    text: 'Could not load this conversation from the device — not sending.',
    tone: 'error',
    surface: 'notice',
  },
  'send.alreadyGenerating': {
    text: 'This conversation is already generating — stop it first.',
    tone: 'info',
    surface: 'notice',
  },
  'continue.needsUserTurn': {
    text: 'Continue works right after your own message.',
    tone: 'info',
    surface: 'notice',
  },

  'device.unreachableSave': {
    text: 'Device store unreachable — preferences changed now will not be saved.',
    tone: 'error',
    surface: 'notice',
  },
  'device.unreachableCache': {
    text: 'Device unreachable — this browser still holds its old chat cache.',
    tone: 'error',
    surface: 'notice',
  },
  'device.unreachableLoad': {
    text: 'Device unreachable — conversations cannot be loaded from this browser.',
    tone: 'error',
    surface: 'notice',
  },

  'gallery.savedOne': { text: 'Saved to Gallery.', tone: 'success', surface: 'notice' },
  'gallery.savedMany': { text: '{count} images saved to Gallery.', tone: 'success', surface: 'notice' },
  'gallery.saveFailed': { text: 'Could not save to Gallery — is the proxy running?', tone: 'error', surface: 'notice' },
  'gallery.updateFailed': {
    text: 'Could not update the Gallery — is the proxy running?',
    tone: 'error',
    surface: 'notice',
  },
  'gallery.reorderFailed': {
    text: 'Could not reorder the Gallery — is the proxy running?',
    tone: 'error',
    surface: 'notice',
  },
  'imageSession.deleted': { text: 'Session deleted.', tone: 'success', surface: 'notice' },
  'imageSession.deleteFailed': { text: 'Could not delete the session.', tone: 'error', surface: 'notice' },
  'imageSession.renameFailed': {
    text: 'Could not rename the session. {detail}',
    tone: 'error',
    surface: 'notice',
  },
  'imageSession.recordFailed': {
    text: 'Could not record the image into the session.',
    tone: 'error',
    surface: 'notice',
  },
  'image.savedToSession': { text: 'Image saved to the session.', tone: 'success', surface: 'notice' },

  'permission.decideFailed': { text: 'Could not deliver the decision.', tone: 'error', surface: 'notice' },
  'ask.deliverFailed': { text: 'Could not deliver the answers.', tone: 'error', surface: 'notice' },


  'compact.alreadyCompacted': {
    text: 'Already compacted during this run — the context is still over the limit.',
    tone: 'warn',
    surface: 'notice',
  },
  'compact.nothing': { text: 'Nothing to compact yet — keep chatting first.', tone: 'info', surface: 'notice' },
  'compact.prePassed': {
    text: 'Context pressure relieved by model-free pruning (tighter tool digests, images offloaded) — no summary needed.',
    tone: 'info',
    surface: 'notice',
  },
  'compact.summarizerFallback': {
    text: 'The Summarizer Model failed — the session model produced the checkpoint instead.',
    tone: 'warn',
    surface: 'notice',
    ttl: 7000,
  },
  'diff.restoreDone': {
    text: 'Restored {file} — {label}.',
    tone: 'success',
    surface: 'notice',
  },
  'diff.restoreFailed': {
    text: 'Restore failed: {message}',
    tone: 'error',
    surface: 'notice',
    ttl: 7000,
  },
  'diff.removeDone': {
    text: 'Removed {file} (created by the agent) — undoable from the restore marker.',
    tone: 'success',
    surface: 'notice',
  },
  'compact.scheduledManual': {
    text: 'Compacting at the end of this round — the run continues right after.',
    tone: 'info',
    surface: 'notice',
  },
  'compact.scheduledAuto': {
    text: 'Context limit reached mid-run — compacting at the end of this round.',
    tone: 'info',
    surface: 'notice',
  },
  'compact.continueHint': {
    text: 'The run is still winding down — press Continue to resume on the compacted context.',
    tone: 'info',
    surface: 'notice',
  },
  'compact.skippedBusy': {
    text: 'Skipped auto-compact — a compaction is already running.',
    tone: 'info',
    surface: 'notice',
  },
  'compact.busy': { text: 'A compaction is already running — one at a time.', tone: 'info', surface: 'notice' },
  'compact.autoDone': {
    text: 'Auto-compacted {turns} turns (~{tokens}k tokens condensed).',
    tone: 'info',
    surface: 'notice',
  },
  'compact.autoFailed': {
    text: 'Auto-compaction failed: {message} — the conversation is still near its context limit. Try /compact manually or lower the context limit.',
    tone: 'warn',
    surface: 'notice',
    ttl: 7000,
  },
  'compact.failed': {
    text: 'Compaction failed — continuing without a summary.',
    tone: 'warn',
    surface: 'notice',
  },
  'compact.manualDone': {
    text: 'Compacted {turns} turns into a summary.',
    tone: 'info',
    surface: 'notice',
  },
  'compact.failedReason': {
    text: 'Compaction failed: {message}',
    tone: 'warn',
    surface: 'notice',
    ttl: 7000,
  },

  'enforcement.armedMidRun': {
    text: 'Enforcement armed — it takes full effect on your next message.',
    tone: 'warn',
    surface: 'notice',
  },
  'enforcement.updatedMidRun': {
    text: 'Enforcement level updated — it applies on your next message.',
    tone: 'info',
    surface: 'notice',
  },

  'probation.classifierSuggested': {
    text: 'Classifier flagged ({evidence}) — suggests Tier {tier}. Raise Probation if you agree.',
    tone: 'warn',
    surface: 'notice',
    ttl: 6000,
  },
  'probation.reset': { text: 'Probation reset — Tier 1, nothing on record.', tone: 'info', surface: 'notice' },
  'probation.tier4Frozen': {
    text: "Probation Tier 4 — the model's output is frozen until it apologizes.",
    tone: 'danger',
    surface: 'notice',
    ttl: 6000,
  },
  'probation.setManual': {
    text: 'Probation set to Tier {tier} by hand.',
    tone: 'info',
    surface: 'notice',
    ttl: 6000,
  },
  'probation.apologized': { text: 'The model apologized — the freeze is lifted.', tone: 'info', surface: 'notice' },
  'probation.continueBurning': {
    text: 'The model chose to continue — output stays suppressed and the tokens burn ({count}).',
    tone: 'warn',
    surface: 'notice',
  },
  'probation.evadeStopped': {
    text: 'The model evaded its choice five times — the harness stops re-asking. The freeze stands until you lower Probation.',
    tone: 'warn',
    surface: 'notice',
    ttl: 6000,
  },
  'probation.evadeReminder': {
    text: 'The model ignored its choice ({count}/5) — re-running with a reminder.',
    tone: 'warn',
    surface: 'notice',
  },

  'connection.lost': {
    text: 'Connection lost — waiting for the server, then continuing automatically…',
    tone: 'warn',
    surface: 'notice',
  },
  'connection.restored': { text: 'Server is back — continuing…', tone: 'info', surface: 'notice' },
  'enforcement.armed': {
    text: 'Enforcement armed — it takes full effect on your next message.',
    tone: 'info',
    surface: 'notice',
    ttl: 6000,
  },
  'run.resumeInterrupted': {
    text: 'Interrupted agent run — resuming automatically…',
    tone: 'info',
    surface: 'notice',
  },
  'run.resumeGone': {
    text: 'The interrupted generation is no longer live on the server — press Continue to resume.',
    tone: 'info',
    surface: 'notice',
  },
  'run.resumeCrashed': {
    text: 'Crashed agent run — resuming with replayed tool results…',
    tone: 'info',
    surface: 'notice',
  },
  'provider.retryLadder': {
    text: 'Provider error — retry {attempt}/{total} in {seconds}s (previous work is preserved).',
    tone: 'info',
    surface: 'notice',
    dedupe: false,
  },
  'provider.retryGaveUp': {
    text: 'The provider rejected this request twice — stopping retries. Try compacting the conversation or starting a new chat.',
    tone: 'warn',
    surface: 'notice',
    ttl: 7000,
  },

  'finish.contextBudget': {
    text: 'Run stopped by the harness: the context budget for this run ran out — the model was asked to close with a summary.',
    tone: 'warn',
    surface: 'thread-card',
  },
  'finish.stalled': {
    text: 'Run stopped by the harness: the same tool calls repeated without forward progress.',
    tone: 'warn',
    surface: 'thread-card',
  },
  'finish.toolErrors': {
    text: 'The run ended after one or more tools failed (see the red tool cards above). The tool output is kept in context — Continue to retry from here.',
    tone: 'error',
    surface: 'thread-card',
  },
  'finish.length': {
    text: 'Output was cut by the provider (max output tokens reached).',
    tone: 'error',
    surface: 'thread-card',
  },
  'finish.userStop': {
    text: 'You stopped this generation. The task is considered ended — the next message starts fresh.',
    tone: 'info',
    surface: 'thread-card',
  },
} as const satisfies Record<string, MessageSpec>;

export type MessageId = keyof typeof MESSAGE_CATALOG;

/** Default lifetime per tone — matches the old Toast (error 7s) and
 *  HarnessPop (4.2s) behavior so the migration changes nothing users felt. */
export function messageTtl(spec: MessageSpec): number {
  if (spec.ttl !== undefined) return spec.ttl;
  return spec.tone === 'error' || spec.tone === 'danger' ? 7000 : 4200;
}

/** Fill `{param}` placeholders. Unknown placeholders render verbatim — a
 *  missing param is VISIBLE (debuggable), never a silent blank. */
export function formatMessage(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export interface NoticeEntry {
  /** Rendering key — unique per emission (React list key + dismiss target). */
  key: string;
  /** The catalog id this notice was born from. */
  id: MessageId;
  /** Fully formatted message text. */
  text: string;
  /** Optional secondary line (usually the underlying error message). */
  detail?: string;
  tone: MessageTone;
  /** ms the card holds before auto-dismiss. */
  ttl: number;
  /** Active-queue dedupe key (`id` unless the spec opted out). */
  dedupeKey: string;
  createdAt: number;
}

let noticeSeq = 0;

/** Build a render-ready notice from a catalog id. Returns undefined when the
 *  id is unknown — callers treat that as a programming error (console, no UI). */
export function makeNotice(
  id: MessageId,
  params?: Record<string, string | number>,
  opts?: { detail?: string; tone?: MessageTone },
): NoticeEntry | undefined {
  const spec = MESSAGE_CATALOG[id] as MessageSpec | undefined;
  if (!spec) {
    if (typeof console !== 'undefined') {
      console.error(`[messageCatalog] unregistered message id: ${String(id)}`);
    }
    return undefined;
  }
  noticeSeq += 1;
  return {
    key: `notice-${Date.now().toString(36)}-${noticeSeq}`,
    id,
    text: formatMessage(spec.text, params),
    detail: opts?.detail,
    tone: opts?.tone ?? spec.tone,
    ttl: messageTtl(spec),
    dedupeKey: spec.dedupe === false ? `${id}:${noticeSeq}` : id,
    createdAt: Date.now(),
  };
}

/** Compute the active queue + history trail from raw emissions and the
 *  previous state — the store calls this on every showNotice. */
export function reduceNotices(
  prev: { notices: NoticeEntry[]; history: NoticeEntry[] },
  entry: NoticeEntry,
): { notices: NoticeEntry[]; history: NoticeEntry[] } {
  const now = Date.now();
  const live = prev.notices.filter((notice) => now - notice.createdAt < notice.ttl);
  const deduped = live.filter((notice) => notice.dedupeKey !== entry.dedupeKey);
  return {
    notices: [...deduped, entry].slice(-4),
    history: [...prev.history, entry].slice(-30),
  };
}