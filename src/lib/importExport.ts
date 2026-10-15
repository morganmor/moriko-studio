import type {
  ChatSettings,
  Conversation,
  ConversationCompaction,
  Goal,
  GoalSubtask,
  Turn,
  TurnAttachment,
  TurnInjection,
  TurnSegment,
  TrustTier,
} from '../types';
import { DEFAULT_SETTINGS } from '../store/useStore';

/**
 * Validation for imported bundles.
 *
 * An export file is untrusted input: it may have been hand-edited, produced by
 * an older build, or crafted. Everything is coerced into the current shape, and
 * anything unparseable is dropped rather than trusted.
 */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSettings(value: unknown): ChatSettings {
  const raw = (value ?? {}) as Partial<ChatSettings>;
  const thinking = raw.thinkingLevel;
  return {
    systemInstruction: asString(raw.systemInstruction),
    thinkingLevel:
      thinking === 'off' ||
      thinking === 'minimal' ||
      thinking === 'low' ||
      thinking === 'medium' ||
      thinking === 'high' ||
      thinking === 'xhigh' ||
      thinking === 'max'
        ? thinking
        : DEFAULT_SETTINGS.thinkingLevel,
    temperature: clamp(asNumber(raw.temperature, DEFAULT_SETTINGS.temperature), 0, 2),
    maxOutputTokens:
      raw.maxOutputTokens === null
        ? null
        : raw.maxOutputTokens === undefined
          ? (DEFAULT_SETTINGS.maxOutputTokens as number)
          : clamp(asNumber(raw.maxOutputTokens, DEFAULT_SETTINGS.maxOutputTokens as number), 1, 200000),
    topP: clamp(asNumber(raw.topP, DEFAULT_SETTINGS.topP), 0, 1),
    structuredOutputs: asBoolean(raw.structuredOutputs),
    useMcp: raw.useMcp === true ||
      (raw as { functionCalling?: unknown }).functionCalling === true,
    agentMode: raw.agentMode === true,
    agentWorkflow: typeof raw.agentWorkflow === 'string' ? raw.agentWorkflow : '',
    terminalMode:
      raw.terminalMode === 'off' || raw.terminalMode === 'ask' ? raw.terminalMode : 'auto',
    confirmDeletes: raw.confirmDeletes === true,
    fetchWeb: raw.fetchWeb === true ||
      typeof (raw as { urlContext?: unknown }).urlContext === 'string',
    webAccess: raw.webAccess === true,
    maxContextTokens:
      raw.maxContextTokens === null || raw.maxContextTokens === undefined
        ? null
        : clamp(Math.round(asNumber(raw.maxContextTokens, 0)), 1024, 10_000_000) || null,
    autoCompact: asBoolean(raw.autoCompact, true),
    compactThresholdTokens:
      raw.compactThresholdTokens === null || raw.compactThresholdTokens === undefined
        ? null
        : clamp(Math.round(asNumber(raw.compactThresholdTokens, 0)), 1024, 10_000_000) || null,
    compactThresholdRatio: clamp(
      asNumber(raw.compactThresholdRatio, DEFAULT_SETTINGS.compactThresholdRatio),
      0.5,
      0.98,
    ),
    summarizerEnabled: asBoolean(raw.summarizerEnabled, DEFAULT_SETTINGS.summarizerEnabled),
    summarizerProviderId:
      typeof raw.summarizerProviderId === 'string' && raw.summarizerProviderId.trim()
        ? raw.summarizerProviderId.trim()
        : null,
    summarizerModel:
      typeof raw.summarizerModel === 'string' && raw.summarizerModel.trim()
        ? raw.summarizerModel.trim()
        : null,
    imageOffload: asBoolean(raw.imageOffload, DEFAULT_SETTINGS.imageOffload),
    enforcement: {
      level:
        typeof raw.enforcement?.level === 'number' && raw.enforcement.level >= 0 && raw.enforcement.level <= 5
          ? (raw.enforcement.level as 0 | 1 | 2 | 3 | 4 | 5)
          : raw.lockdown?.active === true
            ? 4
            : 0,
      mode: raw.enforcement?.mode === 'auto' ? 'auto' : 'manual',
      message: typeof raw.enforcement?.message === 'string'
        ? raw.enforcement.message
        : typeof raw.lockdown?.message === 'string'
          ? raw.lockdown.message
          : '',
    },
    probation: {
      enabled: raw.probation?.enabled === true,
    },
  };
}

function sanitizeAttachments(value: unknown): TurnAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TurnAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<TurnAttachment>;
    if (!asString(raw.name) || !asString(raw.mime)) continue;
    const dataRef =
      raw.dataRef && typeof raw.dataRef === 'object' && typeof (raw.dataRef as { hash?: unknown }).hash === 'string'
        ? {
            hash: (raw.dataRef as { hash: string }).hash,
            mime: asString((raw.dataRef as { mime?: unknown }).mime, raw.mime),
            byteSize: Math.max(0, Math.round(asNumber((raw.dataRef as { byteSize?: unknown }).byteSize, 0))),
          }
        : undefined;
    out.push({
      id: asString(raw.id) || `imported_att_${out.length}`,
      name: asString(raw.name),
      mime: asString(raw.mime),
      size: Math.max(0, Math.round(asNumber(raw.size, 0))),
      dataUrl: asString(raw.dataUrl) || undefined,
      ...(dataRef ? { dataRef } : {}),
      ...(raw.width !== undefined ? { width: Math.max(0, Math.round(asNumber(raw.width, 0))) } : {}),
      ...(raw.height !== undefined ? { height: Math.max(0, Math.round(asNumber(raw.height, 0))) } : {}),
      ...(typeof raw.path === 'string' && raw.path ? { path: raw.path } : {}),
      textContent: asString(raw.textContent) || undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeSegments(value: unknown): TurnSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TurnSegment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<TurnSegment>;
    if (raw.type === 'text' || raw.type === 'reasoning') {
      const text = asString((raw as { text?: unknown }).text);
      if (text) out.push({ type: raw.type, text });
    } else if (raw.type === 'steer') {
      const steer = raw as Partial<Extract<TurnSegment, { type: 'steer' }>>;
      const text = asString(steer.text);
      if (text) {
        out.push({ type: 'steer', id: asString(steer.id) || `imported_steer_${out.length}`, text });
      }
    } else if (raw.type === 'tool') {
      const tool = raw as Partial<Extract<TurnSegment, { type: 'tool' }>>;
      const toolImages = Array.isArray(tool.toolImages)
        ? (tool.toolImages as Array<{ mime?: unknown; dataUrl?: unknown; dataRef?: unknown }>).flatMap(
            (image): Array<{ mime: string; dataUrl?: string; dataRef?: { hash: string; mime: string; byteSize: number } }> => {
              if (!image || typeof image.mime !== 'string') return [];
              if (
                image.dataRef &&
                typeof image.dataRef === 'object' &&
                typeof (image.dataRef as { hash?: unknown }).hash === 'string'
              ) {
                const ref = image.dataRef as { hash: string; mime?: unknown; byteSize?: unknown };
                return [
                  {
                    mime: image.mime,
                    dataRef: {
                      hash: ref.hash,
                      mime: typeof ref.mime === 'string' ? ref.mime : image.mime,
                      byteSize: Math.max(0, Math.round(typeof ref.byteSize === 'number' ? ref.byteSize : 0)),
                    },
                  },
                ];
              }
              return typeof image.dataUrl === 'string' && image.dataUrl ? [{ mime: image.mime, dataUrl: image.dataUrl }] : [];
            },
          )
        : undefined;
      const visual =
        tool.visual && typeof tool.visual === 'object'
          ? (tool.visual as {
              id?: unknown;
              html?: unknown;
              htmlRef?: unknown;
              title?: unknown;
              height?: unknown;
              replaces?: unknown;
              variants?: unknown;
            })
          : undefined;
      const visualValid =
        visual &&
        typeof visual.id === 'string' &&
        (typeof visual.html === 'string' || (visual.htmlRef !== null && typeof visual.htmlRef === 'object' && typeof (visual.htmlRef as { hash?: unknown }).hash === 'string'));
      out.push({
        type: 'tool',
        serverName: asString(tool.serverName, '?'),
        toolName: asString(tool.toolName, '?'),
        args: typeof tool.args === 'string' ? tool.args : undefined,
        summary: typeof tool.summary === 'string' ? tool.summary : undefined,
        ok: typeof tool.ok === 'boolean' ? tool.ok : undefined,
        diff: typeof tool.diff === 'string' ? tool.diff : undefined,
        diffstat:
          tool.diffstat && typeof tool.diffstat === 'object'
            ? {
                added: Math.max(0, Math.round(asNumber((tool.diffstat as Record<string, unknown>).added, 0))),
                removed: Math.max(0, Math.round(asNumber((tool.diffstat as Record<string, unknown>).removed, 0))),
              }
            : undefined,
        ...(toolImages && toolImages.length > 0 ? { toolImages } : {}),
        ...(visualValid && visual
          ? {
              visual: {
                id: visual.id as string,
                title: asString(visual.title),
                height: Math.max(0, Math.round(asNumber(visual.height, 360))),
                ...(typeof visual.html === 'string' && visual.html
                  ? { html: visual.html }
                  : visual.htmlRef && typeof (visual.htmlRef as { hash?: unknown }).hash === 'string'
                    ? { htmlRef: visual.htmlRef as { hash: string; byteSize: number } }
                    : {}),
                ...(visual.replaces === true ? { replaces: true as const } : {}),
                ...(Array.isArray(visual.variants)
                  ? {
                      variants: (visual.variants as Array<Record<string, unknown>>)
                        .filter((candidate) => typeof candidate.id === 'string')
                        .map((candidate) => ({
                          id: candidate.id as string,
                          title: asString(candidate.title),
                          height: Math.max(0, Math.round(asNumber(candidate.height, 360))),
                          ...(typeof candidate.html === 'string' && candidate.html
                            ? { html: candidate.html }
                            : candidate.htmlRef && typeof (candidate.htmlRef as { hash?: unknown }).hash === 'string'
                              ? { htmlRef: candidate.htmlRef as { hash: string; byteSize: number } }
                              : {}),
                        })),
                    }
                  : {}),
              },
            }
          : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Mid-run steer notes recorded on a turn (the wire-rebuild source). */
function sanitizeSteers(value: unknown): Turn['steers'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<Turn['steers']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<{ id: string; text: string }>;
    const text = asString(raw.text);
    if (!text.trim()) continue;
    out.push({ id: asString(raw.id) || `imported_steer_${out.length}`, text });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeInjections(value: unknown): TurnInjection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TurnInjection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<TurnInjection>;
    if (!asString(raw.id) && !asString(raw.content)) continue;
    out.push({
      id: asString(raw.id) || `imported_injection_${out.length}`,
      title: asString(raw.title, 'System prompt · Harness'),
      content: asString(raw.content),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeUsage(value: unknown): Turn['usage'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as NonNullable<Turn['usage']>;
  return {
    promptTokens: asNumber(raw.promptTokens, 0) || undefined,
    completionTokens: asNumber(raw.completionTokens, 0) || undefined,
    totalTokens: asNumber(raw.totalTokens, 0) || undefined,
    cacheReadTokens: asNumber(raw.cacheReadTokens, 0) || undefined,
  };
}

function sanitizeTurn(value: unknown, index: number): Turn | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Turn>;

  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  const content = asString(raw.content);
  const segments = sanitizeSegments(raw.segments);
  const attachments = sanitizeAttachments(raw.attachments);
  const steers = sanitizeSteers(raw.steers);
  if (!content && !raw.error && !segments && !attachments && !steers) return null;

  const kind =
    raw.kind === 'compaction' ||
    raw.kind === 'goal-loop' ||
    raw.kind === 'lockdown' ||
    raw.kind === 'enforcement' ||
    raw.kind === 'probation' ||
    raw.kind === 'restore'
      ? raw.kind
      : undefined;
  const meta = (raw.compactionMeta ?? null) as Record<string, unknown> | null;
  const goalMeta = (raw.goalMeta ?? null) as Record<string, unknown> | null;

  return {
    id: asString(raw.id) || `imported_turn_${index}`,
    role: raw.role,
    content,
    reasoning: asString(raw.reasoning) || undefined,
    createdAt: asNumber(raw.createdAt, Date.now()),
    error: asString(raw.error) || undefined,
    finishReason: asString(raw.finishReason) || undefined,
    model: asString(raw.model) || undefined,
    providerId: asString(raw.providerId) || undefined,
    usage: sanitizeUsage(raw.usage),
    attachments,
    segments,
    injections: sanitizeInjections(raw.injections),
    ...(steers ? { steers } : {}),
    ...(kind ? { kind } : {}),
    ...(kind === 'compaction' && meta
      ? {
          compactionMeta: {
            covered: Math.max(0, Math.round(asNumber(meta.covered, 0))),
            replacedTokens: Math.max(0, Math.round(asNumber(meta.replacedTokens, 0))),
            trigger: asString(meta.trigger, 'manual'),
          },
        }
      : {}),
    ...(kind === 'goal-loop' && goalMeta
      ? {
          goalMeta: {
            round: Math.max(0, Math.round(asNumber(goalMeta.round, 0))),
            maxRounds: Math.max(0, Math.round(asNumber(goalMeta.maxRounds, 0))),
            full: asBoolean(goalMeta.full, true),
          },
        }
      : {}),
    ...(kind === 'enforcement' && raw.enforcementMeta
      ? {
          enforcementMeta: {
            level:
              typeof raw.enforcementMeta.level === 'number' && raw.enforcementMeta.level >= 0 && raw.enforcementMeta.level <= 5
                ? (raw.enforcementMeta.level as 0 | 1 | 2 | 3 | 4 | 5)
                : 0,
            mode: raw.enforcementMeta.mode === 'auto' ? 'auto' : 'manual',
            message: asString(raw.enforcementMeta.message),
          },
        }
      : kind === 'lockdown' && raw.lockdownMeta
        ? { kind: 'enforcement', enforcementMeta: { level: 4, mode: 'manual', message: asString(raw.lockdownMeta.message) } }
        : {}),
    // suppressed output so the choice card can preview and gate on it.
    ...(kind === 'probation' && raw.probationMeta
      ? {
          probationMeta: {
            tier: (Math.min(5, Math.max(1, Math.round(asNumber(raw.probationMeta.tier, 1)))) as TrustTier),
            reason: asString(raw.probationMeta.reason),
            auto: asBoolean(raw.probationMeta.auto, false),
          },
        }
      : {}),
    ...(kind === 'probation' && raw.outputFrozenMeta
      ? { outputFrozenMeta: { content: asString(raw.outputFrozenMeta.content) } }
      : {}),
    ...(kind === 'restore' && raw.restoreMeta
      ? {
          restoreMeta: {
            entries: Array.isArray(raw.restoreMeta.entries)
              ? raw.restoreMeta.entries.map((entry: Record<string, unknown>) => ({
                  path: asString(entry.path),
                  snapshotId: asString(entry.snapshotId),
                  label: asString(entry.label),
                  operation: asString(entry.operation),
                  previousEntryId: asString(entry.previousEntryId) || undefined,
                }))
              : [],
            diff: typeof raw.restoreMeta.diff === 'string' ? raw.restoreMeta.diff : undefined,
            diffstat:
              raw.restoreMeta.diffstat && typeof raw.restoreMeta.diffstat === 'object'
                ? {
                    added: Math.max(0, Math.round(asNumber(raw.restoreMeta.diffstat.added, 0))),
                    removed: Math.max(0, Math.round(asNumber(raw.restoreMeta.diffstat.removed, 0))),
                  }
                : undefined,
          },
        }
      : {}),
  };
}

function sanitizeCompaction(value: unknown): ConversationCompaction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ConversationCompaction>;
  const summary = asString(raw.summary);
  if (!summary) return undefined;
  const trigger =
    raw.trigger === 'threshold' || raw.trigger === 'context-limit' || raw.trigger === 'manual'
      ? raw.trigger
      : 'manual';
  return {
    summary,
    coveredTurnIds: Array.isArray(raw.coveredTurnIds)
      ? raw.coveredTurnIds.filter((id): id is string => typeof id === 'string')
      : [],
    trigger,
    createdAt: asNumber(raw.createdAt, Date.now()),
  };
}

function sanitizeGoals(value: unknown): Goal[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Goal[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<Goal>;
    const id = asString(raw.id);
    if (!id || !asString(raw.title)) continue;
    const status: Goal['status'] =
      raw.status === 'running' || raw.status === 'paused' || raw.status === 'done'
        ? raw.status
        : 'paused';
    const todos = (Array.isArray(raw.todos) ? raw.todos : []).flatMap((todo) => {
      if (!todo || typeof todo !== 'object') return [];
      const t = todo as Partial<Goal['todos'][number]>;
      const todoId = asString(t.id);
      if (!todoId || !asString(t.text)) return [];
      const subtasks = (Array.isArray(t.subtasks) ? t.subtasks : []).flatMap((sub) => {
        if (!sub || typeof sub !== 'object') return [];
        const s = sub as Partial<GoalSubtask>;
        const subId = asString(s.id);
        if (!subId || !asString(s.text)) return [];
        return [{ id: subId, text: asString(s.text), done: asBoolean(s.done) }];
      });
      return [
        {
          id: todoId,
          text: asString(t.text),
          done: asBoolean(t.done),
          ...(subtasks.length > 0 ? { subtasks } : {}),
        },
      ];
    });
    const createdAt = asNumber(raw.createdAt, Date.now());
    out.push({
      id,
      title: asString(raw.title),
      plan: asString(raw.plan),
      status,
      todos,
      createdAt,
      updatedAt: asNumber(raw.updatedAt, createdAt),
      loopCount: Math.max(0, Math.round(asNumber(raw.loopCount, 0))),
      ...(raw.maxRounds !== undefined && typeof raw.maxRounds === 'number'
        ? { maxRounds: Math.max(0, Math.round(raw.maxRounds)) }
        : {}),
      ...(raw.injectEveryTodos !== undefined && typeof raw.injectEveryTodos === 'number'
        ? { injectEveryTodos: Math.max(1, Math.round(raw.injectEveryTodos)) }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeHarnessContext(value: unknown): Conversation['harnessContext'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as NonNullable<Conversation['harnessContext']>;
  const injections = sanitizeInjections(raw.injections);
  if (!injections) return undefined;
  return {
    injections,
    model: asString(raw.model),
    flags: asString(raw.flags),
    injectedAt: asNumber(raw.injectedAt, Date.now()),
  };
}

/** Coerces an array of unknown records into valid conversations. */
export function sanitizeConversations(input: unknown[]): Conversation[] {
  const seen = new Set<string>();
  const output: Conversation[] = [];

  input.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const raw = entry as Partial<Conversation>;

    let id = asString(raw.id) || `imported_chat_${index}`;
    while (seen.has(id)) id = `${id}_1`;
    seen.add(id);

    const turns = Array.isArray(raw.turns)
      ? raw.turns.map((turn, turnIndex) => sanitizeTurn(turn, turnIndex)).filter((turn): turn is Turn => turn !== null)
      : [];

    const createdAt = asNumber(raw.createdAt, Date.now());

    output.push({
      id,
      title: asString(raw.title) || 'Imported chat',
      createdAt,
      updatedAt: asNumber(raw.updatedAt, createdAt),
      providerId: asString(raw.providerId),
      model: asString(raw.model),
      settings: sanitizeSettings(raw.settings),
      turns,
      compaction: sanitizeCompaction(raw.compaction),
      goals: sanitizeGoals(raw.goals),
      harnessContext: sanitizeHarnessContext(raw.harnessContext),
      categoryId: asString(raw.categoryId) || undefined,
    });
  });

  return output;
}

/** Coerces one unknown record (a single-conversation export) into a valid Conversation. */
export function sanitizeConversation(input: unknown): Conversation | null {
  if (!input || typeof input !== 'object') return null;
  const [conversation] = sanitizeConversations([input]);
  return conversation ?? null;
}
